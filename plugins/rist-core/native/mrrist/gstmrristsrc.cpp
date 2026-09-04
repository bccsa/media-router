/* mrristsrc — librist receiver → bus MPEG-TS. Design notes in gstmrrist.cpp. */
#include "mrrist_common.h"
#include <gst/base/gstbasesrc.h>
#include <atomic>
#include <vector>
#include <cstring>

/* ------------------------------------------------------------------------- */
/* mrristsrc                                                                  */
/* ------------------------------------------------------------------------- */

G_DECLARE_FINAL_TYPE(GstMrRistSrc, gst_mrristsrc, GST, MRRISTSRC, GstBaseSrc)

struct _GstMrRistSrc {
    GstBaseSrc parent;
    MrRistCommon c;
    gint fifo_size;
    gint read_batch;
    gint read_timeout_ms;
    std::atomic<int> flushing;
    std::atomic<guint64> packets;
    gboolean read_err_warned;
};

G_DEFINE_TYPE(GstMrRistSrc, gst_mrristsrc, GST_TYPE_BASE_SRC)

static GstStaticPadTemplate mrristsrc_src_tmpl = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS(MRRIST_TS_CAPS));

static gboolean gst_mrristsrc_start(GstBaseSrc *bsrc) {
    GstMrRistSrc *self = GST_MRRISTSRC(bsrc);
    self->packets = 0;
    self->flushing = 0;
    self->read_err_warned = FALSE;
    if (!mrrist_common_open(GST_ELEMENT(self), &self->c, FALSE)) {
        mrrist_common_close(&self->c);
        return FALSE;
    }
    if (self->fifo_size > 0) {
        /* Power-of-2 packet count, sized before start: absorption if the
         * downstream push stalls (2048 x ~1316 B ≈ 1 s at 20 Mbit/s). */
        rist_receiver_set_output_fifo_size(self->c.ctx, (uint32_t)self->fifo_size);
    }
    if (rist_start(self->c.ctx) != 0) {
        GST_ELEMENT_ERROR(self, RESOURCE, FAILED, ("rist_start failed"), (nullptr));
        mrrist_common_close(&self->c);
        return FALSE;
    }
    return TRUE;
}

static gboolean gst_mrristsrc_stop(GstBaseSrc *bsrc) {
    mrrist_common_close(&GST_MRRISTSRC(bsrc)->c);
    return TRUE;
}

static gboolean gst_mrristsrc_unlock(GstBaseSrc *bsrc) {
    GST_MRRISTSRC(bsrc)->flushing = 1;   /* create() returns within read-timeout */
    return TRUE;
}

static gboolean gst_mrristsrc_unlock_stop(GstBaseSrc *bsrc) {
    GST_MRRISTSRC(bsrc)->flushing = 0;
    return TRUE;
}

static GstFlowReturn gst_mrristsrc_create(GstBaseSrc *bsrc, guint64, guint, GstBuffer **out) {
    GstMrRistSrc *self = GST_MRRISTSRC(bsrc);
    std::vector<struct rist_data_block *> blocks;
    while (blocks.empty()) {
        if (self->flushing.load(std::memory_order_relaxed)) return GST_FLOW_FLUSHING;
        struct rist_data_block *b = nullptr;
        int r = rist_receiver_data_read2(self->c.ctx, &b, MAX(self->read_timeout_ms, 1));
        if (r < 0) {
            /* Transient: librist deletes/recreates the flow around a link
             * blackout and keeps receiving into its fifo. Warn once per burst
             * and keep reading — exiting here wedged the relay in the field. */
            if (!self->read_err_warned) {
                self->read_err_warned = TRUE;
                GST_ELEMENT_WARNING(self, RESOURCE, READ, ("librist read failed (%d), retrying", r), (nullptr));
            }
            g_usleep(100 * 1000);
            continue;
        }
        self->read_err_warned = FALSE;
        if (r == 0 || !b) continue;              /* timeout: loop to re-check flushing */
        if (!b->payload || b->payload_len == 0) { rist_receiver_data_block_free2(&b); continue; }
        blocks.push_back(b);
        /* Drain what librist has ALREADY released (timeout 0 never waits). */
        while ((gint)blocks.size() < MAX(self->read_batch, 1)) {
            struct rist_data_block *more = nullptr;
            int rr = rist_receiver_data_read2(self->c.ctx, &more, 0);
            if (rr <= 0 || !more) break;
            if (!more->payload || more->payload_len == 0) { rist_receiver_data_block_free2(&more); continue; }
            blocks.push_back(more);
        }
    }
    gsize total = 0;
    gboolean discont = FALSE;
    for (auto *b : blocks) {
        total += b->payload_len;
        if (b->flags & RIST_DATA_FLAGS_DISCONTINUITY) discont = TRUE;
    }
    GstBuffer *buf = gst_buffer_new_allocate(nullptr, total, nullptr);
    GstMapInfo mi;
    if (!buf || !gst_buffer_map(buf, &mi, GST_MAP_WRITE)) {
        for (auto *b : blocks) rist_receiver_data_block_free2(&b);
        if (buf) gst_buffer_unref(buf);
        return GST_FLOW_ERROR;
    }
    gsize off = 0;
    for (auto *b : blocks) {
        memcpy(mi.data + off, b->payload, b->payload_len);
        off += b->payload_len;
        rist_receiver_data_block_free2(&b);
    }
    gst_buffer_unmap(buf, &mi);
    if (discont) GST_BUFFER_FLAG_SET(buf, GST_BUFFER_FLAG_DISCONT);
    self->packets.fetch_add(blocks.size(), std::memory_order_relaxed);
    /* PTS/DTS: basesrc stamps arrival (do-timestamp, on by default here). */
    *out = buf;
    return GST_FLOW_OK;
}

static void gst_mrristsrc_set_property(GObject *o, guint id, const GValue *v, GParamSpec *ps) {
    GstMrRistSrc *self = GST_MRRISTSRC(o);
    if (mrrist_common_set_prop(&self->c, id, v)) return;
    switch (id) {
    case PROP_FIFO_SIZE: self->fifo_size = g_value_get_int(v); break;
    case PROP_READ_BATCH: self->read_batch = g_value_get_int(v); break;
    case PROP_READ_TIMEOUT: self->read_timeout_ms = g_value_get_int(v); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(o, id, ps); break;
    }
}

static void gst_mrristsrc_get_property(GObject *o, guint id, GValue *v, GParamSpec *ps) {
    GstMrRistSrc *self = GST_MRRISTSRC(o);
    if (mrrist_common_get_prop(&self->c, id, v)) return;
    switch (id) {
    case PROP_PACKETS: g_value_set_uint64(v, self->packets.load(std::memory_order_relaxed)); break;
    case PROP_FIFO_SIZE: g_value_set_int(v, self->fifo_size); break;
    case PROP_READ_BATCH: g_value_set_int(v, self->read_batch); break;
    case PROP_READ_TIMEOUT: g_value_set_int(v, self->read_timeout_ms); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(o, id, ps); break;
    }
}

static void gst_mrristsrc_finalize(GObject *o) {
    GstMrRistSrc *self = GST_MRRISTSRC(o);
    mrrist_common_close(&self->c);
    mrrist_common_clear(&self->c);
    G_OBJECT_CLASS(gst_mrristsrc_parent_class)->finalize(o);
}

static void gst_mrristsrc_init(GstMrRistSrc *self) {
    mrrist_common_init(&self->c);
    self->fifo_size = 2048;
    self->read_batch = 32;
    self->read_timeout_ms = 100;
    self->flushing = 0;
    self->packets = 0;
    self->read_err_warned = FALSE;
    /* Live, TIME format, arrival-timestamped — what the appsrc it replaces
     * was configured to (is-live=true do-timestamp=true format=time). */
    gst_base_src_set_live(GST_BASE_SRC(self), TRUE);
    gst_base_src_set_format(GST_BASE_SRC(self), GST_FORMAT_TIME);
    gst_base_src_set_do_timestamp(GST_BASE_SRC(self), TRUE);
}

static void gst_mrristsrc_class_init(GstMrRistSrcClass *klass) {
    GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass *element_class = GST_ELEMENT_CLASS(klass);
    GstBaseSrcClass *src_class = GST_BASE_SRC_CLASS(klass);

    gobject_class->set_property = gst_mrristsrc_set_property;
    gobject_class->get_property = gst_mrristsrc_get_property;
    gobject_class->finalize = gst_mrristsrc_finalize;
    mrrist_common_install_props(gobject_class);
    auto rw = (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS);
    g_object_class_install_property(gobject_class, PROP_FIFO_SIZE, g_param_spec_int("fifo-size", "FIFO size",
        "librist output fifo depth in packets (power of 2; 0 = librist default)", 0, 65536, 2048, rw));
    g_object_class_install_property(gobject_class, PROP_READ_BATCH, g_param_spec_int("read-batch", "Read batch",
        "Max already-released packets folded into one buffer per create()", 1, 1024, 32, rw));
    g_object_class_install_property(gobject_class, PROP_READ_TIMEOUT, g_param_spec_int("read-timeout", "Read timeout",
        "Blocking read timeout in ms (bounds unlock latency)", 1, 5000, 100, rw));

    gst_element_class_add_static_pad_template(element_class, &mrristsrc_src_tmpl);
    gst_element_class_set_static_metadata(element_class, "Media Router RIST source", "Source/Network",
        "Receives RIST via librist (main/advanced profile, encryption, bonding) as bus MPEG-TS",
        "Media Router <https://github.com/bccsa/media-router>");

    src_class->start = gst_mrristsrc_start;
    src_class->stop = gst_mrristsrc_stop;
    src_class->unlock = gst_mrristsrc_unlock;
    src_class->unlock_stop = gst_mrristsrc_unlock_stop;
    src_class->create = gst_mrristsrc_create;
}
