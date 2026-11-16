/* mrtsegress (plan ch. 9 WI-P5-3, B-250): mrts::EgressCore as an element, the egress writer.
 * The input is mapped read only and never written: untouched runs leave as shared memory,
 * changed and inserted packets as new memories (part 4.2 step 9). A plain GstElement. */
#include <time.h>

#include <atomic>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#include "mrts/ts_egress.h"
#include "mrts/ts_hcdesc.h"
#include "mrtshouse.h"

#define GST_CAT_DEFAULT mrtshouse_debug

using mrts::EgressCore;

enum {
    PROP_0,
    PROP_HOUSE_CLOCK,
    PROP_TIMELINE_ID,
    PROP_PCR_INTERVAL_MS,
    PROP_D_E_MARGIN_MS,
    PROP_D_E_HEADROOM_MS,
    PROP_D_E_FLOOR_MS,
    PROP_D_E_MAX_MS,
    PROP_GAP_LOWER_MIN_MS,
    PROP_STATS_INTERVAL_MS,
    PROP_STATS,
    PROP_D_E_NS,
    PROP_EPOCH_SEQ,
};

#define DEFAULT_STATS_INTERVAL_MS 2000
/* proc-ns-per-packet: one buffer in this many is timed. */
#define PROC_SAMPLE_EVERY 64
/* The timer's longest sleep, so the stats keep their cadence through a silence. */
static const gint64 TASK_MAX_WAIT_NS = 100 * GST_MSECOND;

#define GST_TYPE_MRTSEGRESS (gst_mrtsegress_get_type())
G_DECLARE_FINAL_TYPE(GstMrtsEgress, gst_mrtsegress, GST, MRTSEGRESS, GstElement)

/* One run of the output: input bytes shared, or new packets in one memory. */
struct EgressPiece {
    bool shared;
    gsize off, len;            // shared: the input's bytes
    size_t first, count;       // new: indexes into the element's packet pointers
};

struct _GstMrtsEgress {
    GstElement parent;
    GstPad* sinkpad;
    GstPad* srcpad;

    /* Properties, under the object lock. house-clock and timeline-id raise `dirty`; the
     * streaming thread hands the declaration to the core at its next buffer. */
    gchar* house_clock;
    gchar* timeline_id;
    mrts::ClockDecl* decl;
    guint pcr_interval_ms, margin_ms, headroom_ms, floor_ms, max_ms, gap_lower_min_ms;
    std::atomic<bool> dirty;
    std::atomic<guint> stats_interval_ms;
    std::atomic<gint64> d_e_ns;
    std::atomic<guint> epoch_seq;

    /* Streaming state, under the sink pad's stream lock: chain, chain_list, serialized events
     * and the PCR timer, which only tries it. A state change resets it while nothing flows. */
    EgressCore* core;                       // null until the first buffer of a start
    GstSegment segment;
    gboolean have_now, eos;
    gint64 last_now;                        // the clock at the last buffer or tick
    gboolean have_stats_at;
    gint64 stats_at;
    std::vector<EgressPiece>* pieces;
    std::vector<const guint8*>* fresh;
    std::vector<GstBuffer*>* outs;
    guint64 buffers, lists, packets, bytes_in, bytes_out, merged_buffers, timer_pcrs, sampled;
    guint64 proc_ns_sum, proc_pkts;         // this interval's timed buffers

    GMutex snap_lock;
    GstStructure* snapshot;

    MrtsHouseCommon common;

    /* The PCR timer (F1): PCR-only packets while no buffer comes, started in PLAYING. */
    GstTask* task;
    GRecMutex task_lock;
    GMutex wait_lock;
    GCond wait_cond;
    gboolean task_run;
    gint64 task_wait_ns;                    // task thread only
};

G_DEFINE_TYPE(GstMrtsEgress, gst_mrtsegress, GST_TYPE_ELEMENT)

static GstStaticPadTemplate egress_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);
static GstStaticPadTemplate egress_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

/* --- the house-clock value -------------------------------------------------------------- */

static gboolean field_i64(const GstStructure* s, const gchar* name, gint64* out) {
    const GValue* v = gst_structure_get_value(s, name);
    if (!v) return FALSE;
    if (G_VALUE_HOLDS_INT64(v)) *out = g_value_get_int64(v);
    else if (G_VALUE_HOLDS_INT(v)) *out = g_value_get_int(v);
    else if (G_VALUE_HOLDS_UINT(v)) *out = g_value_get_uint(v);
    else if (G_VALUE_HOLDS_UINT64(v) && g_value_get_uint64(v) <= (guint64)G_MAXINT64)
        *out = (gint64)g_value_get_uint64(v);
    else return FALSE;
    return TRUE;
}

/* Part 4.6's serialised GstStructure into the declaration (timeline_id left as it is). An
 * empty value is no clock: E unknown. E is known when `e-ns` is present and not 0 (the engine
 * writes 0 while it has no epoch); `error-us` absent is an unknown error, no class claimed. */
static gboolean parse_house_clock(const gchar* text, mrts::ClockDecl* out) {
    mrts::ClockDecl c;
    c.timeline_id = out->timeline_id;
    if (!text || !*text) {
        *out = c;
        return TRUE;
    }
    GstStructure* s = gst_structure_from_string(text, NULL);
    if (!s || !gst_structure_has_name(s, "house-clock")) {
        if (s) gst_structure_free(s);
        return FALSE;
    }
    gint64 v = 0;
    gboolean b = FALSE;
    if (field_i64(s, "e-ns", &v)) {
        c.e_ns = v;
        c.known = v != 0;
    }
    if (field_i64(s, "seq", &v)) c.seq = v;
    if (gst_structure_get_boolean(s, "traceable", &b)) c.traceable = b;
    if (gst_structure_get_boolean(s, "disciplined", &b)) c.disciplined = b;
    const gchar* src = gst_structure_get_string(s, "source");
    c.source = !src ? mrts::hcdesc::SYNC_NONE
               : g_str_equal(src, "ntp") ? mrts::hcdesc::SYNC_NTP
               : g_str_equal(src, "sntp") ? mrts::hcdesc::SYNC_SNTP
               : g_str_equal(src, "ptp") ? mrts::hcdesc::SYNC_PTP
                                         : mrts::hcdesc::SYNC_NONE;
    if (field_i64(s, "error-us", &v) && v >= 0) c.error_us = v;
    if (field_i64(s, "tai-offset-s", &v)) c.tai_offset_s = v;
    if (field_i64(s, "ptp-domain", &v) && v >= -1 && v <= 255) c.ptp_domain = (int)v;
    const gchar* gm = gst_structure_get_string(s, "gm");
    uint64_t id = 0;
    if (gm && *gm && mrts::hcdesc::parse_gm(gm, &id)) c.gm = id;
    gst_structure_free(s);
    *out = c;
    return TRUE;
}

/* --- time ----------------------------------------------------------------------------- */

/* House time is CLOCK_MONOTONIC: the element's clock (both runners use the monotonic system
 * clock; a test sets its own), else the kernel's. */
static gint64 egress_now(GstClock* clock) {
    if (clock) {
        const GstClockTime t = gst_clock_get_time(clock);
        if (GST_CLOCK_TIME_IS_VALID(t)) return (gint64)t;
    }
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (gint64)ts.tv_sec * GST_SECOND + ts.tv_nsec;
}

/* The core's clock reader: every PCR written reads the clock anew (the index is ignored). */
class ElementClock : public mrts::ClockReader {
  public:
    explicit ElementClock(GstMrtsEgress* self) : clock_(gst_element_get_clock(GST_ELEMENT_CAST(self))) {}
    ~ElementClock() override {
        if (clock_) gst_object_unref(clock_);
    }
    int64_t read(size_t) const override { return egress_now(clock_); }

  private:
    GstClock* clock_;
};

/* --- the core ------------------------------------------------------------------------- */

static void egress_build(GstMrtsEgress* self) {
    mrts::EgressConfig cfg;
    GST_OBJECT_LOCK(self);
    cfg.pcr_interval_ns = (int64_t)self->pcr_interval_ms * GST_MSECOND;
    cfg.margin_ns = (int64_t)self->margin_ms * GST_MSECOND;
    cfg.headroom_ns = (int64_t)self->headroom_ms * GST_MSECOND;
    cfg.floor_ns = (int64_t)self->floor_ms * GST_MSECOND;
    cfg.max_ns = (int64_t)self->max_ms * GST_MSECOND;
    cfg.gap_lower_min_ns = (int64_t)self->gap_lower_min_ms * GST_MSECOND;
    GST_OBJECT_UNLOCK(self);
    self->core = new EgressCore(cfg);
    self->dirty.store(true, std::memory_order_relaxed);   // the declaration in force, at once
}

static void egress_apply(GstMrtsEgress* self) {
    if (!self->core) egress_build(self);
    if (!self->dirty.exchange(false, std::memory_order_acq_rel)) return;
    GST_OBJECT_LOCK(self);
    const mrts::ClockDecl d = *self->decl;
    GST_OBJECT_UNLOCK(self);
    self->core->set_clock(d);
    self->epoch_seq.store((guint)d.seq, std::memory_order_relaxed);
}

/* --- messages ------------------------------------------------------------------------- */

static void egress_post(GstMrtsEgress* self, GstStructure* s) {
    gst_element_post_message(GST_ELEMENT_CAST(self), gst_message_new_element(GST_OBJECT_CAST(self), s));
}

/* Part 10's mrtsegress-event, on occurrence; a D_e move refreshes `d-e-ns`. */
static void egress_post_events(GstMrtsEgress* self) {
    using K = mrts::EgressEvent::Kind;
    bool moved = false;
    for (const mrts::EgressEvent& e : self->core->take_events()) {
        GST_DEBUG_OBJECT(self, "event %s program %d", mrts::egress_event_name(e.kind), e.program);
        moved = moved || e.kind == K::d_e_start || e.kind == K::d_e_raise || e.kind == K::d_e_lower;
        egress_post(self, gst_structure_new(
            "mrtsegress-event", "kind", G_TYPE_STRING, mrts::egress_event_name(e.kind), "program",
            G_TYPE_INT, e.program, "pid", G_TYPE_INT, e.pid, "from-ns", G_TYPE_INT64, (gint64)e.from_ns,
            "to-ns", G_TYPE_INT64, (gint64)e.to_ns, "lateness-ns", G_TYPE_INT64, (gint64)e.lateness_ns,
            "gap-ns", G_TYPE_INT64, (gint64)e.gap_ns, "seq", G_TYPE_INT64, (gint64)e.seq, "from-seq",
            G_TYPE_INT64, (gint64)e.from_seq, "delta-ns", G_TYPE_INT64, (gint64)e.delta_ns, "in-packets",
            G_TYPE_INT, e.in_packets, "out-packets", G_TYPE_INT, e.out_packets, NULL));
    }
    if (moved) {
        const std::vector<int> progs = self->core->programs();
        mrts::EgressStats st;
        if (!progs.empty() && self->core->stats(progs[0], &st))
            self->d_e_ns.store(st.d_e_ns, std::memory_order_relaxed);
    }
}

static void array_take(GValue* arr, GstStructure* s) {
    GValue v = G_VALUE_INIT;
    g_value_init(&v, GST_TYPE_STRUCTURE);
    g_value_take_boxed(&v, s);
    gst_value_array_append_and_take_value(arr, &v);
}

/* Part 10's mrtsegress-stats per program: the lateness and PCR gap over this interval (raw:
 * below 0 when content is ahead of the clock; D_e reads max(0, it)), the rest totals since the
 * start, the element's in every program's message alike. Then the snapshot and counters. */
static void egress_post_stats(GstMrtsEgress* self) {
    GST_OBJECT_LOCK(self);
    const mrts::ClockDecl d = *self->decl;
    GST_OBJECT_UNLOCK(self);
    const std::string tl = mrts::hcdesc::timeline_text(d.timeline_id);
    const gint64 proc = self->proc_pkts ? (gint64)(self->proc_ns_sum / self->proc_pkts) : 0;
    self->proc_ns_sum = self->proc_pkts = 0;
    GValue programs = G_VALUE_INIT;
    g_value_init(&programs, GST_TYPE_ARRAY);
    const std::vector<int> progs = self->core->programs();
    for (int n : progs) {
        mrts::EgressStats st;
        mrts::EgressWindow w;
        if (!self->core->stats(n, &st) || !self->core->take_window(n, &w)) continue;
        GstStructure* s = gst_structure_new(
            "mrtsegress-stats", "program", G_TYPE_INT, n, "pcr-pid", G_TYPE_INT, st.pcr_pid, "d-e-ns",
            G_TYPE_INT64, (gint64)st.d_e_ns, "pcr-written", G_TYPE_UINT64, (guint64)st.pcr_written,
            "pcr-inserted", G_TYPE_UINT64, (guint64)st.pcr_inserted, "pcr-interval-max-ns", G_TYPE_INT64,
            (gint64)w.pcr_interval_max_ns, "pmt-rewritten", G_TYPE_UINT64, (guint64)st.pmt_sent,
            "pmt-version", G_TYPE_INT, st.pmt_version, "pes-rewritten", G_TYPE_UINT64,
            (guint64)st.pes_rewritten, "d-e-changes", G_TYPE_UINT64, (guint64)st.d_e_changes,
            "lateness-off-house", G_TYPE_UINT64, (guint64)st.lateness_off_house, "packets",
            G_TYPE_UINT64, self->packets, "bytes-in", G_TYPE_UINT64, self->bytes_in, "bytes-out",
            G_TYPE_UINT64, self->bytes_out, "epoch-seq", G_TYPE_UINT, (guint)d.seq, "traceable",
            G_TYPE_BOOLEAN, (gboolean)(d.known && d.traceable), "timeline-id", G_TYPE_STRING, tl.c_str(),
            "merged-buffers", G_TYPE_UINT64, self->merged_buffers, "proc-ns-per-packet", G_TYPE_INT64,
            proc, NULL);
        /* No timing PES this interval: no lateness, rather than 0. */
        if (w.lateness_n > 0)
            gst_structure_set(s, "lateness-min-ns", G_TYPE_INT64, (gint64)w.lateness_min_ns,
                              "lateness-mean-ns", G_TYPE_INT64, (gint64)(w.lateness_sum_ns / (int64_t)w.lateness_n),
                              "lateness-max-ns", G_TYPE_INT64, (gint64)w.lateness_max_ns, NULL);
        array_take(&programs, gst_structure_copy(s));
        egress_post(self, s);
        if (n == progs[0]) self->d_e_ns.store(st.d_e_ns, std::memory_order_relaxed);
    }
    const mrts::EgressCounters& c = self->core->counters();
    GstStructure* snap = gst_structure_new(
        "mrtsegress-stats", "buffers", G_TYPE_UINT64, self->buffers, "lists", G_TYPE_UINT64, self->lists,
        "packets", G_TYPE_UINT64, self->packets, "bytes-in", G_TYPE_UINT64, self->bytes_in, "bytes-out",
        G_TYPE_UINT64, self->bytes_out, "merged-buffers", G_TYPE_UINT64, self->merged_buffers,
        "timer-pcrs", G_TYPE_UINT64, self->timer_pcrs, "gap-markers", G_TYPE_UINT64, (guint64)c.gap_markers,
        "gaps", G_TYPE_UINT64, (guint64)c.gaps, "dropped-before-pmt", G_TYPE_UINT64,
        (guint64)c.dropped_before_pmt, "cc-lost-in", G_TYPE_UINT64, (guint64)c.cc_lost_in, "re-epochs",
        G_TYPE_UINT64, (guint64)c.re_epochs, "held", G_TYPE_UINT64, (guint64)c.held, "broken-spans",
        G_TYPE_UINT64, (guint64)self->core->broken_spans(), "epoch-seq", G_TYPE_UINT, (guint)d.seq,
        "timeline-id", G_TYPE_STRING, tl.c_str(), NULL);
    gst_structure_take_value(snap, "programs", &programs);
    g_mutex_lock(&self->snap_lock);
    if (self->snapshot) gst_structure_free(self->snapshot);
    self->snapshot = snap;
    g_mutex_unlock(&self->snap_lock);
    MrtsHouseCounters k;   // no PesAssembler, no PSI parser counts, no DTS check here
    k.desync_bytes = self->core->desync_bytes();
    k.cc_lost = c.cc_lost_in;
    k.header_spans = self->core->header_spans();
    self->common.publish(k);
}

/* Events at once; stats every stats-interval-ms of house time from the first buffer, or now. */
static void egress_report(GstMrtsEgress* self, gint64 now, gboolean force) {
    egress_post_events(self);
    if (!self->have_stats_at) {
        self->have_stats_at = TRUE;
        self->stats_at = now;
    }
    const gint64 every = (gint64)self->stats_interval_ms.load(std::memory_order_relaxed) * GST_MSECOND;
    if (force || now - self->stats_at >= every) {
        egress_post_stats(self);
        self->stats_at = now;
    }
}

/* --- output (part 4.2 step 9) ---------------------------------------------------------- */

static void piece_shared(GstMrtsEgress* self, gsize off) {
    std::vector<EgressPiece>& v = *self->pieces;
    if (!v.empty() && v.back().shared && v.back().off + v.back().len == off) {
        v.back().len += mrts::PKT;
        return;
    }
    v.push_back({true, off, mrts::PKT, 0, 0});
}

static void piece_new(GstMrtsEgress* self, const guint8* p) {
    std::vector<EgressPiece>& v = *self->pieces;
    std::vector<const guint8*>& f = *self->fresh;
    if (v.empty() || v.back().shared) v.push_back({false, 0, 0, f.size(), 0});
    f.push_back(p);
    v.back().count++;
}

/* One result's output: the input's untouched runs shared (no copy), each run of changed or
 * inserted packets one new memory; past GST_BUFFER_MEM_MAX memories, one copy of it all
 * (merged-buffers, pin F2). `in` may be NULL (a tick). NULL: nothing to send. */
static GstBuffer* egress_output(GstMrtsEgress* self, GstBuffer* in, const guint8* base, gsize size,
                                const mrts::EgressResult& r) {
    self->pieces->clear();
    self->fresh->clear();
    const size_t n = r.packets();
    auto pass = [&](size_t i) {
        const guint8* p = r.packet(i);
        if (base && p >= base && p + mrts::PKT <= base + size) piece_shared(self, (gsize)(p - base));
        else piece_new(self, p);   // joined across buffers: held by the result
    };
    size_t next = 0;               // EgressResult::apply's order
    for (const mrts::EgressEdit& e : r.edits()) {
        for (; next < e.index && next < n; next++) pass(next);
        if (e.op == mrts::EgressEdit::Op::insert) {
            piece_new(self, r.bytes(e));
            continue;
        }
        if (e.op == mrts::EgressEdit::Op::replace) piece_new(self, r.bytes(e));
        next = e.index + 1;
    }
    for (; next < n; next++) pass(next);
    const std::vector<EgressPiece>& pieces = *self->pieces;
    if (pieces.empty()) return NULL;
    if (in && pieces.size() == 1 && pieces[0].shared && pieces[0].off == 0 && pieces[0].len == size)
        return gst_buffer_ref(in);   // nothing changed: the input itself
    guint mems = 0;
    gsize total = 0;
    for (const EgressPiece& pc : pieces) {
        guint idx = 0, len = 1;
        gsize skip = 0;
        if (pc.shared && !gst_buffer_find_memory(in, pc.off, pc.len, &idx, &len, &skip)) len = 1;
        mems += len;
        total += pc.shared ? pc.len : pc.count * mrts::PKT;
    }
    GstBuffer* out;
    if (mems > gst_buffer_get_max_memory()) {
        out = gst_buffer_new_allocate(NULL, total, NULL);
        GstMapInfo m;
        if (gst_buffer_map(out, &m, GST_MAP_WRITE)) {
            guint8* w = m.data;
            for (const EgressPiece& pc : pieces) {
                if (pc.shared) {
                    std::memcpy(w, base + pc.off, pc.len);
                    w += pc.len;
                    continue;
                }
                for (size_t k = 0; k < pc.count; k++, w += mrts::PKT)
                    std::memcpy(w, (*self->fresh)[pc.first + k], mrts::PKT);
            }
            gst_buffer_unmap(out, &m);
        }
        self->merged_buffers++;
    } else {
        out = gst_buffer_new();
        for (const EgressPiece& pc : pieces) {
            if (pc.shared) {
                gst_buffer_copy_into(out, in, GST_BUFFER_COPY_MEMORY, pc.off, pc.len);
                continue;
            }
            GstMemory* mem = gst_allocator_alloc(NULL, pc.count * mrts::PKT, NULL);
            GstMapInfo m;
            if (gst_memory_map(mem, &m, GST_MAP_WRITE)) {
                for (size_t k = 0; k < pc.count; k++)
                    std::memcpy(m.data + k * mrts::PKT, (*self->fresh)[pc.first + k], mrts::PKT);
                gst_memory_unmap(mem, &m);
            }
            gst_buffer_append_memory(out, mem);
        }
    }
    if (in) gst_buffer_copy_into(out, in, GST_BUFFER_COPY_METADATA, 0, -1);
    return out;
}

/* A GAP buffer's PTS through upstream's segment, on the house timeline: the gap's end. */
static gint64 egress_gap_end(GstMrtsEgress* self, GstBuffer* buf, gint64 now) {
    if (!GST_BUFFER_PTS_IS_VALID(buf) || self->segment.format != GST_FORMAT_TIME) return now;
    const GstClockTime rt = gst_segment_to_running_time(&self->segment, GST_FORMAT_TIME, GST_BUFFER_PTS(buf));
    if (!GST_CLOCK_TIME_IS_VALID(rt)) return now;
    return (gint64)rt + (gint64)gst_element_get_base_time(GST_ELEMENT_CAST(self));
}

/* One input buffer through the core; its output, or NULL. Takes `buf`. A GAP buffer is a bus
 * marker (OQ-12): its markers are never sent (S8), but what the core inserts ahead of them (a
 * PMT and flagged PCR for a clock change) leaves untimestamped, without the GAP flag. */
static GstBuffer* egress_buffer(GstMrtsEgress* self, GstBuffer* buf, gint64 now, const ElementClock& clk) {
    GstMapInfo map;
    self->buffers++;
    if (!gst_buffer_map(buf, &map, GST_MAP_READ)) {
        GST_WARNING_OBJECT(self, "buffer will not map; dropped");
        gst_buffer_unref(buf);
        return NULL;
    }
    self->bytes_in += map.size;
    GstBuffer* out = NULL;
    if (GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_GAP)) {
        const mrts::EgressResult& r =
            self->core->on_gap(map.data, map.size, now, egress_gap_end(self, buf, now), clk);
        out = egress_output(self, NULL, NULL, 0, r);
    } else {
        const gboolean timed = self->sampled++ % PROC_SAMPLE_EVERY == 0;
        struct timespec t0, t1;
        if (timed) clock_gettime(CLOCK_MONOTONIC, &t0);
        const mrts::EgressResult& r = self->core->process(map.data, map.size, now, clk);
        self->packets += r.packets();
        out = egress_output(self, buf, map.data, map.size, r);
        if (timed && r.packets() > 0) {
            clock_gettime(CLOCK_MONOTONIC, &t1);
            self->proc_ns_sum += (guint64)((t1.tv_sec - t0.tv_sec) * GST_SECOND + (t1.tv_nsec - t0.tv_nsec));
            self->proc_pkts += r.packets();
        }
    }
    self->have_now = TRUE;
    self->last_now = now;
    gst_buffer_unmap(buf, &map);
    gst_buffer_unref(buf);
    if (out) self->bytes_out += gst_buffer_get_size(out);
    return out;
}

/* --- pads ----------------------------------------------------------------------------- */

static GstFlowReturn egress_chain(GstPad*, GstObject* parent, GstBuffer* buf) {
    GstMrtsEgress* self = GST_MRTSEGRESS(parent);
    egress_apply(self);
    const ElementClock clk(self);
    const gint64 now = clk.read(0);
    GstBuffer* out = egress_buffer(self, buf, now, clk);
    egress_report(self, now, FALSE);
    return out ? gst_pad_push(self->srcpad, out) : GST_FLOW_OK;
}

/* A list goes through buffer by buffer and leaves as one list, a marker or an emptied buffer
 * left out. */
static GstFlowReturn egress_chain_list(GstPad*, GstObject* parent, GstBufferList* list) {
    GstMrtsEgress* self = GST_MRTSEGRESS(parent);
    egress_apply(self);
    const ElementClock clk(self);
    gint64 now = clk.read(0);
    self->lists++;
    std::vector<GstBuffer*>& outs = *self->outs;
    const guint n = gst_buffer_list_length(list);
    for (guint i = 0; i < n; i++) {
        now = clk.read(0);
        GstBuffer* out = egress_buffer(self, gst_buffer_ref(gst_buffer_list_get(list, i)), now, clk);
        if (out) outs.push_back(out);
    }
    gst_buffer_list_unref(list);
    egress_report(self, now, FALSE);
    if (outs.empty()) return GST_FLOW_OK;
    GstBufferList* ol = gst_buffer_list_new_sized((guint)outs.size());
    for (GstBuffer* b : outs) gst_buffer_list_add(ol, b);
    outs.clear();
    return gst_pad_push_list(self->srcpad, ol);
}

static gboolean egress_sink_event(GstPad* pad, GstObject* parent, GstEvent* event) {
    GstMrtsEgress* self = GST_MRTSEGRESS(parent);
    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_SEGMENT:
            gst_event_copy_segment(event, &self->segment);
            break;
        case GST_EVENT_FLUSH_STOP:
            /* Nothing from before the flush joins what follows: a new core, D_e afresh, and
             * d-e-ns and the snapshot empty until it reports. */
            delete self->core;
            self->core = NULL;
            gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
            self->have_now = self->eos = self->have_stats_at = FALSE;
            self->d_e_ns.store(0, std::memory_order_relaxed);
            g_mutex_lock(&self->snap_lock);
            if (self->snapshot) gst_structure_free(self->snapshot);
            self->snapshot = NULL;
            g_mutex_unlock(&self->snap_lock);
            break;
        case GST_EVENT_EOS:
            /* A split header never completed leaves as it came, then the last numbers. */
            if (self->core) {
                std::vector<guint8> held;
                self->core->flush(held);
                if (!held.empty()) {
                    self->bytes_out += held.size();
                    const GstFlowReturn fr =
                        gst_pad_push(self->srcpad, gst_buffer_new_memdup(held.data(), held.size()));
                    if (fr != GST_FLOW_OK)
                        GST_DEBUG_OBJECT(self, "held bytes at EOS: %s", gst_flow_get_name(fr));
                }
                egress_report(self, self->last_now, TRUE);
            }
            self->eos = TRUE;
            break;
        default:
            break;
    }
    return gst_pad_event_default(pad, parent, event);
}

/* --- the PCR timer (F1) ----------------------------------------------------------------- */

/* Under the stream lock. Each program's PCR-only packet once due with no buffer to carry it,
 * so a sparse or silent bus keeps the PCR interval (TR 101 290); the stats keep their cadence.
 * Sets the task's next sleep: the next PCR instant. */
static void egress_timer_tick(GstMrtsEgress* self) {
    self->task_wait_ns = TASK_MAX_WAIT_NS;
    if (!self->core || !self->have_now || self->eos) return;
    const ElementClock clk(self);
    const gint64 now = clk.read(0);
    if (self->core->pcr_due_at() <= now) {
        const mrts::EgressResult& r = self->core->tick(now, clk);
        const size_t made = r.edits().size();
        GstBuffer* out = egress_output(self, NULL, NULL, 0, r);
        if (out) {
            self->timer_pcrs += made;
            self->bytes_out += gst_buffer_get_size(out);
            gst_pad_push(self->srcpad, out);
        }
        self->last_now = now;
    }
    egress_report(self, now, FALSE);
    const gint64 due = self->core->pcr_due_at();
    const gint64 every = (gint64)self->stats_interval_ms.load(std::memory_order_relaxed) * GST_MSECOND;
    gint64 wait = MIN(TASK_MAX_WAIT_NS, self->stats_at + every - now);
    if (due != G_MAXINT64) wait = due <= now ? GST_MSECOND : MIN(wait, due - now);
    self->task_wait_ns = CLAMP(wait, GST_MSECOND, TASK_MAX_WAIT_NS);
}

static void egress_task_loop(gpointer data) {
    GstMrtsEgress* self = GST_MRTSEGRESS(data);
    g_mutex_lock(&self->wait_lock);
    const gint64 wait_ns = self->task_run ? self->task_wait_ns : TASK_MAX_WAIT_NS;
    g_cond_wait_until(&self->wait_cond, &self->wait_lock, g_get_monotonic_time() + wait_ns / 1000);
    const gboolean run = self->task_run;
    g_mutex_unlock(&self->wait_lock);
    if (!run) return;
    /* Data in the chain carries its own PCRs: the timer never waits on the streaming thread. */
    if (!GST_PAD_STREAM_TRYLOCK(self->sinkpad)) {
        self->task_wait_ns = GST_MSECOND;
        return;
    }
    egress_timer_tick(self);
    GST_PAD_STREAM_UNLOCK(self->sinkpad);
}

static void egress_task_start(GstMrtsEgress* self) {
    g_mutex_lock(&self->wait_lock);
    self->task_run = TRUE;
    g_mutex_unlock(&self->wait_lock);
    if (!self->task) {
        self->task = gst_task_new(egress_task_loop, self, NULL);
        gst_task_set_lock(self->task, &self->task_lock);
    }
    gst_task_start(self->task);
}

/* No join here: a push from the task may wait on a paused sink until the flush that follows. */
static void egress_task_stop(GstMrtsEgress* self) {
    g_mutex_lock(&self->wait_lock);
    self->task_run = FALSE;
    g_cond_signal(&self->wait_cond);
    g_mutex_unlock(&self->wait_lock);
    if (self->task) gst_task_stop(self->task);
}

static void egress_task_join(GstMrtsEgress* self) {
    if (!self->task) return;
    gst_task_join(self->task);
    gst_object_unref(self->task);
    self->task = NULL;
}

/* --- GObject -------------------------------------------------------------------------- */

static void egress_reset(GstMrtsEgress* self) {
    delete self->core;
    self->core = NULL;
    gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
    self->have_now = self->eos = self->have_stats_at = FALSE;
    self->last_now = self->stats_at = 0;
    self->buffers = self->lists = self->packets = self->bytes_in = self->bytes_out = 0;
    self->merged_buffers = self->timer_pcrs = self->sampled = self->proc_ns_sum = self->proc_pkts = 0;
    self->d_e_ns.store(0, std::memory_order_relaxed);
    g_mutex_lock(&self->snap_lock);
    if (self->snapshot) gst_structure_free(self->snapshot);
    self->snapshot = NULL;
    g_mutex_unlock(&self->snap_lock);
    self->common.reset();
}

static GstStateChangeReturn egress_change_state(GstElement* element, GstStateChange transition) {
    GstMrtsEgress* self = GST_MRTSEGRESS(element);
    switch (transition) {
        case GST_STATE_CHANGE_READY_TO_PAUSED:
            egress_reset(self);
            break;
        case GST_STATE_CHANGE_PAUSED_TO_PLAYING:
            egress_task_start(self);
            break;
        case GST_STATE_CHANGE_PLAYING_TO_PAUSED:
        case GST_STATE_CHANGE_PAUSED_TO_READY:
            egress_task_stop(self);
            break;
        default:
            break;
    }
    const GstStateChangeReturn ret =
        GST_ELEMENT_CLASS(gst_mrtsegress_parent_class)->change_state(element, transition);
    if (transition == GST_STATE_CHANGE_PAUSED_TO_READY) {
        /* The pads are inactive: no chain runs and any push of the task has returned. */
        egress_task_join(self);
        delete self->core;
        self->core = NULL;
    }
    return ret;
}

static void egress_set_uint(GstMrtsEgress* self, guint* field, const GValue* value) {
    GST_OBJECT_LOCK(self);
    *field = g_value_get_uint(value);
    GST_OBJECT_UNLOCK(self);
}

static void egress_set_property(GObject* object, guint prop_id, const GValue* value, GParamSpec* pspec) {
    GstMrtsEgress* self = GST_MRTSEGRESS(object);
    switch (prop_id) {
        case PROP_HOUSE_CLOCK: {
            const gchar* s = g_value_get_string(value);
            GST_OBJECT_LOCK(self);
            mrts::ClockDecl d = *self->decl;
            const gboolean ok = parse_house_clock(s, &d);
            if (ok) {
                *self->decl = d;
                g_free(self->house_clock);
                self->house_clock = g_strdup(s ? s : "");
            }
            GST_OBJECT_UNLOCK(self);
            if (!ok) {
                GST_ELEMENT_WARNING(self, LIBRARY, SETTINGS, ("house-clock not understood; the last value is kept"),
                                    ("not a house-clock structure: %s", s));
                break;
            }
            self->dirty.store(true, std::memory_order_release);
            break;
        }
        case PROP_TIMELINE_ID: {
            const gchar* s = g_value_get_string(value);
            uint64_t id = 0;
            const gboolean ok = !s || !*s || mrts::hcdesc::parse_timeline_text(s, &id);
            if (!ok) {
                GST_ELEMENT_WARNING(self, LIBRARY, SETTINGS, ("timeline-id not understood; the last value is kept"),
                                    ("want 16 lower-case hex digits: %s", s));
                break;
            }
            GST_OBJECT_LOCK(self);
            self->decl->timeline_id = id;
            g_free(self->timeline_id);
            self->timeline_id = g_strdup(s && *s ? s : "");
            GST_OBJECT_UNLOCK(self);
            self->dirty.store(true, std::memory_order_release);
            break;
        }
        case PROP_PCR_INTERVAL_MS: egress_set_uint(self, &self->pcr_interval_ms, value); break;
        case PROP_D_E_MARGIN_MS: egress_set_uint(self, &self->margin_ms, value); break;
        case PROP_D_E_HEADROOM_MS: egress_set_uint(self, &self->headroom_ms, value); break;
        case PROP_D_E_FLOOR_MS: egress_set_uint(self, &self->floor_ms, value); break;
        case PROP_D_E_MAX_MS: egress_set_uint(self, &self->max_ms, value); break;
        case PROP_GAP_LOWER_MIN_MS: egress_set_uint(self, &self->gap_lower_min_ms, value); break;
        case PROP_STATS_INTERVAL_MS:
            self->stats_interval_ms.store(g_value_get_uint(value), std::memory_order_relaxed);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void egress_get_uint(GstMrtsEgress* self, const guint* field, GValue* value) {
    GST_OBJECT_LOCK(self);
    g_value_set_uint(value, *field);
    GST_OBJECT_UNLOCK(self);
}

static void egress_get_property(GObject* object, guint prop_id, GValue* value, GParamSpec* pspec) {
    GstMrtsEgress* self = GST_MRTSEGRESS(object);
    if (self->common.get(prop_id, value)) return;
    switch (prop_id) {
        case PROP_HOUSE_CLOCK:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->house_clock);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_TIMELINE_ID:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->timeline_id);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_PCR_INTERVAL_MS: egress_get_uint(self, &self->pcr_interval_ms, value); break;
        case PROP_D_E_MARGIN_MS: egress_get_uint(self, &self->margin_ms, value); break;
        case PROP_D_E_HEADROOM_MS: egress_get_uint(self, &self->headroom_ms, value); break;
        case PROP_D_E_FLOOR_MS: egress_get_uint(self, &self->floor_ms, value); break;
        case PROP_D_E_MAX_MS: egress_get_uint(self, &self->max_ms, value); break;
        case PROP_GAP_LOWER_MIN_MS: egress_get_uint(self, &self->gap_lower_min_ms, value); break;
        case PROP_STATS_INTERVAL_MS:
            g_value_set_uint(value, self->stats_interval_ms.load(std::memory_order_relaxed));
            break;
        case PROP_STATS: {
            g_mutex_lock(&self->snap_lock);
            GstStructure* s = self->snapshot ? gst_structure_copy(self->snapshot) : NULL;
            g_mutex_unlock(&self->snap_lock);
            if (!s) {
                GValue empty = G_VALUE_INIT;
                g_value_init(&empty, GST_TYPE_ARRAY);
                s = gst_structure_new_empty("mrtsegress-stats");
                gst_structure_take_value(s, "programs", &empty);
            }
            g_value_take_boxed(value, s);
            break;
        }
        case PROP_D_E_NS: g_value_set_int64(value, self->d_e_ns.load(std::memory_order_relaxed)); break;
        case PROP_EPOCH_SEQ: g_value_set_uint(value, self->epoch_seq.load(std::memory_order_relaxed)); break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void egress_finalize(GObject* object) {
    GstMrtsEgress* self = GST_MRTSEGRESS(object);
    egress_task_stop(self);
    egress_task_join(self);
    delete self->core;
    delete self->decl;
    delete self->pieces;
    delete self->fresh;
    delete self->outs;
    g_free(self->house_clock);
    g_free(self->timeline_id);
    if (self->snapshot) gst_structure_free(self->snapshot);
    g_mutex_clear(&self->snap_lock);
    g_rec_mutex_clear(&self->task_lock);
    g_mutex_clear(&self->wait_lock);
    g_cond_clear(&self->wait_cond);
    G_OBJECT_CLASS(gst_mrtsegress_parent_class)->finalize(object);
}

static GstPad* egress_new_pad(GstMrtsEgress* self, GstStaticPadTemplate* tmpl, const gchar* name) {
    GstPad* pad = gst_pad_new_from_static_template(tmpl, name);
    /* Caps, allocation and scheduling are the neighbours' business: a TS byte rewriter. */
    GST_PAD_SET_PROXY_CAPS(pad);
    GST_PAD_SET_PROXY_ALLOCATION(pad);
    GST_PAD_SET_PROXY_SCHEDULING(pad);
    gst_element_add_pad(GST_ELEMENT_CAST(self), pad);
    return pad;
}

static void gst_mrtsegress_init(GstMrtsEgress* self) {
    const mrts::EgressConfig cfg;
    new (&self->common) MrtsHouseCommon();
    new (&self->dirty) std::atomic<bool>(false);
    new (&self->stats_interval_ms) std::atomic<guint>(DEFAULT_STATS_INTERVAL_MS);
    new (&self->d_e_ns) std::atomic<gint64>(0);
    new (&self->epoch_seq) std::atomic<guint>(0);
    self->house_clock = g_strdup("");
    self->timeline_id = g_strdup("");
    self->decl = new mrts::ClockDecl();
    self->pcr_interval_ms = (guint)(cfg.pcr_interval_ns / GST_MSECOND);
    self->margin_ms = (guint)(cfg.margin_ns / GST_MSECOND);
    self->headroom_ms = (guint)(cfg.headroom_ns / GST_MSECOND);
    self->floor_ms = (guint)(cfg.floor_ns / GST_MSECOND);
    self->max_ms = (guint)(cfg.max_ns / GST_MSECOND);
    self->gap_lower_min_ms = (guint)(cfg.gap_lower_min_ns / GST_MSECOND);
    self->core = NULL;
    self->pieces = new std::vector<EgressPiece>();
    self->fresh = new std::vector<const guint8*>();
    self->outs = new std::vector<GstBuffer*>();
    self->snapshot = NULL;
    g_mutex_init(&self->snap_lock);
    self->task = NULL;
    g_rec_mutex_init(&self->task_lock);
    g_mutex_init(&self->wait_lock);
    g_cond_init(&self->wait_cond);
    self->task_run = FALSE;
    self->task_wait_ns = TASK_MAX_WAIT_NS;
    egress_reset(self);

    self->sinkpad = egress_new_pad(self, &egress_sink_tmpl, "sink");
    gst_pad_set_chain_function(self->sinkpad, GST_DEBUG_FUNCPTR(egress_chain));
    gst_pad_set_chain_list_function(self->sinkpad, GST_DEBUG_FUNCPTR(egress_chain_list));
    gst_pad_set_event_function(self->sinkpad, GST_DEBUG_FUNCPTR(egress_sink_event));
    self->srcpad = egress_new_pad(self, &egress_src_tmpl, "src");
}

static void gst_mrtsegress_class_init(GstMrtsEgressClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);

    gobject_class->set_property = egress_set_property;
    gobject_class->get_property = egress_get_property;
    gobject_class->finalize = egress_finalize;
    element_class->change_state = egress_change_state;

    const GParamFlags at_start =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY);
    const GParamFlags live =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_PLAYING);
    const GParamFlags ro = (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS);
    const mrts::EgressConfig cfg;
    g_object_class_install_property(
        gobject_class, PROP_HOUSE_CLOCK,
        g_param_spec_string("house-clock", "House clock",
                            "The engine's E and sync state as a serialised GstStructure (plan ch. 9 "
                            "part 4.6), live: applied at the next buffer; a seq or E change is a "
                            "re-epoch on the wire. Empty: E unknown (0, not TAI).",
                            "", live));
    g_object_class_install_property(
        gobject_class, PROP_TIMELINE_ID,
        g_param_spec_string("timeline-id", "Timeline id",
                            "The sender timeline the descriptor declares, 16 lower-case hex digits "
                            "(S27); empty: none. Live, from the next buffer.",
                            "", live));
    g_object_class_install_property(
        gobject_class, PROP_PCR_INTERVAL_MS,
        g_param_spec_uint("pcr-interval-ms", "PCR interval (ms)",
                          "A PCR on each program's PCR PID at least this often, inserted when the "
                          "input has none due (ISO 13818-1: at most 40). Applies at the next start.",
                          10, 40, (guint)(cfg.pcr_interval_ns / GST_MSECOND), at_start));
    g_object_class_install_property(
        gobject_class, PROP_D_E_MARGIN_MS,
        g_param_spec_uint("d-e-margin-ms", "D_e margin (ms)",
                          "The egress delay is the lateness plus this and the clock error, in "
                          "10 ms steps (part 4.4). Applies at the next start.",
                          0, 10000, (guint)(cfg.margin_ns / GST_MSECOND), at_start));
    g_object_class_install_property(
        gobject_class, PROP_D_E_HEADROOM_MS,
        g_param_spec_uint("d-e-headroom-ms", "D_e headroom (ms)",
                          "D_e is raised when the lateness comes within this of it. Applies at the "
                          "next start.",
                          0, 10000, (guint)(cfg.headroom_ns / GST_MSECOND), at_start));
    g_object_class_install_property(
        gobject_class, PROP_D_E_FLOOR_MS,
        g_param_spec_uint("d-e-floor-ms", "D_e floor (ms)",
                          "D_e never goes below this. Applies at the next start.", 0, 60000,
                          (guint)(cfg.floor_ns / GST_MSECOND), at_start));
    g_object_class_install_property(
        gobject_class, PROP_D_E_MAX_MS,
        g_param_spec_uint("d-e-max-ms", "D_e max (ms)",
                          "D_e is held at this, with a d-e-max event (OQ-36, a hook); 0: none. "
                          "Applies at the next start.",
                          0, 60000, (guint)(cfg.max_ns / GST_MSECOND), at_start));
    g_object_class_install_property(
        gobject_class, PROP_GAP_LOWER_MIN_MS,
        g_param_spec_uint("gap-lower-min-ms", "Gap for lowering (ms)",
                          "A bus silence this long counts as a gap, which may lower D_e at the "
                          "next PES as a gap marker does. Applies at the next start.",
                          1, 60000, (guint)(cfg.gap_lower_min_ns / GST_MSECOND), at_start));
    g_object_class_install_property(
        gobject_class, PROP_STATS_INTERVAL_MS,
        g_param_spec_uint("stats-interval-ms", "Stats interval (ms)",
                          "House time between mrtsegress-stats posts.", 10, 3600000,
                          DEFAULT_STATS_INTERVAL_MS, live));
    g_object_class_install_property(
        gobject_class, PROP_STATS,
        g_param_spec_boxed("stats", "Stats",
                           "The last stats post: each program's mrtsegress-stats as `programs`, the "
                           "core's counters, buffers, lists, bytes, merged-buffers and timer-pcrs "
                           "since the start.",
                           GST_TYPE_STRUCTURE, ro));
    g_object_class_install_property(
        gobject_class, PROP_D_E_NS,
        g_param_spec_int64("d-e-ns", "D_e (ns)", "The first program's egress delay; 0 before it starts.",
                           0, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_EPOCH_SEQ,
        g_param_spec_uint("epoch-seq", "Epoch seq", "The house-clock seq the writer applied last.", 0,
                          G_MAXUINT, 0, ro));
    /* After our own: the common ids are clear of these (MrtsHouseCommon::PROP_BASE). */
    MrtsHouseCommon::install(gobject_class);

    gst_element_class_add_static_pad_template(element_class, &egress_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &egress_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router egress writer", "Filter/Network/MPEG-TS",
        "Puts a bus MPEG-TS on the network timeline: PES PTS/DTS and PCR on TAI, the PCR cadence, "
        "the egress delay D_e and the house-time descriptor in each PMT",
        "Media Router <https://github.com/bccsa/media-router>");
}
