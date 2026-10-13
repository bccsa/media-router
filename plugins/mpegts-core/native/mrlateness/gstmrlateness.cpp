/* mrlateness: a pass-through tap measuring lateness λ = now − PTS (design §9.5), one
 * `mrlateness` message per mrts::LatenessWindow (shared with the sidecars). A plain GstElement:
 * GstBaseTransform has no chain_list and would split mpegtsmux's AU lists (ADR-0011). */
#include <gst/gst.h>

#include <atomic>
#include <ctime>

#include "mrts/lateness.h"

/* GST_PLUGIN_DEFINE reads PACKAGE for GstPluginDesc.source. */
#define PACKAGE "media-router"
#define MRLATENESS_VERSION "1.0.0"

GST_DEBUG_CATEGORY_STATIC(mrlateness_debug);
#define GST_CAT_DEFAULT mrlateness_debug

enum MrLatenessReference { MRLATENESS_REF_HOUSE = 0, MRLATENESS_REF_RUNNING_TIME = 1 };

enum { PROP_0, PROP_REFERENCE, PROP_INTERVAL_MS, PROP_POST_MESSAGES, PROP_STATS };

#define DEFAULT_INTERVAL_MS 2000

static GType gst_mrlateness_reference_get_type(void) {
    static GType type = 0;
    static const GEnumValue values[] = {
        {MRLATENESS_REF_HOUSE, "Raw PTS against CLOCK_MONOTONIC (the bus convention)", "house"},
        {MRLATENESS_REF_RUNNING_TIME, "Segment running time against the element clock",
         "running-time"},
        {0, NULL, NULL},
    };
    if (g_once_init_enter(&type)) {
        GType t = g_enum_register_static("GstMrLatenessReference", values);
        g_once_init_leave(&type, t);
    }
    return type;
}

static const gchar *reference_nick(int ref) {
    return ref == MRLATENESS_REF_RUNNING_TIME ? "running-time" : "house";
}

#define GST_TYPE_MRLATENESS (gst_mrlateness_get_type())
G_DECLARE_FINAL_TYPE(GstMrLateness, gst_mrlateness, GST, MRLATENESS, GstElement)

struct _GstMrLateness {
    GstElement parent;
    GstPad *sinkpad;
    GstPad *srcpad;

    /* Properties: written from any thread, read per buffer without a lock. */
    std::atomic<int> reference;
    std::atomic<int> interval_ms;
    std::atomic<int> post_messages;

    /* Streaming thread only (chain, chain_list and serialized events share
     * the stream lock); change_state touches them while no data flows. */
    mrts::LatenessWindow *window;
    int win_reference;
    int win_interval_ms;
    GstSegment segment;

    /* The `stats` snapshot: written once per window, read by the app. */
    GMutex stats_lock;
    mrts::LatenessWindow::Summary last;
    int last_reference;
    guint64 windows;
    std::atomic<guint64> buffers;
    std::atomic<guint64> lists;
};

G_DEFINE_TYPE(GstMrLateness, gst_mrlateness, GST_TYPE_ELEMENT)

static GstStaticPadTemplate mrlateness_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);
static GstStaticPadTemplate mrlateness_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

static gint64 mono_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (gint64)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

/* --- measuring ----------------------------------------------------------- */

static void gst_mrlateness_publish(GstMrLateness *self,
                                   const mrts::LatenessWindow::Summary &s, int ref) {
    g_mutex_lock(&self->stats_lock);
    self->last = s;
    self->last_reference = ref;
    self->windows++;
    g_mutex_unlock(&self->stats_lock);

    GST_INFO_OBJECT(self, "%s window: count %" G_GUINT64_FORMAT " untimed %" G_GUINT64_FORMAT
                    " min %" G_GINT64_FORMAT " mean %" G_GINT64_FORMAT " max %" G_GINT64_FORMAT
                    " ns", reference_nick(ref), (guint64)s.count, (guint64)s.untimed,
                    (gint64)s.min_ns, (gint64)s.mean_ns, (gint64)s.max_ns);
    if (!self->post_messages.load(std::memory_order_relaxed)) return;
    GstStructure *st = gst_structure_new(
        "mrlateness", "count", G_TYPE_UINT64, (guint64)s.count, "untimed", G_TYPE_UINT64,
        (guint64)s.untimed, "min-ns", G_TYPE_INT64, (gint64)s.min_ns, "mean-ns", G_TYPE_INT64,
        (gint64)s.mean_ns, "max-ns", G_TYPE_INT64, (gint64)s.max_ns, "last-ns", G_TYPE_INT64,
        (gint64)s.last_ns, "interval-ns", G_TYPE_INT64, (gint64)s.interval_ns, "reference",
        G_TYPE_STRING, reference_nick(ref), NULL);
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), st));
}

/* One sample per buffer (per list: its first buffer). The window cadence runs
 * on CLOCK_MONOTONIC in both modes, so `house` costs one clock read. */
static void gst_mrlateness_measure(GstMrLateness *self, GstBuffer *buf) {
    int ref = self->reference.load(std::memory_order_relaxed);
    int interval = self->interval_ms.load(std::memory_order_relaxed);
    if (ref != self->win_reference || interval != self->win_interval_ms) {
        /* One window never mixes two references or two lengths. */
        *self->window = mrts::LatenessWindow((int64_t)interval * GST_MSECOND);
        self->win_reference = ref;
        self->win_interval_ms = interval;
    }

    GstClockTime t = GST_BUFFER_PTS_IS_VALID(buf) ? GST_BUFFER_PTS(buf) : GST_BUFFER_DTS(buf);
    gint64 now = mono_ns();
    if (ref == MRLATENESS_REF_HOUSE) {
        if (GST_CLOCK_TIME_IS_VALID(t)) self->window->add(now - (gint64)t);
        else self->window->add_untimed();
    } else {
        GstClockTime rt = GST_CLOCK_TIME_NONE;
        if (GST_CLOCK_TIME_IS_VALID(t) && self->segment.format == GST_FORMAT_TIME)
            rt = gst_segment_to_running_time(&self->segment, GST_FORMAT_TIME, t);
        /* No clock yet (not PLAYING) or outside the segment: untimed. */
        GstClockTime rt_now = GST_CLOCK_TIME_IS_VALID(rt)
                                  ? gst_element_get_current_running_time(GST_ELEMENT_CAST(self))
                                  : GST_CLOCK_TIME_NONE;
        if (GST_CLOCK_TIME_IS_VALID(rt_now)) self->window->add((gint64)rt_now - (gint64)rt);
        else self->window->add_untimed();
    }

    if (self->window->due(now)) {
        mrts::LatenessWindow::Summary s = self->window->take(now);
        if (s.count > 0 || s.untimed > 0) gst_mrlateness_publish(self, s, ref);
    }
}

/* --- pads ---------------------------------------------------------------- */

static GstFlowReturn gst_mrlateness_chain(GstPad *, GstObject *parent, GstBuffer *buf) {
    GstMrLateness *self = GST_MRLATENESS(parent);
    self->buffers.fetch_add(1, std::memory_order_relaxed);
    gst_mrlateness_measure(self, buf);
    return gst_pad_push(self->srcpad, buf);
}

static GstFlowReturn gst_mrlateness_chain_list(GstPad *, GstObject *parent, GstBufferList *list) {
    GstMrLateness *self = GST_MRLATENESS(parent);
    self->lists.fetch_add(1, std::memory_order_relaxed);
    if (gst_buffer_list_length(list) > 0)
        gst_mrlateness_measure(self, gst_buffer_list_get(list, 0));
    return gst_pad_push_list(self->srcpad, list);
}

static gboolean gst_mrlateness_sink_event(GstPad *pad, GstObject *parent, GstEvent *event) {
    GstMrLateness *self = GST_MRLATENESS(parent);
    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_SEGMENT:
            gst_event_copy_segment(event, &self->segment);
            break;
        case GST_EVENT_FLUSH_STOP:
            gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
            break;
        default:
            break;
    }
    return gst_pad_event_default(pad, parent, event);
}

/* --- GObject ------------------------------------------------------------- */

static GstStateChangeReturn gst_mrlateness_change_state(GstElement *element,
                                                        GstStateChange transition) {
    GstMrLateness *self = GST_MRLATENESS(element);
    if (transition == GST_STATE_CHANGE_READY_TO_PAUSED) {
        /* A restart opens a fresh window; no data flows yet. */
        self->win_interval_ms = self->interval_ms.load(std::memory_order_relaxed);
        self->win_reference = self->reference.load(std::memory_order_relaxed);
        *self->window = mrts::LatenessWindow((int64_t)self->win_interval_ms * GST_MSECOND);
        gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
    }
    return GST_ELEMENT_CLASS(gst_mrlateness_parent_class)->change_state(element, transition);
}

static void gst_mrlateness_set_property(GObject *object, guint prop_id, const GValue *value,
                                        GParamSpec *pspec) {
    GstMrLateness *self = GST_MRLATENESS(object);
    switch (prop_id) {
        case PROP_REFERENCE:
            self->reference.store(g_value_get_enum(value), std::memory_order_relaxed);
            break;
        case PROP_INTERVAL_MS:
            self->interval_ms.store(g_value_get_int(value), std::memory_order_relaxed);
            break;
        case PROP_POST_MESSAGES:
            self->post_messages.store(g_value_get_boolean(value) ? 1 : 0,
                                      std::memory_order_relaxed);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void gst_mrlateness_get_property(GObject *object, guint prop_id, GValue *value,
                                        GParamSpec *pspec) {
    GstMrLateness *self = GST_MRLATENESS(object);
    switch (prop_id) {
        case PROP_REFERENCE:
            g_value_set_enum(value, self->reference.load(std::memory_order_relaxed));
            break;
        case PROP_INTERVAL_MS:
            g_value_set_int(value, self->interval_ms.load(std::memory_order_relaxed));
            break;
        case PROP_POST_MESSAGES:
            g_value_set_boolean(value, self->post_messages.load(std::memory_order_relaxed) != 0);
            break;
        case PROP_STATS: {
            g_mutex_lock(&self->stats_lock);
            mrts::LatenessWindow::Summary s = self->last;
            int ref = self->last_reference;
            guint64 windows = self->windows;
            g_mutex_unlock(&self->stats_lock);
            g_value_take_boxed(
                value,
                gst_structure_new(
                    "mrlateness-stats", "count", G_TYPE_UINT64, (guint64)s.count, "untimed",
                    G_TYPE_UINT64, (guint64)s.untimed, "min-ns", G_TYPE_INT64, (gint64)s.min_ns,
                    "mean-ns", G_TYPE_INT64, (gint64)s.mean_ns, "max-ns", G_TYPE_INT64,
                    (gint64)s.max_ns, "last-ns", G_TYPE_INT64, (gint64)s.last_ns, "interval-ns",
                    G_TYPE_INT64, (gint64)s.interval_ns, "reference", G_TYPE_STRING,
                    reference_nick(ref), "windows", G_TYPE_UINT64, windows, "buffers",
                    G_TYPE_UINT64, self->buffers.load(std::memory_order_relaxed), "lists",
                    G_TYPE_UINT64, self->lists.load(std::memory_order_relaxed), NULL));
            break;
        }
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void gst_mrlateness_finalize(GObject *object) {
    GstMrLateness *self = GST_MRLATENESS(object);
    delete self->window;
    g_mutex_clear(&self->stats_lock);
    G_OBJECT_CLASS(gst_mrlateness_parent_class)->finalize(object);
}

static GstPad *gst_mrlateness_new_pad(GstMrLateness *self, GstStaticPadTemplate *tmpl,
                                      const gchar *name) {
    GstPad *pad = gst_pad_new_from_static_template(tmpl, name);
    /* Caps, allocation and scheduling are the neighbours' business. */
    GST_PAD_SET_PROXY_CAPS(pad);
    GST_PAD_SET_PROXY_ALLOCATION(pad);
    GST_PAD_SET_PROXY_SCHEDULING(pad);
    gst_element_add_pad(GST_ELEMENT_CAST(self), pad);
    return pad;
}

static void gst_mrlateness_init(GstMrLateness *self) {
    self->reference.store(MRLATENESS_REF_HOUSE, std::memory_order_relaxed);
    self->interval_ms.store(DEFAULT_INTERVAL_MS, std::memory_order_relaxed);
    self->post_messages.store(1, std::memory_order_relaxed);
    self->win_reference = MRLATENESS_REF_HOUSE;
    self->win_interval_ms = DEFAULT_INTERVAL_MS;
    self->window = new mrts::LatenessWindow((int64_t)DEFAULT_INTERVAL_MS * GST_MSECOND);
    gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
    g_mutex_init(&self->stats_lock);
    self->last = mrts::LatenessWindow::Summary();
    self->last_reference = MRLATENESS_REF_HOUSE;
    self->windows = 0;
    self->buffers.store(0, std::memory_order_relaxed);
    self->lists.store(0, std::memory_order_relaxed);

    self->sinkpad = gst_mrlateness_new_pad(self, &mrlateness_sink_tmpl, "sink");
    gst_pad_set_chain_function(self->sinkpad, GST_DEBUG_FUNCPTR(gst_mrlateness_chain));
    gst_pad_set_chain_list_function(self->sinkpad,
                                    GST_DEBUG_FUNCPTR(gst_mrlateness_chain_list));
    gst_pad_set_event_function(self->sinkpad, GST_DEBUG_FUNCPTR(gst_mrlateness_sink_event));
    self->srcpad = gst_mrlateness_new_pad(self, &mrlateness_src_tmpl, "src");
}

static void gst_mrlateness_class_init(GstMrLatenessClass *klass) {
    GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass *element_class = GST_ELEMENT_CLASS(klass);

    gobject_class->set_property = gst_mrlateness_set_property;
    gobject_class->get_property = gst_mrlateness_get_property;
    gobject_class->finalize = gst_mrlateness_finalize;
    element_class->change_state = gst_mrlateness_change_state;

    GParamFlags rw = (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS
                                   | GST_PARAM_MUTABLE_PLAYING);
    g_object_class_install_property(
        gobject_class, PROP_REFERENCE,
        g_param_spec_enum("reference", "Reference",
                          "house: now = CLOCK_MONOTONIC, t = raw buffer PTS (bus edges, "
                          "right under any pipeline clock). running-time: now = element "
                          "clock - base time, t = segment running time (before sinks).",
                          gst_mrlateness_reference_get_type(), MRLATENESS_REF_HOUSE, rw));
    g_object_class_install_property(
        gobject_class, PROP_INTERVAL_MS,
        g_param_spec_int("interval-ms", "Interval (ms)",
                         "Window length; one summary per window that saw buffers.", 10,
                         600000, DEFAULT_INTERVAL_MS, rw));
    g_object_class_install_property(
        gobject_class, PROP_POST_MESSAGES,
        g_param_spec_boolean("post-messages", "Post messages",
                             "Post an `mrlateness` element message per window.", TRUE, rw));
    g_object_class_install_property(
        gobject_class, PROP_STATS,
        g_param_spec_boxed("stats", "Stats",
                           "The last window's summary (the message's fields) plus the "
                           "windows, buffers and lists seen since construction.",
                           GST_TYPE_STRUCTURE,
                           (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));

    gst_element_class_add_static_pad_template(element_class, &mrlateness_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &mrlateness_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router lateness tap", "Generic",
        "Pass-through tap reporting lateness (now - PTS) per window (house-clock design 9.5)",
        "Media Router <https://github.com/bccsa/media-router>");
}

static gboolean plugin_init(GstPlugin *plugin) {
    GST_DEBUG_CATEGORY_INIT(mrlateness_debug, "mrlateness", 0, "Media Router lateness tap");
    /* Rank NONE: placed by name in pipeline strings, never auto-plugged. */
    return gst_element_register(plugin, "mrlateness", GST_RANK_NONE, GST_TYPE_MRLATENESS);
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrlateness,
                  "Media Router lateness tap", plugin_init, MRLATENESS_VERSION, "MIT/X11",
                  "media-router", "https://github.com/bccsa/media-router")
