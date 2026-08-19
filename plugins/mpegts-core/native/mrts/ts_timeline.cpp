/* Timeline latch + producer-side stamper, C++ half — the port of
 * `plugins/mpegts-core/py/ts_timeline.py`, whose header carries the design.
 *
 * FILE SIZE, deliberately over the repo's ~250-line guideline (CLAUDE.md): this
 * is ONE cohesive domain (the contract's timeline maths) maintained in
 * LINE-FOR-LINE parity with the python definition, which is what lets one
 * fixture assert the same integers out of both languages. Splitting it would
 * mean splitting the python side identically to keep that parity readable — the
 * cost paid twice, and the parity surface that guards against timeline bugs
 * multiplied. Keep it one file per language.
 */
#include "ts_timeline.h"

#include <algorithm>

#include "ts_psi.h"

namespace mrts {
namespace {

// Discontinuity watch (runner parity): the modular delta below is 33-bit-wrap
// immune — a legal 2^33 crossing reads as a tiny delta — so anything past
// these thresholds is a REAL source discontinuity. ANOM_CONFIRM consecutive
// anomalous BUFFERS are required before we act, confirmed either by a second
// PID reporting the same jump a buffer later (a muxed egress) or by the same
// PID staying anomalous against its retained reference (a single-PID egress).
constexpr int64_t FWD_TICKS = 5 * 90000;   // forward jump > 5 s
constexpr int64_t BACK_TICKS = 90000;      // backward jump > 1 s
constexpr int ANOM_CONFIRM = 2;

// Bounded-staleness net (defense in depth) — rationale in full in
// ts_timeline.py, in short: the watch is a DETECTOR and the freeze mode it
// misses is unbounded, so a stamp that trails house time by more than
// STALE_NS for STALE_HOLD_NS forces a re-anchor whatever the watch saw.
// STALE_NS is FWD_TICKS in nanoseconds, deliberately the same number; the hold
// is the consumers' max-lateness, which is what makes it persistence and not a
// spike.
constexpr int64_t STALE_NS = 5'000'000'000LL;
constexpr int64_t STALE_HOLD_NS = 1'000'000'000LL;

// Drift slewing — the third mechanism, and the only continuous one. The design
// and every constant below are documented in full in ts_timeline.py, including
// the 2026-08-13 field failure that produced them; in short: this servo has NO
// SETPOINT. It cancels the TREND of the arrival-vs-stamp margin (the ppm the
// two clocks differ by) and never targets a LEVEL, because a producer's margin
// is not ours to choose — an HLS player's 2 s delivery lead is healthy, and the
// position loop that shipped first read it as an error and spent its whole
// authority destroying it.
constexpr int SLEW_MAX_PPM = 200;
constexpr int64_t SETTLE_NS = 300'000'000'000LL;      // 5 min before anything is measured
constexpr int64_t DRIFT_BUCKET_NS = 2'000'000'000LL;  // lower-envelope bucket
constexpr int64_t SUBWINDOW_NS = 120'000'000'000LL;   // ... one median level per 2 min
constexpr size_t TREND_SLOTS = 10;                    // ... x this = a 20 min window
constexpr size_t TREND_EDGE = 3;                      // levels per end of the slope
constexpr int64_t TREND_MIN_PPM = 10;                 // below this it is noise
constexpr int64_t TREND_GAIN_NUM = 1, TREND_GAIN_DEN = 10;
constexpr int64_t GIVEBACK_NS = 200'000'000LL;        // margin we will never cost

// Python's `//` for a positive divisor: C++ truncates toward zero, which would
// round a negative correction the wrong way and put the two implementations a
// nanosecond apart per step.
int64_t floor_div(int64_t a, int64_t b) {
    int64_t q = a / b;
    if (a % b != 0 && (a < 0) != (b < 0)) q--;
    return q;
}

int64_t clamp64(int64_t v, int64_t lo, int64_t hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// Upper median, python's `sorted(v)[len(v) // 2]` — an exact sample on an even
// count rather than an average of two, so both languages return the same tick.
int64_t median(std::vector<int64_t> v) {
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
}

// Python's `%` on a positive modulus: always non-negative.
int64_t mod_wrap(int64_t v) {
    int64_t m = v % PTS_WRAP;
    return m < 0 ? m + PTS_WRAP : m;
}

// Signed, wrap-folded PES delta — the watch's whole wrap immunity.
int64_t folded_delta(int64_t pts, int64_t last) {
    int64_t d = mod_wrap(pts - last);
    return d > PTS_WRAP / 2 ? d - PTS_WRAP : d;
}

// `pts` is a plausible continuation of `last`. BOTH halves of the watch ask
// it: once of the pre-jump reference (is this a discontinuity at all?) and
// once of the proposed new epoch (is the stream continuing from it?).
bool coherent(int64_t pts, int64_t last) {
    int64_t d = folded_delta(pts, last);
    return d >= -BACK_TICKS && d <= FWD_TICKS;
}

// The buffer's FIRST PES header — python's `pes[0]`. False when it has none.
bool first_pes(const uint8_t* data, size_t len, int* pid, int64_t* pts) {
    for (size_t off = 0; off + PKT <= len; off += PKT) {
        const uint8_t* pkt = data + off;
        if (pkt[0] != SYNC_BYTE || !ts_pusi(pkt)) continue;
        int64_t p = read_pes_pts(pkt);
        if (p < 0) continue;
        *pid = ts_pid(pkt);
        *pts = p;
        return true;
    }
    return false;
}

}  // namespace

int64_t pts90k_to_ns(int64_t pts) {
    int64_t num = pts * 100000;
    int64_t q = num / 9;
    // Floor, like Python's `//`: C++ truncates toward zero, which would round a
    // negative delta the wrong way and put the two implementations one ns apart.
    if (num < 0 && num % 9 != 0) q--;
    return q;
}

int64_t unwrap_near(int64_t pts, int64_t ref) {
    int64_t base = ref - mod_wrap(ref - pts);
    return (ref - base) <= PTS_WRAP / 2 ? base : base + PTS_WRAP;
}

void TimelineLatch::feed(const uint8_t* data, size_t len) {
    for (size_t off = 0; off + PKT <= len; off += PKT) {
        const uint8_t* pkt = data + off;
        if (pkt[0] != SYNC_BYTE) continue;   // iter_packets parity: no resync
        if (!ts_pusi(pkt)) continue;         // PUSI quick-reject before PID parse
        int pid = ts_pid(pkt);
        if (first_pts_.count(pid)) continue; // cheap steady-state: latch once
        int64_t pts = read_pes_pts(pkt);
        if (pts < 0) continue;
        if (!has_epoch_) {
            has_epoch_ = true;
            epoch_ref_ = pts;
        } else {
            pts = unwrap_near(pts, epoch_ref_);
        }
        first_pts_[pid] = pts;
    }
}

int64_t TimelineLatch::first_pts(int pid, int64_t fallback) const {
    auto it = first_pts_.find(pid);
    return it == first_pts_.end() ? fallback : it->second;
}

void TimelineLatch::clear() {
    first_pts_.clear();
    has_epoch_ = false;
    epoch_ref_ = 0;
}

void TimelineStamper::reset_drift(int64_t house_now, bool have_now) {
    env_min_ = 0;
    env_end_ = 0;
    env_open_ = false;
    sub_.clear();
    sub_end_ = 0;
    trend_.clear();
    level_ = 0;
    has_level_ = false;
    rate_ppm_ = 0;
    slope_sign_ = 0;
    engage_level_ = 0;
    has_engage_ = false;
    epoch_start_ = house_now;
    has_epoch_start_ = have_now;
    slew_last_ = house_now;
    has_slew_last_ = have_now;
    slew_total_ = 0;
}

TimelineStamper::Drift TimelineStamper::drift() const {
    return {rate_ppm_, slew_total_, has_level_ ? level_ : 0,
            has_engage_ ? engage_level_ : 0, (int)trend_.size(), (int)TREND_SLOTS};
}

void TimelineStamper::observe(int64_t house_now, int64_t stamp) {
    int64_t margin = house_now - stamp;
    if (!has_epoch_start_) {
        has_epoch_start_ = true;
        epoch_start_ = house_now;       // pre-anchor construction
    }
    // Settling. A producer's opening transient — an HLS player building its
    // delivery lead — is not drift, and measuring through it is what taught
    // this loop the wrong target once already.
    if (house_now - epoch_start_ < SETTLE_NS) return;
    if (!env_open_) {
        env_open_ = true;
        env_end_ = house_now + DRIFT_BUCKET_NS;
        sub_end_ = house_now + SUBWINDOW_NS;
        env_min_ = margin;
        return;
    }
    if (house_now < env_end_) {
        if (margin < env_min_) env_min_ = margin;
        return;
    }
    sub_.push_back(env_min_);           // the bucket's lower envelope
    env_end_ = house_now + DRIFT_BUCKET_NS;
    env_min_ = margin;
    if (house_now < sub_end_) return;
    // Sub-window closed: one robust level, and a chance to re-estimate.
    level_ = median(sub_);
    has_level_ = true;
    sub_.clear();
    sub_end_ = house_now + SUBWINDOW_NS;
    trend_.push_back({house_now, level_});
    if (trend_.size() > TREND_SLOTS) trend_.erase(trend_.begin());
    update_rate();
}

// Both endpoints are MEDIANS of TREND_EDGE levels, so no single sub-window can
// tilt the answer.
bool TimelineStamper::slope_ppm(int64_t* out) const {
    if (trend_.size() < TREND_SLOTS) return false;
    std::vector<int64_t> old_t, old_v, new_t, new_v;
    for (size_t i = 0; i < TREND_EDGE; i++) {
        old_t.push_back(trend_[i].first);
        old_v.push_back(trend_[i].second);
        const auto& n = trend_[trend_.size() - TREND_EDGE + i];
        new_t.push_back(n.first);
        new_v.push_back(n.second);
    }
    int64_t dt = median(new_t) - median(old_t);
    if (dt <= 0) return false;
    *out = floor_div((median(new_v) - median(old_v)) * 1'000'000, dt);
    return true;
}

void TimelineStamper::update_rate() {
    int64_t slope = 0;
    if (!slope_ppm(&slope)) return;
    if (!has_engage_) {
        has_engage_ = true;
        engage_level_ = level_;
    } else if (level_ - engage_level_ > GIVEBACK_NS) {
        // The outcome watchdog. `level` is `house - stamp`, so a level ABOVE
        // the engage level means the scheduling margin has SHRUNK by that much
        // since we started correcting — the one thing this loop must never be
        // responsible for. Stand down completely and re-settle; the staleness
        // net owns a margin this loop cannot hold.
        rate_ppm_ = 0;
        slope_sign_ = 0;
        epoch_start_ = trend_.empty() ? epoch_start_ : trend_.back().first;
        trend_.clear();
        has_engage_ = false;
        return;
    }
    int sign = slope > 0 ? 1 : (slope < 0 ? -1 : 0);
    if (slope < 0 ? -slope < TREND_MIN_PPM : slope < TREND_MIN_PPM) {
        // Under a second a day: not worth moving for, and small enough to be
        // the envelope's own noise. The rate we already hold stays held.
        slope_sign_ = 0;
        return;
    }
    if (sign != slope_sign_) {
        // First sighting of a slope this sign: wait for the next sub-window to
        // confirm it, so a STEP in the level can never read as a trend.
        slope_sign_ = sign;
        return;
    }
    // Integrate the RESIDUAL slope: the rate converges on the source's own
    // offset and then holds it with the slope at zero.
    int64_t step = floor_div(slope * TREND_GAIN_NUM, TREND_GAIN_DEN);
    rate_ppm_ = (int)clamp64(rate_ppm_ + step, -SLEW_MAX_PPM, SLEW_MAX_PPM);
}

void TimelineStamper::slew(int64_t house_now) {
    if (!has_slew_last_) {
        has_slew_last_ = true;
        slew_last_ = house_now;
        return;
    }
    int64_t dt = house_now - slew_last_;
    if (dt <= 0) return;
    slew_last_ = house_now;
    if (rate_ppm_ == 0) return;
    // POSITIVE rate means media is running behind house (source slow), so the
    // anchor moves FORWARD to keep the stamps up with it; negative cancels the
    // growth of a fast source's lead. `_rate_ppm` of real time and nothing
    // else — no level term, so a healthy margin is never a target.
    int64_t step = floor_div((int64_t)rate_ppm_ * (dt / 1000), 1000);
    if (step != 0) {
        anchor_ += step;
        slew_total_ += step;
    }
}

void TimelineStamper::reanchor(int pid, int64_t last_pts, int64_t pts, int64_t d,
                               int64_t house_now) {
    // In place, NOT a restart: the anchor is two numbers, so a re-anchor costs
    // one PTS step and needs no cooperation from any consumer. Every stream of
    // this egress re-anchors together (one anchor), so A/V pairing survives.
    anom_ = 0;
    reanchors_++;
    anchor_ = house_now;
    ref_ = pts;
    unwrapped_.clear();
    // The watch's references belong to the epoch we just left too, and one of
    // them is by now deliberately stale (see scan_watch) — carried over they
    // would report the SAME jump again on the next buffer.
    watch_last_.clear();
    pending_.clear();
    stale_since_.clear();
    // The drift estimate belongs to the old mapping too: its baseline was a
    // margin measured against an anchor that no longer exists, so carrying it
    // over would slew the fresh anchor by the dead epoch's error.
    reset_drift(house_now, true);
    // Fresh latch: the old first-PES map belongs to the epoch we just left.
    latch_.clear();
    // Drop the monotone floors with the anchor. A discontinuity is detected at
    // least one buffer LATE, so by now a floor holds a stamp derived from the
    // jumped payload — a source that skipped ten minutes forward would
    // otherwise pin the timeline ten minutes ahead and freeze every later
    // stamp against that floor until the house clock caught up.
    floors_.clear();
    if (on_reanchor_) on_reanchor_({pid, last_pts, pts, d, anchor_, reanchors_});
}

void TimelineStamper::scan_watch(const uint8_t* data, size_t len, int64_t house_now) {
    for (size_t off = 0; off + PKT <= len; off += PKT) {
        const uint8_t* pkt = data + off;
        if (pkt[0] != SYNC_BYTE || !ts_pusi(pkt)) continue;
        int64_t pts = read_pes_pts(pkt);
        if (pts < 0) continue;
        int pid = ts_pid(pkt);
        auto it = watch_last_.find(pid);
        if (it == watch_last_.end()) {
            watch_last_[pid] = pts;
            continue;
        }
        int64_t last_pts = it->second;
        if (coherent(pts, last_pts)) {
            it->second = pts;
            pending_.erase(pid);
            continue;
        }
        // Two confirmation paths, in full in ts_timeline.py: cross-PID
        // (ANOM_CONFIRM consecutive anomalous BUFFERS, whichever PIDs reported
        // them) and same-PID (the PID that reported the jump comes back
        // COHERENT from the epoch it proposed). The second is the only path a
        // single-PID egress has — mr-tssplit's per-PID SPTS outputs — and its
        // absence is the 2026-08-13 field freeze. The pre-jump reference is
        // deliberately NOT advanced across an anomaly, so a merely glitched
        // PID comes back coherent against it and drops its proposal.
        anom_++;
        auto cand = pending_.find(pid);
        bool same_pid = cand != pending_.end() && coherent(pts, cand->second);
        pending_[pid] = pts;
        if (same_pid || anom_ >= ANOM_CONFIRM)
            reanchor(pid, last_pts, pts, folded_delta(pts, last_pts), house_now);
        return;
    }
    anom_ = 0;
}

void TimelineStamper::scan_stale(int pid, int64_t pts, int64_t house_now, int stream) {
    // The stream's floor IS the frozen value in the failure mode this guards,
    // so reading it costs one subtraction per buffer and needs no restamp. A
    // stream that is not being stamped cannot trip the net, by construction —
    // a producer that stopped emitting entirely is the stall watchdogs' job.
    // The caller has already found the buffer's first PES (python's `pes[0]`),
    // so this costs no scan of its own.
    auto fl = floors_.find(stream);
    if (fl == floors_.end()) return;
    int64_t lag = house_now - fl->second;
    if (lag <= STALE_NS) {
        stale_since_.erase(stream);
        return;
    }
    auto it = stale_since_.find(stream);
    if (it == stale_since_.end()) {
        stale_since_[stream] = house_now;
        return;
    }
    if (house_now - it->second < STALE_HOLD_NS) return;
    auto wl = watch_last_.find(pid);
    // `delta_ticks` carries the LAG that forced this (negative — media behind
    // house), so the event stream alone tells a net-forced re-anchor from a
    // watch-forced one.
    reanchor(pid, wl == watch_last_.end() ? pts : wl->second, pts,
             -(lag * 9 / 100000), house_now);
}

bool TimelineStamper::scan_stamp(const uint8_t* data, size_t len, int64_t house_now,
                                 int64_t* out) {
    bool have = false;
    for (size_t off = 0; off + PKT <= len; off += PKT) {
        const uint8_t* pkt = data + off;
        if (pkt[0] != SYNC_BYTE || !ts_pusi(pkt)) continue;
        int64_t pts = read_pes_pts(pkt);
        if (pts < 0) continue;
        int pid = ts_pid(pkt);
        if (!anchored_) {
            anchored_ = true;
            anchor_ = house_now;
            // The drift servo's t0: its settling period is measured from the
            // anchor, because what it must not measure through is the producer
            // transient that starts right here.
            slew_last_ = house_now;
            has_slew_last_ = true;
            epoch_start_ = house_now;
            has_epoch_start_ = true;
            // The latch's epoch reference: the first PES it recorded, which
            // every other PID's first value was unwrapped against.
            ref_ = latch_.epoch_ref(pts);
            if (on_anchor_) on_anchor_({pid, anchor_, ref_});
        }
        // Unwrap against this PID's own last value, or — first time we see the
        // PID — against the latch's epoch-consistent first PES for it. Either
        // way a legal 26.5 h wrap stays one continuous timeline.
        auto it = unwrapped_.find(pid);
        int64_t prev = it == unwrapped_.end() ? latch_.first_pts(pid, ref_) : it->second;
        int64_t u = unwrap_near(pts, prev);
        unwrapped_[pid] = u;
        if (!have) {
            // The FIRST PES in the buffer: that is where the buffer's media
            // content starts; the last one would drag the stamp forward by the
            // mux's interleave depth.
            have = true;
            *out = anchor_ + pts90k_to_ns(u - ref_);
        }
    }
    return have;
}

int64_t TimelineStamper::stamp(const uint8_t* data, size_t len, int64_t house_now,
                               int stream) {
    if (anchored_) {
        // The buffer's first PES, found once for the two mechanisms below —
        // python's `pes[0]` and its `if pes` gate.
        int pes_pid = 0;
        int64_t pes_pts = 0;
        bool have_pes = first_pes(data, len, &pes_pid, &pes_pts);
        scan_watch(data, len, house_now);              // may re-anchor before we stamp
        if (have_pes) {
            scan_stale(pes_pid, pes_pts, house_now, stream);   // ... and so may the net
            // ... and if neither did, the drift slew nudges the anchor the few
            // ns this buffer's share of the correction is worth. After both, so
            // a re-anchor's fresh baseline is never slewed by the epoch it just
            // replaced.
            slew(house_now);
        }
    }
    latch_.feed(data, len);                            // epoch-consistent first PES per PID
    int64_t s = 0;
    if (scan_stamp(data, len, house_now, &s)) {
        // Closed loop: measure this buffer's MAPPED time against the house time
        // it arrived at — before the monotone floor below, which guards what
        // leaves rather than describing the mapping (a clamped stamp would read
        // as a source falling behind, and the staleness net owns that mode).
        observe(house_now, s);
    } else {
        // No PES in this buffer (PSI/PCR-only, or continuation packets), or
        // nothing latched yet — repeat the staircase rather than emit a
        // timestampless buffer. A stream with no staircase yet takes house
        // time, which keeps a bogus zero out of the floors: a zero floor reads
        // to the staleness net as a stream frozen since the epoch.
        auto fl = floors_.find(stream);
        s = fl == floors_.end() ? house_now : fl->second;
    }
    int64_t& floor = floors_[stream];
    if (s < floor) s = floor;      // monotone non-decreasing staircase
    floor = s;
    return s;
}

// Field names and event names are the python ones verbatim (ts_timeline.py's
// callback payloads, emitted by unixfd-fanout.py as `{'event': ..., **info}`):
// the engine parses one shape whichever producer sent it, so a consumer of
// these events can never need to know which implementation stamped.
std::string anchor_event_json(const TimelineStamper::Anchored& a) {
    return "{\"event\":\"timeline_restamped\",\"pid\":" + std::to_string(a.pid) +
           ",\"anchorNs\":" + std::to_string(a.anchor_ns) +
           ",\"refPts90k\":" + std::to_string(a.ref_pts) + "}";
}

std::string reanchor_event_json(const TimelineStamper::Reanchor& r) {
    // `lastPts90k` and `deltaTicks` are what make this event diagnosable —
    // they name the jump that forced the re-anchor. Dropping them (as both
    // sidecars did) left an operator with a count and no cause.
    return "{\"event\":\"timeline_reanchor\",\"pid\":" + std::to_string(r.pid) +
           ",\"lastPts90k\":" + std::to_string(r.last_pts) +
           ",\"refPts90k\":" + std::to_string(r.pts) +
           ",\"deltaTicks\":" + std::to_string(r.delta_ticks) +
           ",\"anchorNs\":" + std::to_string(r.anchor_ns) +
           ",\"count\":" + std::to_string(r.count) + "}";
}

std::string drift_stats_json(const TimelineStamper::Drift& d) {
    return "{\"ppm\":" + std::to_string(d.ppm) +
           ",\"slewNs\":" + std::to_string(d.slew_ns) +
           ",\"marginNs\":" + std::to_string(d.margin_ns) +
           ",\"engageNs\":" + std::to_string(d.engage_ns) +
           ",\"samples\":" + std::to_string(d.samples) +
           ",\"window\":" + std::to_string(d.window) + "}";
}

}  // namespace mrts
