/* mrpeshouse — the subtitle bridge's per-packet walk as a GStreamer element.
 *
 * Passthrough GstBaseTransform spliced in front of a tsdemux by the subtitle
 * bridge (plugins/subtitle-core/py/subtitle_native.py). Every buffer's PTS is a
 * bus chunk stamp; the walk (pes_walk.cpp) assembles the private_stream_1 PES
 * and maps each onto the house timeline with the floor model (stamp_model.cpp),
 * both ports of the python spec (subtitle_ts.py, subtitle_stamp_model.py). Per
 * completed PES it emits `pes-house` from the streaming thread, BEFORE the
 * buffer reaches the demux, so the bridge's payload-hash join sees it first.
 * Buffers are never modified. ADR-0016 amendment 2026-10-09.
 */
#include <gst/gst.h>
#include <gst/base/gstbasetransform.h>

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <string>

#include "pes_walk.h"

#define PACKAGE "media-router"
#define MRPESHOUSE_VERSION "1.0.0"

GST_DEBUG_CATEGORY_STATIC(mrpeshouse_debug);
#define GST_CAT_DEFAULT mrpeshouse_debug

struct GstMrPesHouse {
    GstBaseTransform parent;
    GMutex lock;                        /* walker + pids (pids set from pad-added) */
    mrpeshouse::PesWalker *walker;
    gchar *pids;
    std::atomic<guint64> hits, misses;
};
struct GstMrPesHouseClass {
    GstBaseTransformClass parent_class;
};

#define GST_TYPE_MRPESHOUSE (gst_mrpeshouse_get_type())
#define GST_MRPESHOUSE(obj) (G_TYPE_CHECK_INSTANCE_CAST((obj), GST_TYPE_MRPESHOUSE, GstMrPesHouse))
G_DEFINE_TYPE(GstMrPesHouse, gst_mrpeshouse, GST_TYPE_BASE_TRANSFORM)

enum { PROP_0, PROP_PIDS, PROP_HITS, PROP_MISSES, PROP_RESYNCS };
enum { SIGNAL_PES_HOUSE, N_SIGNALS };
static guint signals[N_SIGNALS];

static GstStaticPadTemplate sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);
static GstStaticPadTemplate src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

/* "0x120,0x121" or decimals → the PID filter; empty / NULL = every 0xBD PID. */
static std::optional<std::set<int>> parse_pids(const gchar *s) {
    if (s == NULL || *s == '\0') return std::nullopt;
    std::set<int> out;
    gchar **parts = g_strsplit(s, ",", -1);
    for (gchar **p = parts; *p != NULL; p++) {
        gchar *t = g_strstrip(*p);
        if (*t != '\0') out.insert((int)strtol(t, NULL, 0));
    }
    g_strfreev(parts);
    return out;
}

static void reset(GstMrPesHouse *self) {
    g_mutex_lock(&self->lock);
    delete self->walker;
    self->walker = new mrpeshouse::PesWalker();
    self->walker->set_pids(parse_pids(self->pids));
    g_mutex_unlock(&self->lock);
}

static GstFlowReturn gst_mrpeshouse_transform_ip(GstBaseTransform *base, GstBuffer *buf) {
    GstMrPesHouse *self = GST_MRPESHOUSE(base);
    std::optional<double> chunk_ms;
    if (GST_BUFFER_PTS_IS_VALID(buf)) chunk_ms = (double)GST_BUFFER_PTS(buf) / 1e6;
    GstMapInfo map;
    if (!gst_buffer_map(buf, &map, GST_MAP_READ)) return GST_FLOW_OK;
    g_mutex_lock(&self->lock);
    std::vector<mrpeshouse::DonePes> done = self->walker->feed(map.data, map.size, chunk_ms);
    g_mutex_unlock(&self->lock);
    gst_buffer_unmap(buf, &map);
    /* Emitted outside the lock: handlers run python and may set `pids`. */
    for (const mrpeshouse::DonePes &d : done) {
        gchar *sha = g_compute_checksum_for_data(G_CHECKSUM_SHA1, d.payload.data(), d.payload.size());
        gint64 house_ns = d.house_ms ? (gint64)std::llround(*d.house_ms * 1e6) : -1;
        (d.house_ms ? self->hits : self->misses).fetch_add(1, std::memory_order_relaxed);
        g_signal_emit(self, signals[SIGNAL_PES_HOUSE], 0, (guint)d.pid, (gint64)d.pts, sha, house_ns);
        g_free(sha);
    }
    return GST_FLOW_OK;
}

/* Lists go member by member through our own chain, each member one chunk —
 * exactly what the core's default chain_list does, stated here on purpose. */
static GstFlowReturn gst_mrpeshouse_chain_list(GstPad *pad, GstObject *, GstBufferList *list) {
    GstFlowReturn ret = GST_FLOW_OK;
    guint n = gst_buffer_list_length(list);
    for (guint i = 0; i < n && ret == GST_FLOW_OK; i++)
        ret = gst_pad_chain(pad, gst_buffer_ref(gst_buffer_list_get(list, i)));
    gst_buffer_list_unref(list);
    return ret;
}

static gboolean gst_mrpeshouse_stop(GstBaseTransform *base) {
    reset(GST_MRPESHOUSE(base));        /* a restart re-learns K, like a fresh install */
    return TRUE;
}

static void gst_mrpeshouse_set_property(GObject *object, guint prop_id, const GValue *value,
                                        GParamSpec *pspec) {
    GstMrPesHouse *self = GST_MRPESHOUSE(object);
    if (prop_id != PROP_PIDS) {
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
        return;
    }
    g_mutex_lock(&self->lock);
    g_free(self->pids);
    self->pids = g_value_dup_string(value);
    self->walker->set_pids(parse_pids(self->pids));
    g_mutex_unlock(&self->lock);
}

static void gst_mrpeshouse_get_property(GObject *object, guint prop_id, GValue *value,
                                        GParamSpec *pspec) {
    GstMrPesHouse *self = GST_MRPESHOUSE(object);
    switch (prop_id) {
        case PROP_PIDS:
            g_mutex_lock(&self->lock);
            g_value_set_string(value, self->pids);
            g_mutex_unlock(&self->lock);
            break;
        case PROP_HITS: g_value_set_uint64(value, self->hits.load()); break;
        case PROP_MISSES: g_value_set_uint64(value, self->misses.load()); break;
        case PROP_RESYNCS:
            g_mutex_lock(&self->lock);
            g_value_set_uint64(value, self->walker->model().resyncs());
            g_mutex_unlock(&self->lock);
            break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
    }
}

static void gst_mrpeshouse_finalize(GObject *object) {
    GstMrPesHouse *self = GST_MRPESHOUSE(object);
    delete self->walker;
    g_free(self->pids);
    g_mutex_clear(&self->lock);
    G_OBJECT_CLASS(gst_mrpeshouse_parent_class)->finalize(object);
}

static void gst_mrpeshouse_init(GstMrPesHouse *self) {
    g_mutex_init(&self->lock);
    self->pids = NULL;
    self->walker = new mrpeshouse::PesWalker();
    self->hits.store(0);
    self->misses.store(0);
    gst_base_transform_set_in_place(GST_BASE_TRANSFORM(self), TRUE);
    gst_base_transform_set_passthrough(GST_BASE_TRANSFORM(self), TRUE);
    gst_pad_set_chain_list_function(GST_BASE_TRANSFORM(self)->sinkpad, gst_mrpeshouse_chain_list);
}

static GParamSpec *counter(const char *name, const char *blurb) {
    return g_param_spec_uint64(name, name, blurb, 0, G_MAXUINT64, 0,
                               (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS));
}

static void gst_mrpeshouse_class_init(GstMrPesHouseClass *klass) {
    GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass *element_class = GST_ELEMENT_CLASS(klass);
    GstBaseTransformClass *base_class = GST_BASE_TRANSFORM_CLASS(klass);
    gobject_class->set_property = gst_mrpeshouse_set_property;
    gobject_class->get_property = gst_mrpeshouse_get_property;
    gobject_class->finalize = gst_mrpeshouse_finalize;

    g_object_class_install_property(gobject_class, PROP_PIDS,
        g_param_spec_string("pids", "PIDs",
                            "Comma-separated private PIDs to assemble (0x.. or decimal); "
                            "empty = every private_stream_1 PID",
                            NULL,
                            (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS
                                          | GST_PARAM_MUTABLE_PLAYING)));
    g_object_class_install_property(gobject_class, PROP_HITS,
        counter("hits", "Private PES emitted with a house time"));
    g_object_class_install_property(gobject_class, PROP_MISSES,
        counter("misses", "Private PES emitted with no house time (house-ns -1)"));
    g_object_class_install_property(gobject_class, PROP_RESYNCS,
        counter("resyncs", "Times the mapping K was dropped (restart or re-anchor)"));

    /* pes-house(pid, pts90k (-1 = none), sha1 hex of the payload, house ns (-1 = unknown)) */
    signals[SIGNAL_PES_HOUSE] = g_signal_new(
        "pes-house", G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
        G_TYPE_NONE, 4, G_TYPE_UINT, G_TYPE_INT64, G_TYPE_STRING, G_TYPE_INT64);

    gst_element_class_add_static_pad_template(element_class, &sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router private PES house time", "Filter/Network",
        "Maps each private PES of a bus TS onto the house timeline (ADR-0016)",
        "Media Router <https://github.com/bccsa/media-router>");
    base_class->transform_ip = gst_mrpeshouse_transform_ip;
    base_class->transform_ip_on_passthrough = TRUE;
    base_class->stop = gst_mrpeshouse_stop;
}

static gboolean plugin_init(GstPlugin *plugin) {
    GST_DEBUG_CATEGORY_INIT(mrpeshouse_debug, "mrpeshouse", 0, "Media Router private PES house time");
    /* Rank NONE: the bridge loads this plugin by path and splices it by name. */
    return gst_element_register(plugin, "mrpeshouse", GST_RANK_NONE, GST_TYPE_MRPESHOUSE);
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrpeshouse,
                  "Media Router private PES house-time walk (subtitle bridge)",
                  plugin_init, MRPESHOUSE_VERSION, "MIT/X11", "media-router",
                  "https://github.com/bccsa/media-router")
