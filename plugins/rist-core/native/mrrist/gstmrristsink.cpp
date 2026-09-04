/* mrristsink — bus MPEG-TS → librist sender. Design notes in gstmrrist.cpp. */
#include "mrrist_common.h"
#include <gst/base/gstbasesink.h>
#include <atomic>
#include <cstring>

/* ------------------------------------------------------------------------- */
/* mrristsink                                                                 */
/* ------------------------------------------------------------------------- */

G_DECLARE_FINAL_TYPE(GstMrRistSink, gst_mrristsink, GST, MRRISTSINK, GstBaseSink)

struct _GstMrRistSink {
    GstBaseSink parent;
    MrRistCommon c;
    gboolean npd;
    gint chunk;
    std::atomic<guint64> packets;
};

G_DEFINE_TYPE(GstMrRistSink, gst_mrristsink, GST_TYPE_BASE_SINK)

static GstStaticPadTemplate mrristsink_sink_tmpl = GST_STATIC_PAD_TEMPLATE(
    "sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS(MRRIST_TS_CAPS));

static gboolean gst_mrristsink_start(GstBaseSink *bsink) {
    GstMrRistSink *self = GST_MRRISTSINK(bsink);
    self->packets = 0;
    if (!mrrist_common_open(GST_ELEMENT(self), &self->c, TRUE)) {
        mrrist_common_close(&self->c);
        return FALSE;
    }
    if (self->npd) rist_sender_npd_enable(self->c.ctx);
    if (rist_start(self->c.ctx) != 0) {
        GST_ELEMENT_ERROR(self, RESOURCE, FAILED, ("rist_start failed"), (nullptr));
        mrrist_common_close(&self->c);
        return FALSE;
    }
    return TRUE;
}

static gboolean gst_mrristsink_stop(GstBaseSink *bsink) {
    mrrist_common_close(&GST_MRRISTSINK(bsink)->c);
    return TRUE;
}

static GstFlowReturn gst_mrristsink_render(GstBaseSink *bsink, GstBuffer *buf) {
    GstMrRistSink *self = GST_MRRISTSINK(bsink);
    if (!self->c.ctx) return GST_FLOW_OK;
    GstMapInfo mi;
    if (!gst_buffer_map(buf, &mi, GST_MAP_READ)) return GST_FLOW_OK;
    const gsize chunk = (gsize)MAX(self->chunk, 188);
    for (gsize off = 0; off < mi.size; off += chunk) {
        struct rist_data_block blk;
        memset(&blk, 0, sizeof(blk));
        blk.payload = mi.data + off;
        blk.payload_len = MIN(chunk, mi.size - off);
        /* librist copies the payload into its own queue during the call;
         * ts_ntp/seq are lib-populated (0 = now). A negative return is a
         * transient send-side condition (queue full, no peers yet) — recovery
         * is librist's job, the bus must never back up on it. */
        if (rist_sender_data_write(self->c.ctx, &blk) < 0) {
            GST_DEBUG_OBJECT(self, "rist_sender_data_write dropped %" G_GSIZE_FORMAT " bytes", blk.payload_len);
        } else {
            self->packets.fetch_add(1, std::memory_order_relaxed);
        }
    }
    gst_buffer_unmap(buf, &mi);
    return GST_FLOW_OK;
}

static void gst_mrristsink_set_property(GObject *o, guint id, const GValue *v, GParamSpec *ps) {
    GstMrRistSink *self = GST_MRRISTSINK(o);
    if (mrrist_common_set_prop(&self->c, id, v)) return;
    switch (id) {
    case PROP_NPD: self->npd = g_value_get_boolean(v); break;
    case PROP_CHUNK: self->chunk = g_value_get_int(v); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(o, id, ps); break;
    }
}

static void gst_mrristsink_get_property(GObject *o, guint id, GValue *v, GParamSpec *ps) {
    GstMrRistSink *self = GST_MRRISTSINK(o);
    if (mrrist_common_get_prop(&self->c, id, v)) return;
    switch (id) {
    case PROP_PACKETS: g_value_set_uint64(v, self->packets.load(std::memory_order_relaxed)); break;
    case PROP_NPD: g_value_set_boolean(v, self->npd); break;
    case PROP_CHUNK: g_value_set_int(v, self->chunk); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(o, id, ps); break;
    }
}

static void gst_mrristsink_finalize(GObject *o) {
    GstMrRistSink *self = GST_MRRISTSINK(o);
    mrrist_common_close(&self->c);
    mrrist_common_clear(&self->c);
    G_OBJECT_CLASS(gst_mrristsink_parent_class)->finalize(o);
}

static void gst_mrristsink_init(GstMrRistSink *self) {
    mrrist_common_init(&self->c);
    self->npd = FALSE;
    self->chunk = MRRIST_DEFAULT_CHUNK;
    self->packets = 0;
    /* Unsynced, like the appsink it replaces: RIST paces on the wire, the bus
     * buffer's PTS is a house-clock stamp for consumers, not a render time. */
    gst_base_sink_set_sync(GST_BASE_SINK(self), FALSE);
}

static void gst_mrristsink_class_init(GstMrRistSinkClass *klass) {
    GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass *element_class = GST_ELEMENT_CLASS(klass);
    GstBaseSinkClass *sink_class = GST_BASE_SINK_CLASS(klass);

    gobject_class->set_property = gst_mrristsink_set_property;
    gobject_class->get_property = gst_mrristsink_get_property;
    gobject_class->finalize = gst_mrristsink_finalize;
    mrrist_common_install_props(gobject_class);
    auto rw = (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS);
    g_object_class_install_property(gobject_class, PROP_NPD, g_param_spec_boolean("npd", "NPD",
        "NULL packet deletion (receiver must support it)", FALSE, rw));
    g_object_class_install_property(gobject_class, PROP_CHUNK, g_param_spec_int("chunk", "Chunk",
        "Bytes per RIST payload; bus buffers are re-sliced to this (188-aligned)", 188, 9400, MRRIST_DEFAULT_CHUNK, rw));

    gst_element_class_add_static_pad_template(element_class, &mrristsink_sink_tmpl);
    gst_element_class_set_static_metadata(element_class, "Media Router RIST sink", "Sink/Network",
        "Sends bus MPEG-TS over RIST via librist (main/advanced profile, encryption, bonding)",
        "Media Router <https://github.com/bccsa/media-router>");

    sink_class->start = gst_mrristsink_start;
    sink_class->stop = gst_mrristsink_stop;
    sink_class->render = gst_mrristsink_render;
}
