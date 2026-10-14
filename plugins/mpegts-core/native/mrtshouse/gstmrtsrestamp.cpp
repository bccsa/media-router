/* mrtsrestamp (plan ch. 5 WI-P1-4): mrts::RestampCore as an element. Output keeps the input's
 * timestamps, so a time-bounded queue after it still measures arrival; gaps leave as OQ-12
 * markers. A plain GstElement, as the plugin's others, so a buffer list leaves as one list. */
#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <map>
#include <new>
#include <string>
#include <vector>

#include "mrts/ts_gap.h"
#include "mrts/ts_restamp.h"
#include "mrts/ts_stc.h"
#include "mrts/ts_trace.h"
#include "mrtshouse.h"

#define GST_CAT_DEFAULT mrtshouse_debug

using mrts::RestampCore;

enum { MRTSRESTAMP_MODE_STC = 0, MRTSRESTAMP_MODE_FIXED = 1 };
enum { MRTSRESTAMP_ARRIVAL_CLOCK = 0, MRTSRESTAMP_ARRIVAL_BUFFER_PTS = 1 };

enum {
    PROP_0,
    PROP_CLOCK_MODE,
    PROP_ARRIVAL,
    PROP_ADD_BASE_TIME,
    PROP_OFFSET_NS,
    PROP_PID_TRIMS,
    PROP_STATS_INTERVAL_MS,
    PROP_TRACE_LOCATION,
    PROP_STATS,
};

#define DEFAULT_STATS_INTERVAL_MS 2000
/* OQ-17: during an outage a marker at detection, then every 250 ms. */
static const gint64 OUTAGE_MARK_NS = 250 * GST_MSECOND;
/* The task's longest sleep: it recomputes its deadlines at least this often. */
static const gint64 TASK_MAX_WAIT_NS = GST_SECOND;

static GType gst_mrtsrestamp_clock_mode_get_type(void) {
    static GType type = 0;
    static const GEnumValue values[] = {
        {MRTSRESTAMP_MODE_STC,
         "A virtual STC per program locked to the source PCR (network ingests)", "stc"},
        {MRTSRESTAMP_MODE_FIXED, "PES - 1 h as received, moved by a constant (local captures)",
         "fixed"},
        {0, NULL, NULL},
    };
    if (g_once_init_enter(&type)) {
        GType t = g_enum_register_static("GstMrtsRestampClockMode", values);
        g_once_init_leave(&type, t);
    }
    return type;
}

static GType gst_mrtsrestamp_arrival_get_type(void) {
    static GType type = 0;
    static const GEnumValue values[] = {
        {MRTSRESTAMP_ARRIVAL_CLOCK, "The pipeline clock - base time at chain entry", "clock"},
        {MRTSRESTAMP_ARRIVAL_BUFFER_PTS, "The buffer's PTS (appsrc-driven tests and replays)",
         "buffer-pts"},
        {0, NULL, NULL},
    };
    if (g_once_init_enter(&type)) {
        GType t = g_enum_register_static("GstMrtsRestampArrival", values);
        g_once_init_leave(&type, t);
    }
    return type;
}

#define GST_TYPE_MRTSRESTAMP (gst_mrtsrestamp_get_type())
G_DECLARE_FINAL_TYPE(GstMrtsRestamp, gst_mrtsrestamp, GST, MRTSRESTAMP, GstElement)

struct _GstMrtsRestamp {
    GstElement parent;
    GstPad* sinkpad;
    GstPad* srcpad;

    /* Properties, under the object lock. The live ones raise `dirty`; the streaming thread
     * takes them at its next buffer. clock-mode, arrival and add-base-time apply at a start. */
    gint clock_mode;
    gint arrival;
    gboolean add_base_time;
    gint64 offset_ns;
    gchar* pid_trims;
    std::map<int, int64_t>* trims;
    gchar* trace_location;
    gboolean edits_pending, trace_pending;
    std::atomic<bool> dirty;
    std::atomic<guint> stats_interval_ms;

    /* Streaming state, under the sink pad's stream lock: chain, chain_list, serialized events
     * and the outage task, which only tries it. A state change resets it while nothing flows. */
    RestampCore* core;                      // null until the first buffer of a start
    gint run_arrival;                       // `arrival` as the core was built
    gint64 base_ns;                         // the core's base: the base time under add-base-time
    mrts::TraceWriter* trace;
    std::string* trace_path;                // the trace of this run ("" none); not reopened at EOS
    GstSegment segment;
    gboolean have_arrival;
    gint64 last_arrival;
    GstClockTime last_in_ts;                // the last input DTS-or-PTS: the markers' DTS
    gboolean have_stats_at;
    gint64 stats_at;
    gboolean eos;
    gint64 next_mark;                       // the next outage marker; the next outage is past it
    gboolean map_warned;
    std::vector<GstBuffer*>* pieces;        // one input buffer's output, reused
    std::vector<GstBuffer*>* members;       // a list's members, reused
    guint64 buffers, lists, markers, outage_markers;

    /* The `stats` snapshot, written at each stats post. */
    GMutex snap_lock;
    GstStructure* snapshot;

    MrtsHouseCommon common;

    /* The outage task (OQ-17), started in PLAYING under arrival=clock. */
    GstTask* task;
    GRecMutex task_lock;
    GMutex wait_lock;
    GCond wait_cond;
    gboolean task_run;
    gint64 task_wait_ns;                    // task thread only
};

G_DEFINE_TYPE(GstMrtsRestamp, gst_mrtsrestamp, GST_TYPE_ELEMENT)

static GstStaticPadTemplate restamp_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);
static GstStaticPadTemplate restamp_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

/* --- names and parsing ---------------------------------------------------------------- */

static const gchar* state_name(mrts::VirtualStc::State s) {
    switch (s) {
        case mrts::VirtualStc::State::locked: return "locked";
        case mrts::VirtualStc::State::degraded: return "degraded";
        case mrts::VirtualStc::State::lost: return "lost";
        default: return "acquiring";
    }
}

/* "<pid>=<ns>;…": a decimal or 0x PID 0-8191 and signed ns; the core clamps the ns to ±2 s.
 * A malformed entry is skipped and named in `bad`. */
static void parse_trims(const gchar* s, std::map<int, int64_t>* out, std::string* bad) {
    out->clear();
    bad->clear();
    if (!s) return;
    gchar** items = g_strsplit(s, ";", -1);
    for (gchar** it = items; *it; it++) {
        gchar* item = g_strstrip(*it);
        if (!*item) continue;
        gchar* eq = std::strchr(item, '=');
        bool ok = eq != NULL;
        long pid = -1;
        long long ns = 0;
        if (ok) {
            *eq = '\0';
            gchar* key = g_strstrip(item);
            gchar* val = g_strstrip(eq + 1);
            const bool hex = key[0] == '0' && (key[1] == 'x' || key[1] == 'X');
            char* end = NULL;
            errno = 0;
            pid = *key ? std::strtol(key, &end, hex ? 16 : 10) : -1;
            ok = end && !*end && errno == 0 && pid >= 0 && pid <= 0x1FFF;
            end = NULL;
            errno = 0;
            ns = *val ? std::strtoll(val, &end, 10) : 0;
            ok = ok && end && !*end && errno == 0;
            if (!ok) *eq = '=';
        }
        if (ok) {
            (*out)[(int)pid] = (int64_t)ns;
        } else {
            if (!bad->empty()) *bad += "; ";
            *bad += item;
        }
    }
    g_strfreev(items);
}

/* --- time ----------------------------------------------------------------------------- */

/* Pipeline clock - base time; false without a clock (not PLAYING yet). */
static gboolean restamp_clock_now(GstMrtsRestamp* self, gint64* now) {
    GstClock* clock = gst_element_get_clock(GST_ELEMENT_CAST(self));
    if (!clock) return FALSE;
    const GstClockTime t = gst_clock_get_time(clock);
    gst_object_unref(clock);
    if (!GST_CLOCK_TIME_IS_VALID(t)) return FALSE;
    *now = (gint64)t - (gint64)gst_element_get_base_time(GST_ELEMENT_CAST(self));
    return TRUE;
}

/* The arrival the core gets: the clock read at chain entry, else (buffer-pts, or no clock in a
 * preroll) the buffer's own time, else the previous arrival. */
static gint64 restamp_arrival(GstMrtsRestamp* self, GstBuffer* buf, gboolean have_clock,
                              gint64 clock_now) {
    if (have_clock) return clock_now;
    const GstClockTime t = GST_BUFFER_PTS_IS_VALID(buf) ? GST_BUFFER_PTS(buf) : GST_BUFFER_DTS(buf);
    if (GST_CLOCK_TIME_IS_VALID(t)) return (gint64)t;
    return self->have_arrival ? self->last_arrival : 0;
}

/* The bus convention for a marker's PTS: unixfdsink sends running time + base time, so the
 * running time is house - base, mapped back through the segment as mrtsstamp maps a stamp. */
static GstClockTime restamp_bus_pts(GstMrtsRestamp* self, gint64 house_ns) {
    const gint64 running = MAX(house_ns - self->base_ns, 0);
    if (self->segment.format == GST_FORMAT_TIME) {
        const guint64 pos = gst_segment_position_from_running_time(&self->segment, GST_FORMAT_TIME,
                                                                   (guint64)running);
        if (GST_CLOCK_TIME_IS_VALID(pos)) return (GstClockTime)pos;
    }
    return (GstClockTime)running;
}

/* --- the core ------------------------------------------------------------------------- */

static void restamp_set_trace(GstMrtsRestamp* self, const std::string& path) {
    if (path == *self->trace_path) return;
    if (self->trace->is_open()) {
        self->core->set_trace(NULL);
        if (!self->trace->close())
            GST_ELEMENT_WARNING(self, RESOURCE, WRITE, ("Trace %s not fully written",
                                                       self->trace_path->c_str()), (NULL));
    }
    *self->trace_path = path;
    if (path.empty()) return;
    if (!self->trace->open(path)) {
        const int err = errno;
        GST_ELEMENT_WARNING(self, RESOURCE, OPEN_WRITE, ("Cannot write trace %s", path.c_str()),
                            ("%s", g_strerror(err)));
        return;
    }
    /* A trace begun mid-stream opens with the tables in force (RestampCore::set_trace). */
    self->core->set_trace(self->trace);
    GST_INFO_OBJECT(self, "recording the arrival trace to %s", path.c_str());
}

static void restamp_close_trace(GstMrtsRestamp* self) {
    if (!self->trace->is_open()) return;
    if (self->core) self->core->set_trace(NULL);
    if (!self->trace->close())
        GST_ELEMENT_WARNING(self, RESOURCE, WRITE, ("Trace %s not fully written",
                                                   self->trace_path->c_str()), (NULL));
}

/* The first buffer of a start builds the core from the properties as they are then. */
static void restamp_build(GstMrtsRestamp* self) {
    mrts::RestampConfig cfg;
    GST_OBJECT_LOCK(self);
    cfg.mode = self->clock_mode == MRTSRESTAMP_MODE_FIXED ? mrts::RestampConfig::Mode::fixed
                                                          : mrts::RestampConfig::Mode::stc;
    cfg.add_base_time = cfg.mode == mrts::RestampConfig::Mode::fixed && self->add_base_time;
    cfg.offset_ns = self->offset_ns;
    cfg.trims_ns = *self->trims;
    self->run_arrival = self->arrival;
    self->edits_pending = FALSE;
    self->trace_pending = TRUE;   // the trace of this run opens below
    GST_OBJECT_UNLOCK(self);
    self->dirty.store(true, std::memory_order_relaxed);
    if (cfg.add_base_time)
        cfg.base_time_ns = (int64_t)gst_element_get_base_time(GST_ELEMENT_CAST(self));
    self->base_ns = cfg.add_base_time ? cfg.base_time_ns : 0;
    self->core = new RestampCore(cfg);
}

/* Live properties, taken under the object lock, applied here at the next buffer. */
static void restamp_apply(GstMrtsRestamp* self) {
    if (!self->dirty.exchange(false, std::memory_order_acq_rel)) return;
    GST_OBJECT_LOCK(self);
    const gboolean edits = self->edits_pending, retrace = self->trace_pending;
    const gint64 offset = self->offset_ns;
    std::map<int, int64_t> trims;
    if (edits) trims = *self->trims;
    const std::string path = self->trace_location ? self->trace_location : "";
    self->edits_pending = self->trace_pending = FALSE;
    GST_OBJECT_UNLOCK(self);
    if (edits) {
        self->core->set_offset(offset);
        self->core->set_trims(trims);
    }
    if (retrace) restamp_set_trace(self, path);
}

/* --- messages ------------------------------------------------------------------------- */

static void restamp_post(GstMrtsRestamp* self, GstStructure* s) {
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
}

/* Part 10's mrtsrestamp-event, on occurrence. */
static void restamp_post_events(GstMrtsRestamp* self) {
    for (const RestampCore::Event& e : self->core->take_events()) {
        GST_DEBUG_OBJECT(self, "event %s program %d pid %d reason %s",
                         mrts::event_kind_name(e.kind), e.program, e.pid, e.reason);
        restamp_post(self, gst_structure_new(
            "mrtsrestamp-event", "kind", G_TYPE_STRING, mrts::event_kind_name(e.kind), "program",
            G_TYPE_INT, e.program, "pid", G_TYPE_INT, e.pid, "reason", G_TYPE_STRING,
            e.reason ? e.reason : "", "gap-ns", G_TYPE_INT64, (gint64)e.gap_ns, "dropped-ns",
            G_TYPE_INT64, (gint64)e.dropped_ns, "house-ns", G_TYPE_INT64, (gint64)e.house_ns,
            "epoch", G_TYPE_UINT, (guint)e.epoch, "value-ns", G_TYPE_INT64, (gint64)e.value_ns,
            NULL));
    }
}

/* Appends `s` to the array, which takes it. */
static void array_take(GValue* arr, GstStructure* s) {
    GValue v = G_VALUE_INIT;
    g_value_init(&v, GST_TYPE_STRUCTURE);
    g_value_take_boxed(&v, s);
    gst_value_array_append_and_take_value(arr, &v);
}

/* Part 10's mrtsrestamp-stats per program and mrtsrestamp-pid per PID; the snapshot and the
 * counter properties follow. The counters are totals since the start, in every program's
 * message alike. */
static void restamp_post_stats(GstMrtsRestamp* self) {
    const RestampCore::Stats s = self->core->stats();
    GValue programs = G_VALUE_INIT, pids = G_VALUE_INIT;
    g_value_init(&programs, GST_TYPE_ARRAY);
    g_value_init(&pids, GST_TYPE_ARRAY);
    for (const RestampCore::ProgramStats& p : s.programs) {
        const mrts::VirtualStc::Stats& c = p.clock;
        GstStructure* st = gst_structure_new(
            "mrtsrestamp-stats", "program", G_TYPE_INT, p.program, "state", G_TYPE_STRING,
            state_name(c.state), "reason", G_TYPE_STRING, mrts::reason_name(c.reason), "ppb",
            G_TYPE_INT64, (gint64)c.ppb, "offset-drift-ns", G_TYPE_INT64, (gint64)c.offset_drift_ns,
            "residual-min-ns", G_TYPE_INT64, (gint64)c.residual.min_ns, "residual-p50-ns",
            G_TYPE_INT64, (gint64)c.residual.p50_ns, "residual-p99-ns", G_TYPE_INT64,
            (gint64)c.residual.p99_ns, "residual-max-ns", G_TYPE_INT64, (gint64)c.residual.max_ns,
            "residual-count", G_TYPE_UINT, (guint)c.residual.count, "pcr-interval-max-ns",
            G_TYPE_INT64, (gint64)c.pcr_interval_max_ns, "cadence-warning", G_TYPE_BOOLEAN,
            (gboolean)c.cadence_warning, "rate-warning", G_TYPE_BOOLEAN, (gboolean)c.rate_warning,
            "relocks", G_TYPE_UINT64, (guint64)c.relocks, "epoch", G_TYPE_UINT, (guint)c.epoch,
            "gaps", G_TYPE_UINT64, (guint64)p.gaps, "gap-ns-total", G_TYPE_INT64,
            (gint64)p.gap_ns_total, "dropped-pes", G_TYPE_UINT64, (guint64)p.dropped_pes,
            "dropped-ns-total", G_TYPE_INT64, (gint64)p.dropped_ns_total, "cc-lost", G_TYPE_UINT64,
            (guint64)s.cc_lost, "desync-bytes", G_TYPE_UINT64, (guint64)s.desync_bytes, NULL);
        array_take(&programs, gst_structure_copy(st));
        restamp_post(self, st);
    }
    for (const RestampCore::PidStats& q : s.pids) {
        GstStructure* st = gst_structure_new(
            "mrtsrestamp-pid", "program", G_TYPE_INT, q.program, "pid", G_TYPE_INT, q.pid,
            "stream-type", G_TYPE_INT, q.stream_type, "lead-count", G_TYPE_UINT,
            (guint)q.lead_count, "trim-ns", G_TYPE_INT64, (gint64)q.trim_ns, "shift-ns",
            G_TYPE_INT64, (gint64)q.shift_ns, "dropped-pes", G_TYPE_UINT64, (guint64)q.dropped_pes,
            NULL);
        /* No PES yet: no lead, so the card shows none rather than 0. */
        if (q.lead_count > 0)
            gst_structure_set(st, "lead-min-ns", G_TYPE_INT64, (gint64)q.lead_min_ns,
                              "lead-median-ns", G_TYPE_INT64, (gint64)q.lead_median_ns,
                              "lead-max-ns", G_TYPE_INT64, (gint64)q.lead_max_ns, NULL);
        array_take(&pids, gst_structure_copy(st));
        restamp_post(self, st);
    }

    GstStructure* snap = gst_structure_new(
        "mrtsrestamp-stats", "mode", G_TYPE_STRING,
        s.mode == mrts::RestampConfig::Mode::fixed ? "fixed" : "stc", "arrival", G_TYPE_STRING,
        self->run_arrival == MRTSRESTAMP_ARRIVAL_CLOCK ? "clock" : "buffer-pts", "desync-bytes",
        G_TYPE_UINT64, (guint64)s.desync_bytes, "cc-lost", G_TYPE_UINT64, (guint64)s.cc_lost,
        "header-spans", G_TYPE_UINT64, (guint64)s.header_spans, "psi-unsupported-sections",
        G_TYPE_UINT64, (guint64)s.psi_unsupported_sections, "pes-no-pts", G_TYPE_UINT64,
        (guint64)s.pes_no_pts, "dts-discarded", G_TYPE_UINT64, (guint64)s.dts_discarded,
        "unmapped-pes", G_TYPE_UINT64, (guint64)s.unmapped_pes, "broken-spans", G_TYPE_UINT64,
        (guint64)s.broken_spans, "unknown-pid-packets", G_TYPE_UINT64,
        (guint64)s.unknown_pid_packets, "removed-packets", G_TYPE_UINT64,
        (guint64)s.removed_packets, "pcr-kept-packets", G_TYPE_UINT64,
        (guint64)s.pcr_kept_packets, "buffers", G_TYPE_UINT64, self->buffers, "lists",
        G_TYPE_UINT64, self->lists, "gap-markers", G_TYPE_UINT64, self->markers,
        "outage-markers", G_TYPE_UINT64, self->outage_markers, NULL);
    gst_structure_take_value(snap, "programs", &programs);
    gst_structure_take_value(snap, "pids", &pids);
    g_mutex_lock(&self->snap_lock);
    if (self->snapshot) gst_structure_free(self->snapshot);
    self->snapshot = snap;
    g_mutex_unlock(&self->snap_lock);

    MrtsHouseCounters k;   // no PesAssembler here: pes-oversize and pes-dropped-cc stay 0
    k.desync_bytes = s.desync_bytes;
    k.cc_lost = s.cc_lost;
    k.header_spans = s.header_spans;
    k.psi_unsupported_sections = s.psi_unsupported_sections;
    k.pes_no_pts = s.pes_no_pts;
    k.dts_discarded = s.dts_discarded;
    self->common.publish(k);
}

static gint64 restamp_interval_ns(GstMrtsRestamp* self) {
    return (gint64)self->stats_interval_ms.load(std::memory_order_relaxed) * GST_MSECOND;
}

/* Events at once; stats every stats-interval-ms of arrival time from the first buffer, or now
 * (`force`). */
static void restamp_report(GstMrtsRestamp* self, gint64 now, gboolean force) {
    restamp_post_events(self);
    if (!self->have_stats_at) {
        self->have_stats_at = TRUE;
        self->stats_at = now;
    }
    if (force || now - self->stats_at >= restamp_interval_ns(self)) {
        restamp_post_stats(self);
        self->stats_at = now;
    }
}

/* --- gap markers ---------------------------------------------------------------------- */

/* One marker: an adaptation-only packet per gap, its length in the private data. PTS: the
 * gaps' end on the bus convention. DTS: the input's own timeline, so a time-level queue
 * (GstQueue reads DTS before PTS) never moves on it, whatever the lead. No duration. */
static GstBuffer* restamp_marker(GstMrtsRestamp* self, const RestampCore::Gap* gaps, size_t n,
                                 GstClockTime dts) {
    GstBuffer* m = gst_buffer_new_allocate(NULL, n * mrts::PKT, NULL);
    GstMapInfo map;
    if (gst_buffer_map(m, &map, GST_MAP_WRITE)) {
        for (size_t i = 0; i < n; i++)
            mrts::build_gap_packet(gaps[i].pid, gaps[i].cc, gaps[i].end_ns - gaps[i].start_ns,
                                   map.data + i * mrts::PKT);
        gst_buffer_unmap(m, &map);
    }
    GST_BUFFER_PTS(m) = restamp_bus_pts(self, gaps[0].end_ns);
    GST_BUFFER_DTS(m) = dts;
    GST_BUFFER_DURATION(m) = GST_CLOCK_TIME_NONE;
    GST_BUFFER_FLAG_SET(m, GST_BUFFER_FLAG_GAP | GST_BUFFER_FLAG_DISCONT);
    self->markers++;
    GST_DEBUG_OBJECT(self, "gap marker: pid 0x%04x %s, %" G_GINT64_FORMAT " ns to %"
                     G_GINT64_FORMAT, gaps[0].pid, gaps[0].reason,
                     (gint64)(gaps[0].end_ns - gaps[0].start_ns), (gint64)gaps[0].end_ns);
    return m;
}

/* A piece of `data` between two markers: shared memory, the input's timestamps; its flags
 * and metas go with the first piece only. */
static GstBuffer* restamp_piece(GstBuffer* data, gsize off, gsize len, gboolean first) {
    GstBuffer* b = gst_buffer_copy_region(data, GST_BUFFER_COPY_MEMORY, off, len);
    if (first)
        gst_buffer_copy_into(b, data,
                             (GstBufferCopyFlags)(GST_BUFFER_COPY_FLAGS | GST_BUFFER_COPY_META), 0,
                             -1);
    GST_BUFFER_PTS(b) = GST_BUFFER_PTS(data);
    GST_BUFFER_DTS(b) = GST_BUFFER_DTS(data);
    return b;
}

/* One input buffer through the core, appended to `out` in stream order: its data, rewritten
 * in place unless something was removed, split around the markers it reveals. Takes `buf`. */
static void restamp_buffer(GstMrtsRestamp* self, GstBuffer* buf, gint64 arrival,
                           std::vector<GstBuffer*>& out) {
    buf = gst_buffer_make_writable(buf);
    GstMapInfo map;
    /* READWRITE copies shared memory first, so only this buffer's bytes are rewritten. */
    if (!gst_buffer_map(buf, &map, GST_MAP_READWRITE)) {
        if (!self->map_warned) {
            self->map_warned = TRUE;
            GST_ELEMENT_WARNING(self, STREAM, FAILED, ("Buffer will not map for writing"),
                                ("passed through on source time"));
        }
        out.push_back(buf);
        return;
    }
    const GstClockTime in_ts = GST_BUFFER_DTS_OR_PTS(buf);
    if (GST_CLOCK_TIME_IS_VALID(in_ts)) self->last_in_ts = in_ts;
    const RestampCore::Result res = self->core->process(map.data, map.size, arrival);
    self->have_arrival = TRUE;
    self->last_arrival = arrival;
    if (res.in_place && res.gaps.empty()) {   // the common case: no copy, nothing new
        gst_buffer_unmap(buf, &map);
        out.push_back(buf);
        return;
    }
    GstBuffer* data = buf;
    if (!res.in_place) {   // something removed: one copy of what stays
        data = gst_buffer_new_allocate(NULL, res.bytes(), NULL);
        gsize off = 0;
        for (const RestampCore::Range& r : res.keep)
            off += gst_buffer_fill(data, off, r.data, r.len);
        gst_buffer_copy_into(data, buf, GST_BUFFER_COPY_METADATA, 0, -1);
        gst_buffer_unmap(buf, &map);
        gst_buffer_unref(buf);
    } else {
        gst_buffer_unmap(buf, &map);
    }
    const gsize total = gst_buffer_get_size(data);
    if (res.gaps.empty()) {
        if (total > 0) out.push_back(data);
        else gst_buffer_unref(data);
        return;
    }
    const GstClockTime dts = GST_CLOCK_TIME_IS_VALID(in_ts) ? in_ts : self->last_in_ts;
    gsize from = 0;
    gboolean first = TRUE;
    for (const RestampCore::Gap& g : res.gaps) {
        const gsize at = MIN((gsize)g.at, total);
        if (at > from) {
            out.push_back(restamp_piece(data, from, at - from, first));
            first = FALSE;
            from = at;
        }
        out.push_back(restamp_marker(self, &g, 1, dts));
    }
    if (total > from) out.push_back(restamp_piece(data, from, total - from, first));
    gst_buffer_unref(data);
}

/* --- pads ----------------------------------------------------------------------------- */

/* `out` as one list, emptied. */
static GstFlowReturn restamp_push_list(GstMrtsRestamp* self, std::vector<GstBuffer*>& out) {
    GstBufferList* ol = gst_buffer_list_new_sized((guint)out.size());
    for (GstBuffer* b : out) gst_buffer_list_add(ol, b);
    out.clear();
    return gst_pad_push_list(self->srcpad, ol);
}

static GstFlowReturn restamp_chain(GstPad*, GstObject* parent, GstBuffer* buf) {
    GstMrtsRestamp* self = GST_MRTSRESTAMP(parent);
    if (!self->core) restamp_build(self);
    restamp_apply(self);
    gint64 now = 0;
    const gboolean have_clock =
        self->run_arrival == MRTSRESTAMP_ARRIVAL_CLOCK && restamp_clock_now(self, &now);
    self->buffers++;
    const gint64 arrival = restamp_arrival(self, buf, have_clock, now);
    std::vector<GstBuffer*>& out = *self->pieces;
    restamp_buffer(self, buf, arrival, out);
    restamp_report(self, arrival, FALSE);
    if (out.empty()) return GST_FLOW_OK;
    if (out.size() == 1) {
        GstBuffer* b = out[0];
        out.clear();
        return gst_pad_push(self->srcpad, b);
    }
    /* Markers: the buffer's pieces and markers leave as one list, so a time-level queue after
     * it takes or drops them together. Pushed one by one, the push behind a marker could leak
     * it: after an outage the input's own PTS jump reads as a full queue. */
    return restamp_push_list(self, out);
}

/* A list goes through buffer by buffer and leaves as one list, markers in place. */
static GstFlowReturn restamp_chain_list(GstPad*, GstObject* parent, GstBufferList* list) {
    GstMrtsRestamp* self = GST_MRTSRESTAMP(parent);
    if (!self->core) restamp_build(self);
    restamp_apply(self);
    gint64 now = 0;
    const gboolean have_clock =
        self->run_arrival == MRTSRESTAMP_ARRIVAL_CLOCK && restamp_clock_now(self, &now);
    self->lists++;
    /* The members held alone, so each is rewritten in place unless someone else holds it. */
    std::vector<GstBuffer*>& in = *self->members;
    const guint n = gst_buffer_list_length(list);
    for (guint i = 0; i < n; i++) in.push_back(gst_buffer_ref(gst_buffer_list_get(list, i)));
    gst_buffer_list_unref(list);
    std::vector<GstBuffer*>& out = *self->pieces;
    gint64 arrival = self->last_arrival;
    for (GstBuffer* b : in) {
        self->buffers++;
        arrival = restamp_arrival(self, b, have_clock, now);
        restamp_buffer(self, b, arrival, out);
    }
    in.clear();
    restamp_report(self, arrival, FALSE);
    return out.empty() ? GST_FLOW_OK : restamp_push_list(self, out);
}

static gboolean restamp_sink_event(GstPad* pad, GstObject* parent, GstEvent* event) {
    GstMrtsRestamp* self = GST_MRTSRESTAMP(parent);
    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_SEGMENT:
            gst_event_copy_segment(event, &self->segment);
            break;
        case GST_EVENT_FLUSH_STOP:
            /* Nothing from before the flush may join what follows (RestampCore::flush). */
            if (self->core) self->core->flush();
            gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
            self->eos = FALSE;
            break;
        case GST_EVENT_EOS:
            /* The last interval's numbers, and a trace whose count is patched in. */
            if (self->core) {
                restamp_report(self, self->last_arrival, TRUE);
                restamp_close_trace(self);
            }
            self->eos = TRUE;
            break;
        default:
            break;
    }
    return gst_pad_event_default(pad, parent, event);
}

/* --- the outage task (OQ-17) ---------------------------------------------------------- */

/* Under the stream lock. While the input is silent for 1 s or more: a marker at once, then
 * every 250 ms, each from the end of what every PID emitted to now (RestampCore::outage_gaps);
 * the clock may go lost and the stats keep their cadence. Sets the task's next sleep. */
static void restamp_outage_tick(GstMrtsRestamp* self) {
    self->task_wait_ns = OUTAGE_MARK_NS;
    gint64 now = 0;
    if (!self->core || self->run_arrival != MRTSRESTAMP_ARRIVAL_CLOCK || !self->have_arrival ||
        self->eos || !restamp_clock_now(self, &now))
        return;
    self->core->tick(now);
    gint64 wake;
    if (now - self->last_arrival >= RestampCore::OUTAGE_NS) {
        if (now >= self->next_mark) {
            const std::vector<RestampCore::Gap> gaps = self->core->outage_gaps(now);
            if (!gaps.empty()) {
                GstBuffer* m = restamp_marker(self, gaps.data(), gaps.size(), self->last_in_ts);
                self->outage_markers++;
                gst_pad_push(self->srcpad, m);
            }
            self->next_mark = now + OUTAGE_MARK_NS;
        }
        wake = self->next_mark;
    } else {
        wake = self->last_arrival + RestampCore::OUTAGE_NS;
    }
    restamp_report(self, now, FALSE);
    wake = MIN(wake, self->stats_at + restamp_interval_ns(self));
    self->task_wait_ns = CLAMP(wake - now, GST_MSECOND, TASK_MAX_WAIT_NS);
}

static void restamp_task_loop(gpointer data) {
    GstMrtsRestamp* self = GST_MRTSRESTAMP(data);
    g_mutex_lock(&self->wait_lock);
    const gint64 wait_ns = self->task_run ? self->task_wait_ns : 100 * GST_MSECOND;
    g_cond_wait_until(&self->wait_cond, &self->wait_lock, g_get_monotonic_time() + wait_ns / 1000);
    const gboolean run = self->task_run;
    g_mutex_unlock(&self->wait_lock);
    if (!run) return;
    /* Data in the chain is no outage: the task never waits on the streaming thread. */
    if (!GST_PAD_STREAM_TRYLOCK(self->sinkpad)) {
        self->task_wait_ns = 50 * GST_MSECOND;
        return;
    }
    restamp_outage_tick(self);
    GST_PAD_STREAM_UNLOCK(self->sinkpad);
}

static void restamp_task_start(GstMrtsRestamp* self) {
    g_mutex_lock(&self->wait_lock);
    self->task_run = TRUE;
    g_mutex_unlock(&self->wait_lock);
    if (!self->task) {
        self->task = gst_task_new(restamp_task_loop, self, NULL);
        gst_task_set_lock(self->task, &self->task_lock);
    }
    gst_task_start(self->task);
}

/* No join here: a push from the task may wait on a paused sink until the flush that follows. */
static void restamp_task_stop(GstMrtsRestamp* self) {
    g_mutex_lock(&self->wait_lock);
    self->task_run = FALSE;
    g_cond_signal(&self->wait_cond);
    g_mutex_unlock(&self->wait_lock);
    if (self->task) gst_task_stop(self->task);
}

static void restamp_task_join(GstMrtsRestamp* self) {
    if (!self->task) return;
    gst_task_join(self->task);
    gst_object_unref(self->task);
    self->task = NULL;
}

/* --- GObject -------------------------------------------------------------------------- */

/* A start counts from 0 and builds its core at its first buffer; no data flows yet. */
static void restamp_reset(GstMrtsRestamp* self) {
    delete self->core;
    self->core = NULL;
    self->trace_path->clear();
    gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
    self->base_ns = 0;
    self->have_arrival = FALSE;
    self->last_arrival = 0;
    self->last_in_ts = GST_CLOCK_TIME_NONE;
    self->have_stats_at = FALSE;
    self->stats_at = 0;
    self->eos = FALSE;
    self->next_mark = 0;
    self->map_warned = FALSE;
    self->buffers = self->lists = self->markers = self->outage_markers = 0;
    g_mutex_lock(&self->snap_lock);
    if (self->snapshot) gst_structure_free(self->snapshot);
    self->snapshot = NULL;
    g_mutex_unlock(&self->snap_lock);
    self->common.reset();
}

static GstStateChangeReturn restamp_change_state(GstElement* element, GstStateChange transition) {
    GstMrtsRestamp* self = GST_MRTSRESTAMP(element);
    switch (transition) {
        case GST_STATE_CHANGE_READY_TO_PAUSED:
            restamp_reset(self);
            break;
        case GST_STATE_CHANGE_PAUSED_TO_PLAYING:
            GST_OBJECT_LOCK(self);
            {
                const gboolean clock = self->arrival == MRTSRESTAMP_ARRIVAL_CLOCK;
                GST_OBJECT_UNLOCK(self);
                if (clock) restamp_task_start(self);
            }
            break;
        case GST_STATE_CHANGE_PLAYING_TO_PAUSED:
        case GST_STATE_CHANGE_PAUSED_TO_READY:
            restamp_task_stop(self);
            break;
        default:
            break;
    }
    const GstStateChangeReturn ret =
        GST_ELEMENT_CLASS(gst_mrtsrestamp_parent_class)->change_state(element, transition);
    if (transition == GST_STATE_CHANGE_PAUSED_TO_READY) {
        /* The pads are inactive: no chain runs and any push of the task has returned. */
        restamp_task_join(self);
        restamp_close_trace(self);
        delete self->core;
        self->core = NULL;
    }
    return ret;
}

static void restamp_set_property(GObject* object, guint prop_id, const GValue* value,
                                 GParamSpec* pspec) {
    GstMrtsRestamp* self = GST_MRTSRESTAMP(object);
    switch (prop_id) {
        case PROP_CLOCK_MODE:
            GST_OBJECT_LOCK(self);
            self->clock_mode = g_value_get_enum(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_ARRIVAL:
            GST_OBJECT_LOCK(self);
            self->arrival = g_value_get_enum(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_ADD_BASE_TIME:
            GST_OBJECT_LOCK(self);
            self->add_base_time = g_value_get_boolean(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_OFFSET_NS:
            GST_OBJECT_LOCK(self);
            self->offset_ns = g_value_get_int64(value);
            self->edits_pending = TRUE;
            GST_OBJECT_UNLOCK(self);
            self->dirty.store(true, std::memory_order_release);
            break;
        case PROP_PID_TRIMS: {
            std::map<int, int64_t> trims;
            std::string bad;
            const gchar* s = g_value_get_string(value);
            parse_trims(s, &trims, &bad);
            if (!bad.empty())
                GST_ELEMENT_WARNING(self, LIBRARY, SETTINGS,
                                    ("pid-trims: entries skipped: %s", bad.c_str()),
                                    ("want <pid>=<ns>;... with a PID of 0-8191"));
            GST_OBJECT_LOCK(self);
            g_free(self->pid_trims);
            self->pid_trims = g_strdup(s ? s : "");
            self->trims->swap(trims);
            self->edits_pending = TRUE;
            GST_OBJECT_UNLOCK(self);
            self->dirty.store(true, std::memory_order_release);
            break;
        }
        case PROP_STATS_INTERVAL_MS:
            self->stats_interval_ms.store(g_value_get_uint(value), std::memory_order_relaxed);
            break;
        case PROP_TRACE_LOCATION:
            GST_OBJECT_LOCK(self);
            g_free(self->trace_location);
            self->trace_location = g_value_dup_string(value);
            self->trace_pending = TRUE;
            GST_OBJECT_UNLOCK(self);
            self->dirty.store(true, std::memory_order_release);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static GstStructure* restamp_empty_stats(GstMrtsRestamp* self) {
    GValue empty = G_VALUE_INIT, empty2 = G_VALUE_INIT;
    g_value_init(&empty, GST_TYPE_ARRAY);
    g_value_init(&empty2, GST_TYPE_ARRAY);
    GST_OBJECT_LOCK(self);
    const gboolean fixed = self->clock_mode == MRTSRESTAMP_MODE_FIXED;
    const gboolean clock = self->arrival == MRTSRESTAMP_ARRIVAL_CLOCK;
    GST_OBJECT_UNLOCK(self);
    GstStructure* s =
        gst_structure_new("mrtsrestamp-stats", "mode", G_TYPE_STRING, fixed ? "fixed" : "stc",
                          "arrival", G_TYPE_STRING, clock ? "clock" : "buffer-pts", NULL);
    gst_structure_take_value(s, "programs", &empty);
    gst_structure_take_value(s, "pids", &empty2);
    return s;
}

static void restamp_get_property(GObject* object, guint prop_id, GValue* value, GParamSpec* pspec) {
    GstMrtsRestamp* self = GST_MRTSRESTAMP(object);
    if (self->common.get(prop_id, value)) return;
    switch (prop_id) {
        case PROP_CLOCK_MODE:
            GST_OBJECT_LOCK(self);
            g_value_set_enum(value, self->clock_mode);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_ARRIVAL:
            GST_OBJECT_LOCK(self);
            g_value_set_enum(value, self->arrival);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_ADD_BASE_TIME:
            GST_OBJECT_LOCK(self);
            g_value_set_boolean(value, self->add_base_time);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_OFFSET_NS:
            GST_OBJECT_LOCK(self);
            g_value_set_int64(value, self->offset_ns);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_PID_TRIMS:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->pid_trims);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_STATS_INTERVAL_MS:
            g_value_set_uint(value, self->stats_interval_ms.load(std::memory_order_relaxed));
            break;
        case PROP_TRACE_LOCATION:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->trace_location);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_STATS: {
            g_mutex_lock(&self->snap_lock);
            GstStructure* s = self->snapshot ? gst_structure_copy(self->snapshot) : NULL;
            g_mutex_unlock(&self->snap_lock);
            g_value_take_boxed(value, s ? s : restamp_empty_stats(self));
            break;
        }
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void restamp_finalize(GObject* object) {
    GstMrtsRestamp* self = GST_MRTSRESTAMP(object);
    restamp_task_stop(self);
    restamp_task_join(self);
    if (self->trace->is_open()) self->trace->close();
    delete self->core;
    delete self->trace;
    delete self->trace_path;
    delete self->trims;
    delete self->pieces;
    delete self->members;
    g_free(self->pid_trims);
    g_free(self->trace_location);
    if (self->snapshot) gst_structure_free(self->snapshot);
    g_mutex_clear(&self->snap_lock);
    g_rec_mutex_clear(&self->task_lock);
    g_mutex_clear(&self->wait_lock);
    g_cond_clear(&self->wait_cond);
    G_OBJECT_CLASS(gst_mrtsrestamp_parent_class)->finalize(object);
}

static GstPad* restamp_new_pad(GstMrtsRestamp* self, GstStaticPadTemplate* tmpl,
                               const gchar* name) {
    GstPad* pad = gst_pad_new_from_static_template(tmpl, name);
    /* Caps, allocation and scheduling are the neighbours' business: a transparent byte rewriter. */
    GST_PAD_SET_PROXY_CAPS(pad);
    GST_PAD_SET_PROXY_ALLOCATION(pad);
    GST_PAD_SET_PROXY_SCHEDULING(pad);
    gst_element_add_pad(GST_ELEMENT_CAST(self), pad);
    return pad;
}

static void gst_mrtsrestamp_init(GstMrtsRestamp* self) {
    new (&self->common) MrtsHouseCommon();
    new (&self->dirty) std::atomic<bool>(false);
    new (&self->stats_interval_ms) std::atomic<guint>(DEFAULT_STATS_INTERVAL_MS);
    self->clock_mode = MRTSRESTAMP_MODE_STC;
    self->arrival = MRTSRESTAMP_ARRIVAL_CLOCK;
    self->add_base_time = FALSE;
    self->offset_ns = 0;
    self->pid_trims = g_strdup("");
    self->trims = new std::map<int, int64_t>();
    self->trace_location = NULL;
    self->edits_pending = self->trace_pending = FALSE;
    self->core = NULL;
    self->run_arrival = MRTSRESTAMP_ARRIVAL_CLOCK;
    self->trace = new mrts::TraceWriter();
    self->trace_path = new std::string();
    self->pieces = new std::vector<GstBuffer*>();
    self->members = new std::vector<GstBuffer*>();
    self->snapshot = NULL;
    g_mutex_init(&self->snap_lock);
    self->task = NULL;
    g_rec_mutex_init(&self->task_lock);
    g_mutex_init(&self->wait_lock);
    g_cond_init(&self->wait_cond);
    self->task_run = FALSE;
    self->task_wait_ns = OUTAGE_MARK_NS;
    restamp_reset(self);

    self->sinkpad = restamp_new_pad(self, &restamp_sink_tmpl, "sink");
    gst_pad_set_chain_function(self->sinkpad, GST_DEBUG_FUNCPTR(restamp_chain));
    gst_pad_set_chain_list_function(self->sinkpad, GST_DEBUG_FUNCPTR(restamp_chain_list));
    gst_pad_set_event_function(self->sinkpad, GST_DEBUG_FUNCPTR(restamp_sink_event));
    self->srcpad = restamp_new_pad(self, &restamp_src_tmpl, "src");
}

static void gst_mrtsrestamp_class_init(GstMrtsRestampClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);

    gobject_class->set_property = restamp_set_property;
    gobject_class->get_property = restamp_get_property;
    gobject_class->finalize = restamp_finalize;
    element_class->change_state = restamp_change_state;

    const GParamFlags at_start =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY);
    const GParamFlags live =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_PLAYING);
    g_object_class_install_property(
        gobject_class, PROP_CLOCK_MODE,
        g_param_spec_enum("clock-mode", "Clock mode",
                          "stc: a virtual STC per program locked to the source PCR (network "
                          "ingests). fixed: house = PES - 1 h as received (+ the base time with "
                          "add-base-time), the captures. Applies at the next start.",
                          gst_mrtsrestamp_clock_mode_get_type(), MRTSRESTAMP_MODE_STC, at_start));
    g_object_class_install_property(
        gobject_class, PROP_ARRIVAL,
        g_param_spec_enum("arrival", "Arrival",
                          "clock: the pipeline clock - base time at chain entry, the instant the "
                          "transport hands the packets over. buffer-pts: the buffer's PTS, for "
                          "appsrc-driven tests and replays (no outage markers). Applies at the "
                          "next start.",
                          gst_mrtsrestamp_arrival_get_type(), MRTSRESTAMP_ARRIVAL_CLOCK, at_start));
    g_object_class_install_property(
        gobject_class, PROP_ADD_BASE_TIME,
        g_param_spec_boolean("add-base-time", "Add base time",
                             "fixed only: add the pipeline's base time to every PES and PCR "
                             "(video-encoder's natural base). Applies at the next start.",
                             FALSE, at_start));
    g_object_class_install_property(
        gobject_class, PROP_OFFSET_NS,
        g_param_spec_int64("offset-ns", "Ingest offset (ns)",
                           "O (design 5.5), live: per PID from its next PES; a positive change "
                           "leaves a gap marker, a negative one drops the overlap.",
                           -RestampCore::OFFSET_LIMIT_NS, RestampCore::OFFSET_LIMIT_NS, 0, live));
    g_object_class_install_property(
        gobject_class, PROP_PID_TRIMS,
        g_param_spec_string("pid-trims", "Per-PID trims",
                            "\"<pid>=<ns>;...\" on top of O, live, each clamped to +-2 s; a "
                            "malformed entry is skipped with a warning.",
                            "", live));
    g_object_class_install_property(
        gobject_class, PROP_STATS_INTERVAL_MS,
        g_param_spec_uint("stats-interval-ms", "Stats interval (ms)",
                          "Arrival time between mrtsrestamp-stats / mrtsrestamp-pid posts.", 10,
                          3600000, DEFAULT_STATS_INTERVAL_MS, live));
    g_object_class_install_property(
        gobject_class, PROP_TRACE_LOCATION,
        g_param_spec_string("trace-location", "Trace location",
                            "Record the arrival trace (.stct, WI-P1-2) to this file; empty: "
                            "off. Live: a new path starts a new trace at the next buffer.",
                            NULL, live));
    g_object_class_install_property(
        gobject_class, PROP_STATS,
        g_param_spec_boxed("stats", "Stats",
                           "The last stats post: the mrtsrestamp-stats and mrtsrestamp-pid "
                           "messages as `programs` and `pids`, the core's counters, buffers, "
                           "lists, gap-markers and outage-markers since the start.",
                           GST_TYPE_STRUCTURE,
                           (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));
    /* After our own: the common ids are clear of these (MrtsHouseCommon::PROP_BASE). */
    MrtsHouseCommon::install(gobject_class);

    gst_element_class_add_static_pad_template(element_class, &restamp_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &restamp_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router ingest restamp", "Filter/Network/MPEG-TS",
        "Rewrites MPEG-TS PES PTS/DTS and PCR in place onto house time (virtual STC or a "
        "constant), with the ingest offset and per-PID trims, and marks gaps on the bus",
        "Media Router <https://github.com/bccsa/media-router>");
}
