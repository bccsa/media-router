#include "branch_retime.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "branch_align.h"
#include "ipc.h"
#include "mrts/ts_psi.h"
#include "mrts/ts_timeline.h"

namespace mr::align::rt {

namespace {

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, f);
    std::vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

constexpr int64_t EPS_NS = 1'000'000;         // two readings of one mapping agree within this
constexpr int64_t BACK_TICKS = 90'000;        // a PES continues its PID from −1 s …
constexpr int64_t FWD_TICKS = 450'000;        // … to +5 s of the last one (the stamper's watch)
constexpr size_t EPOCHS = 4;                  // stamp epochs remembered
constexpr int64_t STEP_LOG_NS = 20'000'000;   // K moves past this are logged
constexpr double HOLD_MS = 1000.0;            // start-up input hold bound, in stamp time …
constexpr size_t HOLD_BUFFERS = 4096;         // … and in buffers
constexpr size_t TAIL = KEY_BYTES + 184;      // payload window kept per open AU
constexpr int64_t JOIN_TOL_NS = 5'000'000;    // a repeated tail is told apart by tsdemux's PTS
constexpr int64_t WRAP = 1LL << 33;

/** One stamp epoch: the span over which K = stamp − ns(PES) holds. */
struct Epoch {
    int seq = 0;
    bool has_k = false, has_read = false, has_ub = false, has_pred = false;
    int64_t k = 0, last_read = 0, ub = 0, pred = 0;
    std::map<int, int64_t> last, lastd, cad;   // pid -> PTS, decode time, its step (unwrapped)
    int64_t reads = 0;
};
using EpochP = std::shared_ptr<Epoch>;

/** An indexed access unit: its epoch, PTS/DTS unwrapped on it, K once exact. */
struct Au {
    EpochP e;
    int64_t u = 0, du = 0, k = 0;
    bool has_du = false, has_k = false;
};
using AuP = std::shared_ptr<Au>;

struct Open {
    AuP au;
    std::string tail;     // the last payload bytes received
    size_t got = 0;       // payload bytes so far
    size_t need = 0;      // PES length promise (0 = unbounded, video)
    bool after_psi = false;
};

struct Pad {
    int pid = -1;
    bool has_off = false, has_delta = false, logged = false;
    int64_t off = 0;      // tsdemux PTS − ns(PES) of the last joined AU
    int64_t delta = 0;    // output − tsdemux PTS of the last retimed AU
};

/** Which PES a producer stamps a buffer by — learned, see `learn`. */
enum class Rule { UNKNOWN, FIRST_TIMING_PES, FIRST_PCR_PID_PES };

struct State {
    std::string name;
    GstElement* demux = nullptr;   // owned
    gulong pad_added_id = 0;
    GstPad* sink_pad = nullptr;    // owned until clear()
    std::mutex m;                  // everything below
    bool has_prev = false;
    int64_t prev_stamp = 0;
    int pcr_pid = -1;
    Rule rule = Rule::UNKNOWN;
    EpochP amb_e;                  // last ambiguous moved buffer: its epoch, both candidates
    int64_t amb_a = 0, amb_b = 0;
    std::vector<EpochP> epochs;
    std::map<int, EpochP> pid_epoch;
    int seq = 0;
    bool exact = false;
    std::map<int, std::deque<std::pair<std::string, AuP>>> aus;   // the join, per pid
    std::map<int, bool> synced;
    std::map<int, Open> open;
    bool seen_pat = false, seen_pmt = false;
    int64_t indexed = 0;
    std::vector<GstBuffer*> held;  // owned refs
    bool has_hold_t0 = false;
    int64_t hold_t0 = 0;
    bool released = false;
    std::atomic<bool> releasing{false};
    std::vector<std::string> logs;   // written once st.m is dropped
};

std::vector<std::shared_ptr<State>> g_retime;

int64_t fold33(int64_t d) {
    d %= WRAP;
    if (d < 0) d += WRAP;
    return d > WRAP / 2 ? d - WRAP : d;
}

int64_t ns(int64_t t) { return mrts::pts90k_to_ns(t); }

// Caller holds st.m.
void rlog(State& st, const std::string& msg) { st.logs.push_back("branchAlign: " + st.name + " retime: " + msg); }

void emit_logs(State& st) {
    std::vector<std::string> lines;
    {
        std::lock_guard<std::mutex> lock(st.m);
        lines.swap(st.logs);
    }
    for (auto& l : lines) ipc::log(l);
}

/** An epoch's best K: exact, else predicted, else its upper bound. */
bool epoch_k(const Epoch& e, int64_t* k) {
    if (e.has_k)
        *k = e.k;
    else if (e.has_pred)
        *k = e.pred;
    else if (e.has_ub)
        *k = e.ub;
    else
        return false;
    return true;
}

void note(Epoch& e, int pid, int64_t u, const Au& au) {
    int64_t dec = au.has_du ? au.du : u;
    auto ld = e.lastd.find(pid);
    if (ld != e.lastd.end() && dec - ld->second > 0 && dec - ld->second <= FWD_TICKS) e.cad[pid] = dec - ld->second;
    e.last[pid] = u;
    e.lastd[pid] = dec;
}

/** The Au of one PES. Continuous with its PID: same epoch. Else the newest later
 *  epoch it is coherent with, else a fresh one predicted to carry on where the
 *  PID left off (until its first exact reading). Caller holds st.m. */
AuP on_pes(State& st, int pid, int64_t pts, bool has_dts, int64_t dts) {
    auto make = [&](const EpochP& e, int64_t u) {
        auto au = std::make_shared<Au>();
        au->e = e;
        au->u = u;
        if (has_dts) {
            au->has_du = true;
            au->du = u + fold33(dts - pts);
        }
        note(*e, pid, u, *au);
        return au;
    };
    EpochP e;
    auto pe = st.pid_epoch.find(pid);
    if (pe != st.pid_epoch.end()) {
        e = pe->second;
        int64_t d = fold33(pts - e->last[pid]);
        if (d >= -BACK_TICKS && d <= FWD_TICKS) return make(e, e->last[pid] + d);
    }
    auto it = e ? std::find(st.epochs.begin(), st.epochs.end(), e) : st.epochs.end();
    size_t from = it == st.epochs.end() ? 0 : (size_t)(it - st.epochs.begin()) + 1;
    for (size_t i = st.epochs.size(); i-- > from;) {
        EpochP c = st.epochs[i];
        for (auto& [qpid, q] : c->last) {
            int64_t d = fold33(pts - q);
            if (d >= -FWD_TICKS && d <= FWD_TICKS) {
                st.pid_epoch[pid] = c;
                return make(c, q + d);
            }
        }
    }
    auto fresh = std::make_shared<Epoch>();
    fresh->seq = st.seq++;
    if (e) {
        int64_t k;
        if (epoch_k(*e, &k)) {
            int64_t dec = has_dts ? pts + fold33(dts - pts) : pts;
            auto cad = e->cad.find(pid);
            fresh->has_pred = true;
            fresh->pred = k + ns(e->lastd[pid] + (cad == e->cad.end() ? 0 : cad->second) - dec);
        }
        rlog(st, fmt("pid=0x%x PTS discontinuity %+.3f s — stamp epoch #%d%s", pid,
                     fold33(pts - e->last[pid]) / 90000.0, fresh->seq,
                     fresh->has_pred ? ", predicted to continue the last" : ""));
    }
    st.epochs.push_back(fresh);
    if (st.epochs.size() > EPOCHS) st.epochs.erase(st.epochs.begin(), st.epochs.end() - EPOCHS);
    st.pid_epoch[pid] = fresh;
    return make(fresh, pts);
}

/** One exact reading. K = the lower of the last two: a lone high reading (a
 *  clamped stamp read as moved after a bus drop) never lands, a real step does
 *  one reading later, a drop (latch repair) at once. Caller holds st.m. */
void read(State& st, Epoch& e, int64_t s) {
    e.reads++;
    int64_t k = e.has_read ? std::min(e.last_read, s) : s;
    e.has_read = true;
    e.last_read = s;
    if (!e.has_k) {
        st.exact = true;
        if (e.has_pred) rlog(st, fmt("epoch #%d on its stamps, %+.3f ms off the prediction", e.seq, (k - e.pred) / 1e6));
    } else if (std::llabs(k - e.k) > STEP_LOG_NS) {
        rlog(st, fmt("epoch #%d K moved %+.3f ms (the producer re-anchored)", e.seq, (k - e.k) / 1e6));
    }
    e.has_k = true;
    e.k = k;
}

void bound(Epoch& e, int64_t s) {
    if (!e.has_ub || s < e.ub) {
        e.has_ub = true;
        e.ub = s;
    }
}

/** Which PES stamps a buffer, from the one candidate that agreed. Set once;
 *  flipped only against a K that the last reading confirmed. Caller holds st.m. */
void learn(State& st, const Epoch& e, bool ma, bool mb) {
    if (ma == mb) return;
    Rule rule = ma ? Rule::FIRST_TIMING_PES : Rule::FIRST_PCR_PID_PES;
    if (st.rule == rule) return;
    if (st.rule != Rule::UNKNOWN && (!e.has_read || !e.has_k || std::llabs(e.last_read - e.k) > EPS_NS)) return;
    st.rule = rule;
    st.amb_e.reset();
    rlog(st, std::string("the producer stamps a buffer by its ") + (ma ? "first timing PES" : "first PCR-PID PES"));
}

/** Fold one bus buffer's stamp into its epoch. `a` = its first timing-eligible
 *  PES, `b` = its first PCR-PID PES (either null). A stamp equal to the previous
 *  one may be the floor's: it only bounds K. Caller holds st.m. */
void sample(State& st, int64_t stamp, const AuP& a, const AuP& b) {
    bool moved = st.has_prev && stamp != st.prev_stamp;
    st.has_prev = true;
    st.prev_stamp = stamp;
    if (!a) return;
    Epoch& e = *a->e;
    int64_t ca = stamp - ns(a->u);
    if (!b || b == a) {
        if (!moved) {
            bound(e, ca);
            return;
        }
        if (st.rule == Rule::UNKNOWN && st.amb_e == a->e)
            learn(st, e, std::llabs(ca - st.amb_a) <= EPS_NS, std::llabs(ca - st.amb_b) <= EPS_NS);
        read(st, e, ca);
        return;
    }
    if (b->e != a->e) return;   // straddles a discontinuity
    int64_t cb = stamp - ns(b->u);
    if (!moved) {
        bound(e, std::max(ca, cb));
        return;
    }
    if (e.has_k)
        learn(st, e, std::llabs(ca - e.k) <= EPS_NS, std::llabs(cb - e.k) <= EPS_NS);
    else if (st.amb_e == a->e)
        learn(st, e, std::llabs(ca - st.amb_a) <= EPS_NS, std::llabs(cb - st.amb_b) <= EPS_NS);
    if (st.rule == Rule::UNKNOWN) {
        st.amb_e = a->e;
        st.amb_a = ca;
        st.amb_b = cb;
        bound(e, std::max(ca, cb));
        return;
    }
    read(st, e, st.rule == Rule::FIRST_TIMING_PES ? ca : cb);
}

/** K for an access unit leaving the demuxer: exact as of its own buffer, else
 *  its epoch's best. Caller holds st.m. */
bool k_for(const Au& au, int64_t* k) {
    if (au.has_k) {
        *k = au.k;
        return true;
    }
    return epoch_k(*au.e, k);
}

/** `join_au` for one pad, robust to repeated tails: an entry whose PES sits at
 *  the pad's last (tsdemux PTS − PES) offset wins, so an entry tsdemux discarded
 *  (a continuity gap) is skipped; else the order rule. Caller holds st.m. */
AuP join(State& st, Pad& ps, const std::string& tail, bool has_ts, int64_t ts) {
    auto qi = st.aus.find(ps.pid);
    if (qi == st.aus.end() || qi->second.empty()) return nullptr;
    auto& q = qi->second;
    bool timed = ps.has_off && has_ts;
    bool synced = st.synced[ps.pid];
    long hit = -1;
    for (size_t i = 0; i < q.size(); i++) {
        if (q[i].first != tail) continue;
        if (timed && std::llabs(ts - ns(q[i].second->u) - ps.off) <= JOIN_TOL_NS) {
            hit = (long)i;
            break;
        }
        if (hit < 0) {
            hit = (long)i;
            if (!timed && (i == 0 || synced)) break;
        } else if (!timed && !synced) {
            return nullptr;   // first join, off the head, and the tail repeats
        }
    }
    if (hit < 0) return nullptr;
    AuP au = q[(size_t)hit].second;
    q.erase(q.begin(), q.begin() + hit + 1);
    st.synced[ps.pid] = true;
    if (has_ts) {
        ps.has_off = true;
        ps.off = ts - ns(au->u);
    }
    return au;
}

// Caller holds st.m.
void close_au(State& st, int pid) {
    auto it = st.open.find(pid);
    if (it == st.open.end()) return;
    Open rec = std::move(it->second);
    st.open.erase(it);
    if (!rec.after_psi || rec.got == 0) return;   // before PAT+PMT: tsdemux discards it
    auto& q = st.aus[pid];
    size_t n = std::min(rec.tail.size(), KEY_BYTES);
    q.emplace_back(rec.tail.substr(rec.tail.size() - n), rec.au);
    if (q.size() > HISTORY) q.pop_front();
    st.indexed++;
}

// Caller holds st.m.
void add(State& st, int pid, const uint8_t* p, size_t n) {
    auto it = st.open.find(pid);
    if (it == st.open.end()) return;
    Open& rec = it->second;
    rec.tail.append((const char*)p, n);
    rec.got += n;
    if (rec.tail.size() > TAIL) rec.tail.erase(0, rec.tail.size() - TAIL);
    if (rec.need && rec.got >= rec.need) {
        // A length-bearing PES leaves tsdemux the moment it is complete.
        size_t over = rec.got - rec.need;
        if (over) rec.tail.resize(rec.tail.size() - over);
        close_au(st, pid);
    }
}

/** One bus buffer: stamp readings + a payload-tail join of every access unit.
 *  Caller holds st.m. */
void index(State& st, GstBuffer* buf) {
    GstMapInfo mi;
    if (!gst_buffer_map(buf, &mi, GST_MAP_READ)) return;
    struct Head {
        int pid;
        const uint8_t* pkt;
        AuP au;
    };
    std::vector<Head> heads;   // wire order
    for (size_t off = 0; off + mrts::PKT <= mi.size; off += mrts::PKT) {
        const uint8_t* pkt = mi.data + off;
        if (pkt[0] != mrts::SYNC_BYTE) continue;
        int pid = mrts::ts_pid(pkt);
        if ((pkt[3] & 0x20) && pkt[4] >= 7 && (pkt[5] & 0x10)) st.pcr_pid = pid;
        if (!mrts::ts_has_payload(pkt)) continue;
        int poff = mrts::payload_offset(pkt);
        if (poff >= mrts::PKT) continue;
        if (!mrts::ts_pusi(pkt)) {
            add(st, pid, pkt + poff, (size_t)(mrts::PKT - poff));
            continue;
        }
        const uint8_t* p = pkt + poff;
        size_t plen = (size_t)(mrts::PKT - poff);
        if (plen < 14 || p[0] != 0x00 || p[1] != 0x00 || p[2] != 0x01) {
            size_t tid_at = (size_t)poff + 1 + p[0];   // PSI: PAT on pid 0, then a PMT (table 0x02)
            if (pid == 0)
                st.seen_pat = true;
            else if (st.seen_pat && tid_at < (size_t)mrts::PKT && pkt[tid_at] == 0x02)
                st.seen_pmt = true;
            continue;
        }
        close_au(st, pid);
        int64_t pts = mrts::read_pes_pts(pkt);
        if (pts < 0) continue;
        bool has_dts = (p[7] & 0xC0) == 0xC0 && plen >= 19;
        int64_t dts = has_dts ? ((((int64_t)p[14] >> 1) & 0x07) << 30) | ((int64_t)p[15] << 22) |
                                    (((int64_t)p[16] >> 1) << 15) | ((int64_t)p[17] << 7) | ((int64_t)p[18] >> 1)
                              : 0;
        AuP au = on_pes(st, pid, pts, has_dts, dts);
        size_t hdr = 9 + (size_t)p[8];
        size_t pes_len = ((size_t)p[4] << 8) | p[5];
        Open rec;
        rec.au = au;
        rec.need = (pes_len && 6 + pes_len > hdr) ? 6 + pes_len - hdr : 0;
        rec.after_psi = st.seen_pat && st.seen_pmt;
        st.open[pid] = std::move(rec);
        heads.push_back({pid, pkt, au});
        if (hdr < plen) add(st, pid, p + hdr, plen - hdr);
    }
    if (GST_BUFFER_PTS_IS_VALID(buf)) {
        AuP a, b;
        for (auto& h : heads) {
            if (!a && mrts::timing_pes(h.pkt, h.pid, st.pcr_pid)) a = h.au;
            if (!b && h.pid == st.pcr_pid) b = h.au;
        }
        sample(st, (int64_t)GST_BUFFER_PTS(buf), a, b);
    }
    for (auto& h : heads) {
        if (h.au->e->has_k) {   // the mapping this AU's own stamp says
            h.au->has_k = true;
            h.au->k = h.au->e->k;
        }
    }
    gst_buffer_unmap(buf, &mi);
}

/** Take the held bus buffers for re-chaining. Caller holds st.m. */
std::vector<GstBuffer*> take_held(State& st, const std::string& how) {
    std::vector<GstBuffer*> held;
    held.swap(st.held);
    st.released = true;
    int64_t k;
    bool hk = !st.epochs.empty() && epoch_k(*st.epochs.back(), &k);
    rlog(st, fmt("released %s (%zu bus buffers held), K=%s — every access unit leaves at K + its PES", how.c_str(),
                 held.size(), hk ? std::to_string(k).c_str() : "None"));
    return held;
}

/** Back into the demuxer, in order, under the stream lock this probe holds. */
void chain_held(State& st, GstPad* pad, std::vector<GstBuffer*>& held) {
    if (held.empty()) return;
    st.releasing.store(true);
    for (GstBuffer* b : held) gst_pad_chain(pad, b);   // takes our ref
    st.releasing.store(false);
}

GstPadProbeReturn sink_cb(GstPad* pad, GstPadProbeInfo* info, gpointer user) {
    std::shared_ptr<State> st = *static_cast<std::shared_ptr<State>*>(user);
    if (!(info->type & GST_PAD_PROBE_TYPE_BUFFER)) {
        GstEvent* ev = GST_PAD_PROBE_INFO_EVENT(info);
        if (!ev) return GST_PAD_PROBE_OK;
        if (GST_EVENT_TYPE(ev) == GST_EVENT_EOS) {
            std::vector<GstBuffer*> held;
            {
                std::lock_guard<std::mutex> lock(st->m);
                if (!st->held.empty()) held = take_held(*st, "at end of stream");
                std::vector<int> pids;
                for (auto& kv : st->open) pids.push_back(kv.first);
                for (int pid : pids) close_au(*st, pid);   // tsdemux flushes what it still holds
            }
            chain_held(*st, pad, held);
            emit_logs(*st);
        } else if (GST_EVENT_TYPE(ev) == GST_EVENT_FLUSH_STOP) {
            std::lock_guard<std::mutex> lock(st->m);
            for (GstBuffer* b : st->held) gst_buffer_unref(b);
            st->held.clear();
            st->open.clear();
            st->aus.clear();
            st->synced.clear();
        }
        return GST_PAD_PROBE_OK;
    }
    if (st->releasing.load()) return GST_PAD_PROBE_OK;   // a held buffer going back in
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf) return GST_PAD_PROBE_OK;
    std::vector<GstBuffer*> held;
    bool hold_this = false;
    {
        std::lock_guard<std::mutex> lock(st->m);
        index(*st, buf);
        if (!st->released) {
            GstClockTime stamp = GST_BUFFER_PTS(buf);
            if (!st->has_hold_t0 && GST_CLOCK_TIME_IS_VALID(stamp)) {
                st->has_hold_t0 = true;
                st->hold_t0 = (int64_t)stamp;
            }
            double held_ms = st->has_hold_t0 && GST_CLOCK_TIME_IS_VALID(stamp)
                                 ? (double)((int64_t)stamp - st->hold_t0) / 1e6
                                 : 0.0;
            if (st->exact) {
                held = take_held(*st, "on the first exact stamp reading");
            } else if (held_ms >= HOLD_MS || st->held.size() >= HOLD_BUFFERS) {
                held = take_held(*st, fmt("WITHOUT an exact stamp reading after %.0f ms — the first access units "
                                          "sit on its upper bound",
                                          held_ms));
            } else {
                st->held.push_back(gst_buffer_ref(buf));
                hold_this = true;
            }
        }
    }
    emit_logs(*st);
    if (hold_this) return GST_PAD_PROBE_DROP;   // our ref keeps it
    chain_held(*st, pad, held);                 // this buffer follows the held ones
    return GST_PAD_PROBE_OK;
}

struct OutArg {
    std::shared_ptr<State> st;
    Pad pad;
};

void delete_out_arg(gpointer p) { delete static_cast<OutArg*>(p); }

/** Rewrite one demuxed buffer to K + its PES; unjoined, tsdemux's own timestamp
 *  carried by the pad's last correction (logged once per pad). */
GstPadProbeReturn out_cb(GstPad* pad, GstPadProbeInfo* info, gpointer user) {
    auto* oa = static_cast<OutArg*>(user);
    State& st = *oa->st;
    Pad& ps = oa->pad;
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf) return GST_PAD_PROBE_OK;
    GstClockTime pts = GST_BUFFER_PTS(buf), dts = GST_BUFFER_DTS(buf);
    bool has_out = false;
    int64_t out = 0, k = 0, dts_out = 0;
    bool has_dts_out = false;
    gsize size = gst_buffer_get_size(buf);
    {
        std::lock_guard<std::mutex> lock(st.m);
        AuP au;
        if (size) {
            size_t n = std::min<size_t>(size, KEY_BYTES);
            std::string tail(n, '\0');
            if (gst_buffer_extract(buf, size - n, tail.data(), n) == n)
                au = join(st, ps, tail, GST_CLOCK_TIME_IS_VALID(pts), (int64_t)pts);
        }
        if (au && k_for(*au, &k)) {
            out = k + ns(au->u);
            if (au->has_du) {
                has_dts_out = true;
                dts_out = k + ns(au->du);
            }
            has_out = out >= 0 && (!has_dts_out || dts_out >= 0);
        }
    }
    if (!has_out) {
        bool shift = ps.has_delta;
        if (shift) {
            buf = gst_buffer_make_writable(buf);
            GST_PAD_PROBE_INFO_DATA(info) = buf;
            if (GST_CLOCK_TIME_IS_VALID(pts) && (int64_t)pts + ps.delta >= 0)
                GST_BUFFER_PTS(buf) = (GstClockTime)((int64_t)pts + ps.delta);
            if (GST_CLOCK_TIME_IS_VALID(dts) && (int64_t)dts + ps.delta >= 0)
                GST_BUFFER_DTS(buf) = (GstClockTime)((int64_t)dts + ps.delta);
        }
        if (!ps.logged) {
            ps.logged = true;
            ipc::log(fmt("branchAlign: %s retime: %s pid=0x%x an access unit did not join its PES — passed on "
                         "tsdemux's timestamp%s (logged once per pad)",
                         st.name.c_str(), GST_PAD_NAME(pad), ps.pid,
                         shift ? fmt(" + the pad's last correction (%+.3f ms)", ps.delta / 1e6).c_str() : ""));
        }
        return GST_PAD_PROBE_OK;
    }
    buf = gst_buffer_make_writable(buf);
    GST_PAD_PROBE_INFO_DATA(info) = buf;
    GST_BUFFER_PTS(buf) = (GstClockTime)out;
    if (has_dts_out)
        GST_BUFFER_DTS(buf) = (GstClockTime)dts_out;
    else if (GST_CLOCK_TIME_IS_VALID(dts))
        GST_BUFFER_DTS(buf) = (GstClockTime)out;   // no PES DTS: decode at presentation
    if (GST_CLOCK_TIME_IS_VALID(pts)) {
        ps.has_delta = true;
        ps.delta = out - (int64_t)pts;
    }
    return GST_PAD_PROBE_OK;
}

void pad_added(GstElement*, GstPad* pad, gpointer user) {
    std::shared_ptr<State> st = *static_cast<std::shared_ptr<State>*>(user);
    const gchar* pad_name = GST_PAD_NAME(pad);
    if (!pad_name || !(g_str_has_prefix(pad_name, "audio_") || g_str_has_prefix(pad_name, "video_"))) return;
    int pid = pid_from_pad_name(pad_name);
    if (pid < 0) return;
    auto* oa = new OutArg{st, Pad{}};
    oa->pad.pid = pid;
    gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, out_cb, oa, delete_out_arg);
}

void delete_holder(gpointer p) { delete static_cast<std::shared_ptr<State>*>(p); }

}  // namespace

/** Arm the retime on one transform producer's input demux; owns `demux` and `sink`. */
void install(const gchar* name, GstElement* demux, GstPad* sink) {
    auto st = std::make_shared<State>();
    st->name = name;
    st->demux = demux;
    st->sink_pad = sink;
    gst_pad_add_probe(sink,
                      (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM |
                                        GST_PAD_PROBE_TYPE_EVENT_FLUSH),
                      sink_cb, new std::shared_ptr<State>(st), delete_holder);
    st->pad_added_id = g_signal_connect_data(demux, "pad-added", G_CALLBACK(pad_added), new std::shared_ptr<State>(st),
                                             [](gpointer p, GClosure*) { delete_holder(p); }, (GConnectFlags)0);
    g_retime.push_back(st);
}

/** Drop the registry and every ref a state holds. The probes stay on their pads
 *  (they hold the state) until the pipeline goes, so the drain at stop still
 *  retimes what tsdemux flushes — as the python twin's probes do. */
void clear() {
    for (auto& st : g_retime) {
        std::vector<GstBuffer*> held;
        {
            std::lock_guard<std::mutex> lock(st->m);
            held.swap(st->held);
        }
        for (GstBuffer* b : held) gst_buffer_unref(b);
        if (st->pad_added_id && st->demux) g_signal_handler_disconnect(st->demux, st->pad_added_id);
        st->pad_added_id = 0;
        if (st->sink_pad) gst_object_unref(st->sink_pad);
        st->sink_pad = nullptr;
        if (st->demux) gst_object_unref(st->demux);
        st->demux = nullptr;
    }
    g_retime.clear();
}

}  // namespace mr::align::rt
