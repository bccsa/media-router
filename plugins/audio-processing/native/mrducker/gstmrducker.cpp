/* mrducker (plan ch. 6 part 4.5, WI-P2-10): the sidechain ducker in the pipeline. 4 channels
 * of F32 in, the programme on 0/1 and the key on 2/3 (one PTS-aligned interleave), the ducked
 * programme out. Each 15 ms of content advances the envelope (ducker_envelope.h); PTS in = PTS
 * out. An `mrducker` message every 100 ms of content: gain-db, key-db, phase. */
#include <gst/base/gstbasetransform.h>
#include <gst/gst.h>

#include <atomic>
#include <vector>

#include "ducker_envelope.h"
#include "mrducker_abi.h"

#if G_BYTE_ORDER != G_LITTLE_ENDIAN
#error "mrducker reads and writes F32LE as native floats"
#endif

/* GST_PLUGIN_DEFINE reads PACKAGE for GstPluginDesc.source. */
#define PACKAGE "media-router"

/* The keyed gate's PTS keeper, the plugin's other element (gstmrptskeep.cpp). */
GType gst_mrptskeep_get_type(void);

GST_DEBUG_CATEGORY_STATIC(mrducker_debug);
#define GST_CAT_DEFAULT mrducker_debug

using mrducker::DuckerCore;
using mrducker::DuckerParams;

enum { PROP_0, PROP_THRESHOLD, PROP_DEPTH, PROP_ATTACK, PROP_RELEASE, PROP_HOLD, PROP_ABI };

#define GST_TYPE_MRDUCKER (gst_mrducker_get_type())
G_DECLARE_FINAL_TYPE(GstMrDucker, gst_mrducker, GST, MRDUCKER, GstBaseTransform)

struct _GstMrDucker {
    GstBaseTransform parent;

    /* Live properties: written from any thread, read once per buffer. */
    std::atomic<double> threshold, depth, attack, release, hold;

    /* Streaming thread only (transform and serialized events share the stream lock). */
    DuckerCore* core;
    std::vector<DuckerCore::Reading>* readings;
    gint64 end_rt;   // running time where the last buffer ended; -1: none
};

G_DEFINE_TYPE(GstMrDucker, gst_mrducker, GST_TYPE_BASE_TRANSFORM)

static GstStaticPadTemplate dk_sink_tmpl = GST_STATIC_PAD_TEMPLATE(
    "sink", GST_PAD_SINK, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("audio/x-raw, format=(string)F32LE, rate=(int)[1, MAX], channels=(int)4, "
                    "layout=(string)interleaved"));
static GstStaticPadTemplate dk_src_tmpl = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("audio/x-raw, format=(string)F32LE, rate=(int)[1, MAX], channels=(int)2, "
                    "layout=(string)interleaved, channel-mask=(bitmask)0x3"));

static DuckerParams dk_params(GstMrDucker* self) {
    DuckerParams p;
    p.threshold_db = self->threshold.load(std::memory_order_relaxed);
    p.depth_db = self->depth.load(std::memory_order_relaxed);
    p.attack_ms = self->attack.load(std::memory_order_relaxed);
    p.release_ms = self->release.load(std::memory_order_relaxed);
    p.hold_ms = self->hold.load(std::memory_order_relaxed);
    return p;
}

static void dk_post(GstMrDucker* self, const DuckerCore::Reading& r, gint64 rt) {
    GstStructure* s = gst_structure_new(
        "mrducker", "running-time", G_TYPE_INT64, rt, "gain-db", G_TYPE_DOUBLE, r.gain_db,
        "key-db", G_TYPE_DOUBLE, r.key_db, "phase", G_TYPE_STRING,
        mrducker::phase_name(r.phase), NULL);
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
}

/* --- GstBaseTransform ------------------------------------------------------------------- */

/* Channels are what this element changes: 4 in, 2 positioned out; rate and format stay. */
static GstCaps* dk_transform_caps(GstBaseTransform*, GstPadDirection dir, GstCaps* caps,
                                  GstCaps* filter) {
    GstCaps* res = gst_caps_new_empty();
    for (guint i = 0; i < gst_caps_get_size(caps); i++) {
        GstStructure* s = gst_structure_copy(gst_caps_get_structure(caps, i));
        if (dir == GST_PAD_SINK) {
            gst_structure_set(s, "channels", G_TYPE_INT, 2, "channel-mask", GST_TYPE_BITMASK,
                              (guint64)0x3, NULL);
        } else {
            gst_structure_set(s, "channels", G_TYPE_INT, 4, NULL);
            gst_structure_remove_field(s, "channel-mask");
        }
        res = gst_caps_merge_structure(res, s);
    }
    if (filter) {
        GstCaps* t = gst_caps_intersect_full(filter, res, GST_CAPS_INTERSECT_FIRST);
        gst_caps_unref(res);
        res = t;
    }
    return res;
}

static gboolean dk_get_unit_size(GstBaseTransform*, GstCaps* caps, gsize* size) {
    gint channels = 0;
    const GstStructure* s = gst_caps_get_structure(caps, 0);
    if (!s || !gst_structure_get_int(s, "channels", &channels) || channels <= 0) return FALSE;
    *size = (gsize)channels * sizeof(float);
    return TRUE;
}

static gboolean dk_set_caps(GstBaseTransform* trans, GstCaps* incaps, GstCaps*) {
    GstMrDucker* self = GST_MRDUCKER(trans);
    gint rate = 0;
    if (!gst_structure_get_int(gst_caps_get_structure(incaps, 0), "rate", &rate) || rate <= 0)
        return FALSE;
    /* A renegotiation at the same rate keeps the envelope; a new rate is a new stream. */
    if (rate != self->core->rate()) self->core->set_rate(rate);
    return TRUE;
}

static gboolean dk_start(GstBaseTransform* trans) {
    GstMrDucker* self = GST_MRDUCKER(trans);
    self->core->reset();
    self->end_rt = -1;
    return TRUE;
}

static gboolean dk_sink_event(GstBaseTransform* trans, GstEvent* event) {
    GstMrDucker* self = GST_MRDUCKER(trans);
    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_EOS: {
            /* The last partial window counts too. */
            DuckerCore::Reading r;
            if (self->core->finish(dk_params(self), &r) && r.report)
                dk_post(self, r, self->end_rt);
            break;
        }
        case GST_EVENT_FLUSH_STOP:
            self->core->reset();
            self->end_rt = -1;
            break;
        default: break;
    }
    return GST_BASE_TRANSFORM_CLASS(gst_mrducker_parent_class)->sink_event(trans, event);
}

static GstFlowReturn dk_transform(GstBaseTransform* trans, GstBuffer* in, GstBuffer* out) {
    GstMrDucker* self = GST_MRDUCKER(trans);
    GstMapInfo mi, mo;
    if (!gst_buffer_map(in, &mi, GST_MAP_READ)) return GST_FLOW_ERROR;
    if (!gst_buffer_map(out, &mo, GST_MAP_WRITE)) {
        gst_buffer_unmap(in, &mi);
        return GST_FLOW_ERROR;
    }
    const size_t frames = MIN(mi.size / (4 * sizeof(float)), mo.size / (2 * sizeof(float)));
    /* A gap's bytes are not read: it is silence, in and out. */
    const bool gap = GST_BUFFER_FLAG_IS_SET(in, GST_BUFFER_FLAG_GAP);
    self->readings->clear();
    self->core->process((const float*)mi.data, (float*)mo.data, frames, gap, dk_params(self),
                        self->readings);
    gst_buffer_unmap(out, &mo);
    gst_buffer_unmap(in, &mi);
    if (gap) GST_BUFFER_FLAG_SET(out, GST_BUFFER_FLAG_GAP);
    else GST_BUFFER_FLAG_UNSET(out, GST_BUFFER_FLAG_GAP);

    /* A reading's message carries the running time where its window ended. */
    gint64 rt = -1;
    const GstSegment* seg = &trans->segment;
    if (GST_BUFFER_PTS_IS_VALID(in) && seg->format == GST_FORMAT_TIME) {
        const GstClockTime t =
            gst_segment_to_running_time(seg, GST_FORMAT_TIME, GST_BUFFER_PTS(in));
        if (GST_CLOCK_TIME_IS_VALID(t)) rt = (gint64)t;
    }
    const int rate = self->core->rate();
    auto at = [&](size_t n) {
        return rt < 0 ? -1 : rt + (gint64)gst_util_uint64_scale_int(n, GST_SECOND, rate);
    };
    for (const DuckerCore::Reading& r : *self->readings)
        if (r.report) dk_post(self, r, at(r.at));
    self->end_rt = at(frames);
    return GST_FLOW_OK;
}

/* --- GObject ---------------------------------------------------------------------------- */

static void dk_set_property(GObject* object, guint prop_id, const GValue* value,
                            GParamSpec* pspec) {
    GstMrDucker* self = GST_MRDUCKER(object);
    std::atomic<double>* field = nullptr;
    switch (prop_id) {
        case PROP_THRESHOLD: field = &self->threshold; break;
        case PROP_DEPTH: field = &self->depth; break;
        case PROP_ATTACK: field = &self->attack; break;
        case PROP_RELEASE: field = &self->release; break;
        case PROP_HOLD: field = &self->hold; break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec); return;
    }
    field->store(g_value_get_double(value), std::memory_order_relaxed);
}

static void dk_get_property(GObject* object, guint prop_id, GValue* value, GParamSpec* pspec) {
    GstMrDucker* self = GST_MRDUCKER(object);
    switch (prop_id) {
        case PROP_THRESHOLD: g_value_set_double(value, self->threshold.load()); break;
        case PROP_DEPTH: g_value_set_double(value, self->depth.load()); break;
        case PROP_ATTACK: g_value_set_double(value, self->attack.load()); break;
        case PROP_RELEASE: g_value_set_double(value, self->release.load()); break;
        case PROP_HOLD: g_value_set_double(value, self->hold.load()); break;
        case PROP_ABI: g_value_set_int(value, MRDUCKER_ABI); break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec); break;
    }
}

static void dk_finalize(GObject* object) {
    GstMrDucker* self = GST_MRDUCKER(object);
    delete self->core;
    delete self->readings;
    G_OBJECT_CLASS(gst_mrducker_parent_class)->finalize(object);
}

static void gst_mrducker_init(GstMrDucker* self) {
    const DuckerParams p;
    self->threshold.store(p.threshold_db);
    self->depth.store(p.depth_db);
    self->attack.store(p.attack_ms);
    self->release.store(p.release_ms);
    self->hold.store(p.hold_ms);
    self->core = new DuckerCore();
    self->readings = new std::vector<DuckerCore::Reading>();
    self->end_rt = -1;
}

/* Ranges and help text are the module's duck settings' (plugins/audio-processing/package.json:
 * threshold, duckDepth, attack, release, hold); mrducker_element_test.py holds them equal. */
static void gst_mrducker_class_init(GstMrDuckerClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);
    GstBaseTransformClass* trans_class = GST_BASE_TRANSFORM_CLASS(klass);

    gobject_class->set_property = dk_set_property;
    gobject_class->get_property = dk_get_property;
    gobject_class->finalize = dk_finalize;

    const DuckerParams p;
    const GParamFlags live =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_PLAYING);
    g_object_class_install_property(
        gobject_class, PROP_THRESHOLD,
        g_param_spec_double("threshold", "Threshold (dB)",
                            "Key level where the dynamics stage engages", -60, 0,
                            p.threshold_db, live));
    g_object_class_install_property(
        gobject_class, PROP_DEPTH,
        g_param_spec_double("depth", "Depth (dB)",
                            "Level the program drops to while the sidechain is active", -40, 0,
                            p.depth_db, live));
    g_object_class_install_property(
        gobject_class, PROP_ATTACK,
        g_param_spec_double("attack", "Attack (ms)", "Attack time", 0, 500, p.attack_ms, live));
    g_object_class_install_property(
        gobject_class, PROP_RELEASE,
        g_param_spec_double("release", "Release (ms)", "Release time", 5, 2000, p.release_ms,
                            live));
    g_object_class_install_property(
        gobject_class, PROP_HOLD,
        g_param_spec_double("hold", "Hold (ms)",
                            "Time to stay ducked after the sidechain goes quiet", 0, 2000,
                            p.hold_ms, live));
    g_object_class_install_property(
        gobject_class, PROP_ABI,
        g_param_spec_int("abi", "ABI",
                         "Element protocol version of this plugin (MRDUCKER_ABI); a runner "
                         "refuses a plugin below its own minimum.",
                         0, G_MAXINT, MRDUCKER_ABI,
                         (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));

    trans_class->transform_caps = GST_DEBUG_FUNCPTR(dk_transform_caps);
    trans_class->get_unit_size = GST_DEBUG_FUNCPTR(dk_get_unit_size);
    trans_class->set_caps = GST_DEBUG_FUNCPTR(dk_set_caps);
    trans_class->start = GST_DEBUG_FUNCPTR(dk_start);
    trans_class->sink_event = GST_DEBUG_FUNCPTR(dk_sink_event);
    trans_class->transform = GST_DEBUG_FUNCPTR(dk_transform);

    gst_element_class_add_static_pad_template(element_class, &dk_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &dk_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router ducker", "Filter/Effect/Audio",
        "Ducks the programme (channels 0/1) by the key (channels 2/3) of one PTS-aligned "
        "interleave, on content time; 4 channels in, 2 out",
        "Media Router <https://github.com/bccsa/media-router>");
}

static gboolean plugin_init(GstPlugin* plugin) {
    GST_DEBUG_CATEGORY_INIT(mrducker_debug, "mrducker", 0, "Media Router ducker");
    /* Rank NONE: placed by name in pipeline strings, never auto-plugged. */
    return gst_element_register(plugin, "mrducker", GST_RANK_NONE, GST_TYPE_MRDUCKER) &&
           gst_element_register(plugin, "mrptskeep", GST_RANK_NONE, gst_mrptskeep_get_type());
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrducker,
                  "Media Router audio processing: the ducker and the keyed gate's PTS keeper",
                  plugin_init, MRDUCKER_VERSION, "MIT/X11", "media-router",
                  "https://github.com/bccsa/media-router")
