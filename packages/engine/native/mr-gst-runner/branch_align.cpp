#include "branch_align.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "ipc.h"
#include "json_util.h"
#include "mrts/ts_psi.h"
#include "mrts/ts_timeline.h"

namespace mr::align {

namespace {

// See the python runner for the field history behind every one of these.
constexpr int64_t MAX_LATE_NS = 4'000'000'000LL;
constexpr int64_t MAX_EARLY_NS = 1'000'000'000LL;
constexpr double SETTLE_MS = 3000.0;
constexpr size_t SAMPLES = 9;
constexpr double GIVEUP_MS = 15000.0;
constexpr int64_t MIN_NS = 2'000'000LL;
constexpr size_t HISTORY = 4096;
constexpr size_t KEY_BYTES = 64;

struct OpenAu {
    int64_t pts = -1;
    std::string payload;
    /** Payload bytes the PES length promises (0 = unbounded, video). */
    size_t need = 0;
    /** Started after the branch had seen PAT+PMT — else tsdemux discards it. */
    bool after_psi = false;
};

struct State {
    std::string name;
    GstElement* demux = nullptr;      // owned
    gulong pad_added_id = 0;
    std::mutex m;                     // byTail / open / k / samples / probes
    bool has_k = false;
    int64_t k = 0;
    int64_t ksamples = 0;
    /** pid -> (payload tail, PES PTS) of completed access units not yet handed
     *  back by the demuxer, in arrival order — joined by tail IN THAT ORDER. */
    std::map<int, std::deque<std::pair<std::string, int64_t>>> aus;
    std::map<int, bool> synced;   // pid -> its queue is in step with the demuxer
    bool seen_pat = false, seen_pmt = false;
    int64_t indexed = 0;
    std::map<int, OpenAu> open;
    GstPad* sink_pad = nullptr;       // owned
    gulong sink_probe_id = 0;
    int pending = 0;
    std::map<int, std::vector<int64_t>> samples;
    bool has_t0 = false;
    int64_t t0 = 0;
    std::atomic<bool> settled{false};
    bool done = false;
    std::vector<std::pair<GstPad*, gulong>> out_probes;   // pads owned (ref)
};

std::vector<std::shared_ptr<State>> g_states;

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, f);
    std::vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

/** tsdemux names pads `<media>_<programhex>_<pidhex>`; the PID is the last field. */
int pid_from_pad_name(const gchar* name) {
    if (!name) return -1;
    std::string s = name;
    size_t us = s.rfind('_');
    std::string tail = us == std::string::npos ? s : s.substr(us + 1);
    if (tail.empty()) return -1;
    char* end = nullptr;
    long v = std::strtol(tail.c_str(), &end, 16);
    return (end && *end == 0) ? (int)v : -1;
}

const char* verdict(int64_t off_ns) {
    if (off_ns > MAX_LATE_NS || -off_ns > MAX_EARLY_NS) return "reject";
    if (std::llabs(off_ns) < MIN_NS) return "skip";
    return "apply";
}

void rejected(const std::string& demux, int pid, int64_t off_ns) {
    ipc::warning(fmt("branchAlign: %s pid=0x%x sits %+.0f ms from its producer's stamps, past what the mux can "
                     "absorb — branch left as-is, so this track WILL be out of step with its siblings "
                     "(time-sync contract, ADR-0005)",
                     demux.c_str(), pid, off_ns / 1e6));
}

void close_au(State& st, int pid);

/** Close the open AU on `pid` once its PES length is satisfied: a PES WITH a
 *  length (audio, 302M, private data) is emitted by tsdemux the moment it is
 *  complete — inside the same bus buffer — so it has to be indexed THEN, not
 *  at the next PUSI (every one-AU-per-buffer 302M leg joined nothing until
 *  this existed; 10.9.16.50, 2026-09-17). Caller holds st.m. */
void complete_au(State& st, int pid) {
    auto it = st.open.find(pid);
    if (it == st.open.end() || it->second.need == 0 || it->second.payload.size() < it->second.need) return;
    it->second.payload.resize(it->second.need);
    close_au(st, pid);
}

// Caller holds st->m.
void close_au(State& st, int pid) {
    auto it = st.open.find(pid);
    if (it == st.open.end()) return;
    OpenAu rec = std::move(it->second);
    st.open.erase(it);
    if (rec.pts < 0 || rec.payload.size() < KEY_BYTES) return;
    if (!rec.after_psi) return;   // started before PAT+PMT: the demuxer discards it
    std::string tail = rec.payload.substr(rec.payload.size() - KEY_BYTES);
    auto& q = st.aus[pid];
    q.emplace_back(std::move(tail), rec.pts);
    if (q.size() > HISTORY) q.pop_front();
    st.indexed++;
}

/** The PTS of the access unit the demuxer just emitted on `pid`, joined by
 *  its payload tail IN EMISSION ORDER — or false. The caller joins EVERY
 *  emitted buffer so the queue stays in step with the demuxer; then the AU
 *  is the earliest pending entry with this tail (entries before it are AUs
 *  the demuxer discarded and go with it). Order is what makes a repeated
 *  tail decidable (silence, a test tone). The one join order cannot vouch
 *  for is a PID's FIRST when the match is not at the head: what sits ahead
 *  of it is a discard this index did not predict (pre-PSI AUs are never
 *  queued, so on a silent leg the head IS the first emitted AU), and on
 *  silence a repeated tail cannot say how many — so off the head, the first
 *  match must be UNIQUE among the pending entries or it decides nothing.
 *  Same rule as `_branch_align_join` in the python runner. Caller holds st.m. */
bool join_au(State& st, int pid, const std::string& tail, int64_t* pts) {
    auto qi = st.aus.find(pid);
    if (qi == st.aus.end()) return false;
    auto& q = qi->second;
    bool synced = st.synced[pid];
    long hit = -1;
    for (size_t i = 0; i < q.size(); i++) {
        if (q[i].first != tail) continue;
        if (hit < 0) {
            hit = (long)i;
            if (i == 0 || synced) break;
        } else {
            return false;   // first join, off the head, and the tail repeats: undecidable
        }
    }
    if (hit < 0) return false;
    *pts = q[(size_t)hit].second;
    q.erase(q.begin(), q.begin() + hit + 1);
    st.synced[pid] = true;
    return true;
}

/** One pass over the branch's TS: K and the payload-tail → PTS index. */
GstPadProbeReturn sink_probe_cb(GstPad*, GstPadProbeInfo* info, gpointer user) {
    std::shared_ptr<State> st = *static_cast<std::shared_ptr<State>*>(user);
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf) return GST_PAD_PROBE_OK;
    GstMapInfo mi;
    if (!gst_buffer_map(buf, &mi, GST_MAP_READ)) return GST_PAD_PROBE_OK;
    std::lock_guard<std::mutex> lock(st->m);
    if (st->done) {
        gst_buffer_unmap(buf, &mi);
        return GST_PAD_PROBE_OK;
    }
    int64_t first_pts = -1;
    for (size_t off = 0; off + mrts::PKT <= mi.size; off += mrts::PKT) {
        const uint8_t* pkt = mi.data + off;
        if (pkt[0] != mrts::SYNC_BYTE || !mrts::ts_has_payload(pkt)) continue;
        int poff = mrts::payload_offset(pkt);
        if (poff >= mrts::PKT) continue;
        int pid = mrts::ts_pid(pkt);
        if (mrts::ts_pusi(pkt)) {
            const uint8_t* p = pkt + poff;
            size_t plen = mrts::PKT - poff;
            if (plen < 14 || p[0] != 0x00 || p[1] != 0x00 || p[2] != 0x01) {
                // A PSI section: PAT on pid 0, PMT = table_id 0x02. The demuxer
                // emits nothing until it has both.
                size_t tid_at = (size_t)poff + 1 + p[0];
                if (pid == 0) st->seen_pat = true;
                else if (st->seen_pat && tid_at < mrts::PKT && pkt[tid_at] == 0x02) st->seen_pmt = true;
                continue;
            }
            int64_t pts = mrts::read_pes_pts(pkt);
            close_au(*st, pid);
            // K is measured from the buffer's FIRST PES: that is what the
            // producer's stamp maps, whatever the demuxer later emits.
            if (pts >= 0 && first_pts < 0) first_pts = pts;
            size_t hdr = 9 + (size_t)p[8];
            size_t data_off = (size_t)poff + hdr;
            size_t pes_len = ((size_t)p[4] << 8) | p[5];
            OpenAu au;
            au.pts = pts;
            au.need = (pes_len && 6 + pes_len > hdr) ? 6 + pes_len - hdr : 0;
            au.after_psi = st->seen_pat && st->seen_pmt;
            if (data_off < mrts::PKT) au.payload.assign((const char*)pkt + data_off, mrts::PKT - data_off);
            st->open[pid] = std::move(au);
            complete_au(*st, pid);
        } else {
            auto it = st->open.find(pid);
            if (it != st->open.end()) {
                it->second.payload.append((const char*)pkt + poff, mrts::PKT - poff);
                complete_au(*st, pid);
            }
        }
    }
    GstClockTime stamp = GST_BUFFER_PTS(buf);
    gst_buffer_unmap(buf, &mi);
    if (first_pts < 0 || !GST_CLOCK_TIME_IS_VALID(stamp)) return GST_PAD_PROBE_OK;
    int64_t k = (int64_t)stamp - mrts::pts90k_to_ns(first_pts);
    st->ksamples++;
    // MINIMUM, not latest: the monotone floor only ever pushes a stamp up.
    if (!st->has_k || k < st->k) {
        st->has_k = true;
        st->k = k;
    }
    return GST_PAD_PROBE_OK;
}

void delete_state_holder(gpointer p) { delete static_cast<std::shared_ptr<State>*>(p); }

// Caller holds st->m.
void release_sink_probe_locked(State& st) {
    if (st.pending || st.done) return;
    st.done = true;
    if (st.sink_probe_id && st.sink_pad) {
        gst_pad_remove_probe(st.sink_pad, st.sink_probe_id);
        st.sink_probe_id = 0;
    }
}

/** One branch is done measuring: drop every probe it armed. True for the ONE
 *  caller that settles it (the winner removes the sibling probes); a loser
 *  must return OK so the winner's remove is the only thing retiring it. */
bool finish(State& st, GstPad* pad) {
    std::vector<std::pair<GstPad*, gulong>> siblings;
    {
        std::lock_guard<std::mutex> lock(st.m);
        if (st.settled.load()) return false;
        st.settled.store(true);
        for (auto& [p, id] : st.out_probes) {
            if (p != pad && id) siblings.push_back({p, id});
            else if (p) gst_object_unref(p);
        }
        st.out_probes.clear();
        st.pending = 0;
        release_sink_probe_locked(st);
    }
    for (auto& [p, id] : siblings) {
        gst_pad_remove_probe(p, id);
        gst_object_unref(p);
    }
    return true;
}

struct OutProbe {
    std::shared_ptr<State> st;
    int pid;
};

void delete_out_probe(gpointer p) { delete static_cast<OutProbe*>(p); }

/** Sample this branch's error and, once it has settled, correct it. */
GstPadProbeReturn out_probe_cb(GstPad* pad, GstPadProbeInfo* info, gpointer user) {
    auto* op = static_cast<OutProbe*>(user);
    State& st = *op->st;
    int pid = op->pid;
    if (st.settled.load()) return GST_PAD_PROBE_OK;   // a winner is retiring us
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf) return GST_PAD_PROBE_OK;
    GstClockTime pts = GST_BUFFER_PTS(buf);

    std::vector<int64_t> window;
    double elapsed;
    int64_t k;
    size_t indexed;
    int64_t ksamples;
    {
        std::unique_lock<std::mutex> lock(st.m);
        // EVERY buffer joins, from the first, so the queue stays in step with
        // the demuxer (see join_au); only the settled window's joins sample.
        bool have_anchor = false;
        int64_t anchor = 0;
        gsize size = gst_buffer_get_size(buf);
        if (size >= KEY_BYTES) {
            char tail[KEY_BYTES];
            if (gst_buffer_extract(buf, size - KEY_BYTES, tail, KEY_BYTES) == KEY_BYTES)
                have_anchor = join_au(st, pid, std::string(tail, KEY_BYTES), &anchor);
        }
        if (!GST_CLOCK_TIME_IS_VALID(pts) || !st.has_k) return GST_PAD_PROBE_OK;
        if (!st.has_t0) {
            st.has_t0 = true;
            st.t0 = (int64_t)pts;
        }
        // Elapsed on the BRANCH's own timeline (its buffer PTS).
        elapsed = (double)((int64_t)pts - st.t0) / 1e6;
        if (elapsed < SETTLE_MS) return GST_PAD_PROBE_OK;   // still settling
        std::vector<int64_t>& samples = st.samples[pid];
        if (samples.size() < SAMPLES) {
            if (have_anchor) samples.push_back(st.k + mrts::pts90k_to_ns(anchor) - (int64_t)pts);
            if (samples.size() < SAMPLES) {
                if (elapsed <= GIVEUP_MS) return GST_PAD_PROBE_OK;
                size_t n = samples.size();
                lock.unlock();
                if (!finish(st, pad)) return GST_PAD_PROBE_OK;   // a sibling settled first
                ipc::log(fmt("branchAlign: %s pid=0x%x joined only %zu access units in %.0f ms — branch left "
                             "un-anchored",
                             st.name.c_str(), pid, n, elapsed));
                return GST_PAD_PROBE_REMOVE;
            }
        }
        window = samples;
        k = st.k;
        indexed = (size_t)st.indexed;
        ksamples = st.ksamples;
    }
    std::vector<int64_t> sorted = window;
    std::sort(sorted.begin(), sorted.end());
    int64_t off = sorted[sorted.size() / 2];
    int64_t spread = sorted.back() - sorted.front();
    if (!finish(st, pad)) return GST_PAD_PROBE_OK;   // a sibling settled first; it retires us
    std::string note;
    const char* v = verdict(off);
    if (std::string(v) == "reject") {
        note = " — REJECTED (past what the mux can absorb), branch left as-is";
        rejected(st.name, pid, off);
    } else if (std::string(v) == "skip") {
        note = " — already aligned, left untouched";
    } else {
        gst_pad_set_offset(pad, gst_pad_get_offset(pad) + off);
    }
    ipc::log(fmt("branchAlign: %s %s pid=0x%x offsetNs=%lld (%+.3f ms)%s (median of %zu joined AUs, spread %.3f ms, "
                 "K=%lld from %lld buffers, ausIndexed=%zu)",
                 st.name.c_str(), GST_PAD_NAME(pad), pid, (long long)off, off / 1e6, note.c_str(), window.size(),
                 spread / 1e6, (long long)k, (long long)ksamples, indexed));
    return GST_PAD_PROBE_REMOVE;
}

void pad_added_cb(GstElement*, GstPad* pad, gpointer user) {
    std::shared_ptr<State> st = *static_cast<std::shared_ptr<State>*>(user);
    const gchar* pad_name = GST_PAD_NAME(pad);
    if (!pad_name || !(g_str_has_prefix(pad_name, "audio_") || g_str_has_prefix(pad_name, "video_"))) return;
    int pid = pid_from_pad_name(pad_name);
    if (pid < 0) return;
    std::lock_guard<std::mutex> lock(st->m);
    if (st->settled.load() || st->done) return;   // nothing left to measure
    st->pending++;
    // A plain BUFFER probe, not a blocking one: the correction lands a few
    // seconds in and nothing may be held up waiting for it.
    gulong id = gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, out_probe_cb, new OutProbe{st, pid},
                                  delete_out_probe);
    st->out_probes.push_back({GST_PAD(gst_object_ref(pad)), id});
}

}  // namespace

void install(GstElement* pipe, JsonObject* cfg) {
    clear();
    if (!cfg || !GST_IS_BIN(pipe)) return;
    JsonArray* names = json_get_array(cfg, "demuxes");
    if (!names) return;
    guint n = json_array_get_length(names);
    for (guint i = 0; i < n; i++) {
        JsonNode* node = json_array_get_element(names, i);
        if (!JSON_NODE_HOLDS_VALUE(node)) continue;
        const gchar* name = json_node_get_string(node);
        if (!name || !*name) continue;
        GstElement* demux = gst_bin_get_by_name(GST_BIN(pipe), name);
        if (!demux) {
            ipc::log(fmt("branchAlign: element '%s' not found — branch left un-anchored", name));
            continue;
        }
        GstPad* sink = gst_element_get_static_pad(demux, "sink");
        if (!sink) {
            gst_object_unref(demux);
            continue;
        }
        auto st = std::make_shared<State>();
        st->name = name;
        st->demux = demux;
        st->sink_pad = sink;
        st->sink_probe_id = gst_pad_add_probe(sink, GST_PAD_PROBE_TYPE_BUFFER, sink_probe_cb,
                                              new std::shared_ptr<State>(st), delete_state_holder);
        st->pad_added_id = g_signal_connect_data(demux, "pad-added", G_CALLBACK(pad_added_cb),
                                                 new std::shared_ptr<State>(st), [](gpointer p, GClosure*) {
                                                     delete static_cast<std::shared_ptr<State>*>(p);
                                                 },
                                                 (GConnectFlags)0);
        g_states.push_back(st);
    }
}

void clear() {
    for (auto& st : g_states) {
        std::vector<std::pair<GstPad*, gulong>> probes;
        {
            std::lock_guard<std::mutex> lock(st->m);
            st->settled.store(true);
            st->done = true;
            probes.swap(st->out_probes);
            st->pending = 0;
            if (st->sink_probe_id && st->sink_pad) {
                gst_pad_remove_probe(st->sink_pad, st->sink_probe_id);
                st->sink_probe_id = 0;
            }
        }
        for (auto& [p, id] : probes) {
            if (id) gst_pad_remove_probe(p, id);
            gst_object_unref(p);
        }
        if (st->pad_added_id && st->demux) g_signal_handler_disconnect(st->demux, st->pad_added_id);
        st->pad_added_id = 0;
        if (st->sink_pad) gst_object_unref(st->sink_pad);
        st->sink_pad = nullptr;
        if (st->demux) gst_object_unref(st->demux);
        st->demux = nullptr;
    }
    g_states.clear();
}

}  // namespace mr::align
