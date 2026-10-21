/* mrptskeep (plan ch. 6 WI-P2-10): GStreamer's LADSPA wrapper gives a filter with more inputs
 * than outputs (sc-gate-stereo, 4 -> 2) a bare output buffer, so the keyed gate has no PTS out.
 * Right after it, this records each buffer at `target`'s sink pad and puts its timing back. */
#include <gst/audio/audio.h>
#include <gst/base/gstbasetransform.h>
#include <gst/gst.h>

#include <deque>

#include "mrducker_abi.h"

GST_DEBUG_CATEGORY_STATIC(mrptskeep_debug);
#define GST_CAT_DEFAULT mrptskeep_debug

namespace {

/* One buffer into the target: what the target's output for it carries. */
struct Record {
    GstClockTime pts, dts, duration;
    guint64 offset, offset_end;
    guint flags;
    gsize frames;      // 0 while the target's input caps are not audio
    GThread* thread;   // the target's streaming thread
};

}  // namespace

enum { PROP_0, PROP_TARGET, PROP_ABI };

#define GST_TYPE_MRPTSKEEP (gst_mrptskeep_get_type())
G_DECLARE_FINAL_TYPE(GstMrPtsKeep, gst_mrptskeep, GST, MRPTSKEEP, GstBaseTransform)

struct _GstMrPtsKeep {
    GstBaseTransform parent;
    gchar* target;   // the property (object lock)

    /* State changes only: the target's sink pad and the probe on it, from READY->PAUSED. */
    GstPad* target_pad;
    gulong probe;

    /* The probe and transform_ip, both in the target's streaming thread. */
    GMutex lock;
    std::deque<Record>* pending;   // the target's last chain call: one buffer, or a list's
    gint in_bpf;                   // the target's input frame size
    gint out_bpf;                  // ours
};

G_DEFINE_TYPE_WITH_CODE(GstMrPtsKeep, gst_mrptskeep, GST_TYPE_BASE_TRANSFORM,
                        GST_DEBUG_CATEGORY_INIT(mrptskeep_debug, "mrptskeep", 0,
                                                "Media Router PTS keeper"))

static GstStaticPadTemplate pk_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS("audio/x-raw"));
static GstStaticPadTemplate pk_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS("audio/x-raw"));

/* Bytes per frame of audio caps; 0 for anything else. */
static gint pk_bpf(GstCaps* caps) {
    GstAudioInfo info;
    return caps && gst_audio_info_from_caps(&info, caps) ? GST_AUDIO_INFO_BPF(&info) : 0;
}

static void pk_record(GstMrPtsKeep* self, GstBuffer* buf) {
    Record r;
    r.pts = GST_BUFFER_PTS(buf);
    r.dts = GST_BUFFER_DTS(buf);
    r.duration = GST_BUFFER_DURATION(buf);
    r.offset = GST_BUFFER_OFFSET(buf);
    r.offset_end = GST_BUFFER_OFFSET_END(buf);
    r.flags = GST_BUFFER_FLAGS(buf);
    r.frames = self->in_bpf > 0 ? gst_buffer_get_size(buf) / (gsize)self->in_bpf : 0;
    r.thread = g_thread_self();
    self->pending->push_back(r);
}

/* On the target's sink pad, in its streaming thread: what the target outputs next is for this
 * call, so an input it dropped leaves no record behind. */
static GstPadProbeReturn pk_probe(GstPad*, GstPadProbeInfo* info, gpointer user) {
    GstMrPtsKeep* self = GST_MRPTSKEEP(user);
    g_mutex_lock(&self->lock);
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER) {
        self->pending->clear();
        pk_record(self, GST_PAD_PROBE_INFO_BUFFER(info));
    } else if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        self->pending->clear();
        GstBufferList* list = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
        for (guint i = 0; i < gst_buffer_list_length(list); i++)
            pk_record(self, gst_buffer_list_get(list, i));
    } else if (info->type & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM) {
        GstEvent* ev = GST_PAD_PROBE_INFO_EVENT(info);
        if (GST_EVENT_TYPE(ev) == GST_EVENT_CAPS) {
            GstCaps* caps = nullptr;
            gst_event_parse_caps(ev, &caps);
            self->in_bpf = pk_bpf(caps);
        }
    }
    g_mutex_unlock(&self->lock);
    return GST_PAD_PROBE_OK;
}

/* The `target` is looked up in the topmost bin; its sink pad gets the recording probe. */
static gboolean pk_attach(GstMrPtsKeep* self) {
    GST_OBJECT_LOCK(self);
    gchar* name = g_strdup(self->target);
    GST_OBJECT_UNLOCK(self);
    GstObject* top = GST_OBJECT_CAST(gst_object_ref(self));
    while (GstObject* p = gst_object_get_parent(top)) {
        gst_object_unref(top);
        top = p;
    }
    GstElement* el =
        name && *name && GST_IS_BIN(top) ? gst_bin_get_by_name(GST_BIN(top), name) : nullptr;
    gst_object_unref(top);
    GstPad* pad = el ? gst_element_get_static_pad(el, "sink") : nullptr;
    if (el) gst_object_unref(el);
    if (!pad) {
        GST_ELEMENT_ERROR(self, CORE, FAILED,
                          ("No element '%s' with a sink pad to keep the timing of",
                           name ? name : ""),
                          ("mrptskeep's target must be in the same pipeline"));
        g_free(name);
        return FALSE;
    }
    g_free(name);
    GstCaps* caps = gst_pad_get_current_caps(pad);
    g_mutex_lock(&self->lock);
    self->pending->clear();
    self->in_bpf = pk_bpf(caps);
    g_mutex_unlock(&self->lock);
    if (caps) gst_caps_unref(caps);
    self->target_pad = pad;
    self->probe = gst_pad_add_probe(
        pad,
        (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST |
                          GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM),
        pk_probe, self, nullptr);
    return TRUE;
}

static void pk_detach(GstMrPtsKeep* self) {
    if (!self->target_pad) return;
    gst_pad_remove_probe(self->target_pad, self->probe);
    gst_object_unref(self->target_pad);
    self->target_pad = nullptr;
    self->probe = 0;
    g_mutex_lock(&self->lock);
    self->pending->clear();
    g_mutex_unlock(&self->lock);
}

/* --- GstBaseTransform ------------------------------------------------------------------- */

static gboolean pk_set_caps(GstBaseTransform* trans, GstCaps* incaps, GstCaps*) {
    GstMrPtsKeep* self = GST_MRPTSKEEP(trans);
    const gint bpf = pk_bpf(incaps);
    if (bpf <= 0) return FALSE;
    g_mutex_lock(&self->lock);
    self->out_bpf = bpf;
    g_mutex_unlock(&self->lock);
    return TRUE;
}

static GstFlowReturn pk_transform_ip(GstBaseTransform* trans, GstBuffer* buf) {
    GstMrPtsKeep* self = GST_MRPTSKEEP(trans);
    g_mutex_lock(&self->lock);
    const bool have = !self->pending->empty();
    Record r{};
    if (have) {
        r = self->pending->front();
        self->pending->pop_front();
    }
    const gsize frames = self->out_bpf > 0 ? gst_buffer_get_size(buf) / (gsize)self->out_bpf : 0;
    g_mutex_unlock(&self->lock);
    /* A buffer the target did not make for its last input, in this thread, is a misplacement. */
    if (!have || r.thread != g_thread_self()) {
        GST_ELEMENT_ERROR(self, STREAM, FAILED,
                          ("No input of %s:%s for this buffer",
                           GST_DEBUG_PAD_NAME(self->target_pad)),
                          ("mrptskeep must follow its target in the target's streaming thread"));
        return GST_FLOW_ERROR;
    }
    if (r.frames == 0 || r.frames != frames) {
        GST_ELEMENT_ERROR(self, STREAM, FAILED,
                          ("%s:%s is not 1:1 in frames", GST_DEBUG_PAD_NAME(self->target_pad)),
                          ("%" G_GSIZE_FORMAT " frames in, %" G_GSIZE_FORMAT " out", r.frames,
                           frames));
        return GST_FLOW_ERROR;
    }
    GST_BUFFER_PTS(buf) = r.pts;
    GST_BUFFER_DTS(buf) = r.dts;
    GST_BUFFER_DURATION(buf) = r.duration;
    GST_BUFFER_OFFSET(buf) = r.offset;
    GST_BUFFER_OFFSET_END(buf) = r.offset_end;
    /* As GstBaseTransform's default_copy_metadata: the flags, then GAP cleared (the target is
     * not gap-aware). No sample is touched. */
    GST_BUFFER_FLAG_SET(buf, r.flags & ~(guint)(GST_BUFFER_FLAG_TAG_MEMORY | GST_BUFFER_FLAG_GAP));
    return GST_FLOW_OK;
}

static GstStateChangeReturn pk_change_state(GstElement* element, GstStateChange transition) {
    GstMrPtsKeep* self = GST_MRPTSKEEP(element);
    if (transition == GST_STATE_CHANGE_READY_TO_PAUSED && !pk_attach(self))
        return GST_STATE_CHANGE_FAILURE;
    const GstStateChangeReturn ret =
        GST_ELEMENT_CLASS(gst_mrptskeep_parent_class)->change_state(element, transition);
    if (transition == GST_STATE_CHANGE_PAUSED_TO_READY ||
        (transition == GST_STATE_CHANGE_READY_TO_PAUSED && ret == GST_STATE_CHANGE_FAILURE))
        pk_detach(self);
    return ret;
}

/* --- GObject ---------------------------------------------------------------------------- */

static void pk_set_property(GObject* object, guint prop_id, const GValue* value,
                            GParamSpec* pspec) {
    GstMrPtsKeep* self = GST_MRPTSKEEP(object);
    switch (prop_id) {
        case PROP_TARGET:
            GST_OBJECT_LOCK(self);
            g_free(self->target);
            self->target = g_value_dup_string(value);
            GST_OBJECT_UNLOCK(self);
            break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec); break;
    }
}

static void pk_get_property(GObject* object, guint prop_id, GValue* value, GParamSpec* pspec) {
    GstMrPtsKeep* self = GST_MRPTSKEEP(object);
    switch (prop_id) {
        case PROP_TARGET:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->target);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_ABI: g_value_set_int(value, MRDUCKER_ABI); break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec); break;
    }
}

static void pk_finalize(GObject* object) {
    GstMrPtsKeep* self = GST_MRPTSKEEP(object);
    pk_detach(self);
    delete self->pending;
    g_free(self->target);
    g_mutex_clear(&self->lock);
    G_OBJECT_CLASS(gst_mrptskeep_parent_class)->finalize(object);
}

static void gst_mrptskeep_init(GstMrPtsKeep* self) {
    self->target = nullptr;
    self->target_pad = nullptr;
    self->probe = 0;
    g_mutex_init(&self->lock);
    self->pending = new std::deque<Record>();
    self->in_bpf = self->out_bpf = 0;
    /* Metadata only: the buffer goes on as it came, made writable when it is not. */
    gst_base_transform_set_in_place(GST_BASE_TRANSFORM(self), TRUE);
}

static void gst_mrptskeep_class_init(GstMrPtsKeepClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);
    GstBaseTransformClass* trans_class = GST_BASE_TRANSFORM_CLASS(klass);

    gobject_class->set_property = pk_set_property;
    gobject_class->get_property = pk_get_property;
    gobject_class->finalize = pk_finalize;
    element_class->change_state = GST_DEBUG_FUNCPTR(pk_change_state);

    g_object_class_install_property(
        gobject_class, PROP_TARGET,
        g_param_spec_string("target", "Target",
                            "The filter whose input timing goes on its output: right upstream, "
                            "in this element's streaming thread, one buffer of the same frames "
                            "out per buffer in",
                            NULL,
                            (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS |
                                          GST_PARAM_MUTABLE_READY)));
    g_object_class_install_property(
        gobject_class, PROP_ABI,
        g_param_spec_int("abi", "ABI",
                         "Element protocol version of this plugin (MRDUCKER_ABI); a runner "
                         "refuses a plugin below its own minimum.",
                         0, G_MAXINT, MRDUCKER_ABI,
                         (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));

    trans_class->set_caps = GST_DEBUG_FUNCPTR(pk_set_caps);
    trans_class->transform_ip = GST_DEBUG_FUNCPTR(pk_transform_ip);

    gst_element_class_add_static_pad_template(element_class, &pk_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &pk_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router PTS keeper", "Filter/Audio",
        "Puts back the timestamps and flags a 1:1 audio filter dropped (the LADSPA wrapper's "
        "filters with more inputs than outputs): each buffer the target outputs gets those of "
        "the buffer that went in",
        "Media Router <https://github.com/bccsa/media-router>");
}
