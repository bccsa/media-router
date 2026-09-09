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

#include <cstdlib>
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

// The late-level tier of the same net (the 2026-09-08 .103 freeze) — rationale
// in full in ts_timeline.py (`_LATE_NS`); in short: a POSITIVE margin held by
// even the best-delivered buffer of the egress for the hold is the anchor's
// error, not the producer's business (a negative one — a delivery lead — is,
// which is why the slew stays slope-only). Measured per PES buffer against its
// OWN mapped time (never the floor's age: a sparse PID must not trip it),
// minimum across every stream of the egress, one-sided.
constexpr int64_t LATE_NS = 100'000'000LL;
constexpr int64_t LATE_HOLD_NS = 10'000'000'000LL;
// The EARLY side of that tier (the #737 rewind, the RIST-reconnect lead) —
// OPT-IN with repair_latch, because a delivery lead is legitimate for a
// producer that runs ahead by design (the HLS fan-out) and the anchor's error
// only for one whose delivery cadence is its media cadence. Measured as the
// MAXIMUM margin over the hold (the least-early buffer). ts_timeline.py.
constexpr int64_t EARLY_NS = 800'000'000LL;
constexpr int64_t EARLY_HOLD_NS = 10'000'000'000LL;

// Timeline conditioner (ts_timeline.py `condition`, rationale there): a PES
// PTS (or PCR) delta beyond COND_STEP_NS that its arrival did not match is a
// clock step and is absorbed; beyond COND_MAX_NS it is a real discontinuity
// and is left to the watch.
constexpr int64_t COND_STEP_NS = 300'000'000LL;
constexpr int64_t COND_MAX_NS = 10'000'000'000LL;
// PCR regeneration (ts_timeline.py `_COND_PCR_LEAD_NS`): a consumer's tsdemux
// places every buffer at `stamp + (PTS − PCR)`, so the wire's PTS − PCR must be
// constant for the producer's stamps to mean anything downstream. The source's
// PCR is the pacer's clock — the one that stops, resets and lags — so it is not
// patched but REPLACED: written PCR = the reference PID's conditioned PTS minus
// this lead, interpolated by arrival between frames.
constexpr int64_t COND_PCR_LEAD_NS = 250'000'000LL;
constexpr int64_t COND_PCR_RECENT_NS = 500'000'000LL;   // a stream counts while it has a PES this recent
constexpr int64_t COND_PCR_FLOOR_NS = 1'000'000'000LL;  // ... and may pull the PCR at most this far down

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

// Latch repair (the 2026-09-05 GATE01 field failure) — design and rationale in
// full in ts_timeline.py, in short: a live source's first PES after a
// (re)connect is the head of the sender's backlog, late by all of it, and an
// anchor taken off it leaves every later buffer EARLY by that much for the
// anchor's whole life (1.8 s of cross-feed lipsync on .46). While this window
// is open a stamp later than its own arrival pulls the anchor back to it — a
// running minimum, the estimator's own one-sided-noise argument. Opt-in, for
// producers whose delivery cadence is their media cadence.
constexpr int64_t LATCH_REPAIR_NS = 3'000'000'000LL;

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

void TimelineStamper::open_latch(int64_t house_now) {
    // A fresh anchor opens a repair window — the first PES, and every
    // re-anchor (the buffer a re-anchor is taken off may be a backlog's head
    // too). A window still open at a re-anchor is closed and REPORTED first:
    // its cost belongs to the anchor it repaired.
    close_latch();
    latch_open_ = repair_on_;
    latch_until_ = house_now + LATCH_REPAIR_NS;
    repair_ns_ = 0;
}

void TimelineStamper::close_latch() {
    if (!latch_open_) return;
    latch_open_ = false;
    if (on_settled_) on_settled_({anchor_, repair_ns_, LATCH_REPAIR_NS});
}

int64_t TimelineStamper::repair(int64_t house_now, int64_t stamp) {
    if (!latch_open_) return stamp;
    if (house_now >= latch_until_) {
        close_latch();
        return stamp;
    }
    // The watch has this buffer down as anomalous (an unconfirmed
    // discontinuity): its stamp is off the OLD timeline by the jump, not early
    // delivery, and must not move the anchor — see ts_timeline.py.
    if (anom_ != 0) return stamp;
    int64_t late = stamp - house_now;
    if (late <= 0) return stamp;
    anchor_ -= late;
    repair_ns_ -= late;
    return house_now;
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
    // A repair window still open is closed and REPORTED against the anchor it
    // repaired, before that anchor is replaced.
    close_latch();
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
    late_open_ = false;
    early_open_ = false;
    // The drift estimate belongs to the old mapping too: its baseline was a
    // margin measured against an anchor that no longer exists, so carrying it
    // over would slew the fresh anchor by the dead epoch's error.
    reset_drift(house_now, true);
    // A fresh anchor has the same exposure the first one had.
    open_latch(house_now);
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
        // Only the timing PID may move the shared anchor once the PCR carrier
        // is known. A multiplexed egress carries PIDs on unrelated timelines —
        // a KLV/metadata PID stamps its own clock hours off the media (PID
        // 0x1f0, PTS ~87813 s, on the .103 vMix feed) — and letting one of
        // those trip the discontinuity watch re-anchored the WHOLE egress onto
        // it (+77 s), blanking every consumer for the seconds before the video
        // PID pulled it back (.103, 2026-09-08 13:27, on every reconnect).
        // Unknown timing PID (a single-PID SPTS egress with no PCR — mr-tssplit
        // outputs) keeps watching every PID: that is the 2026-08-13 freeze fix.
        if (timing_pid_ >= 0 && pid != timing_pid_) continue;
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

bool TimelineStamper::scan_late(int pid, int64_t pts, int64_t house_now, int64_t stamp) {
    // python's `_scan_late`, line for line: see ts_timeline.py for the design.
    int64_t margin = house_now - stamp;
    auto wl = watch_last_.find(pid);
    const int64_t last_pts = wl == watch_last_.end() ? pts : wl->second;
    // The LATE side: media behind house.
    if (margin <= LATE_NS) {
        late_open_ = false;               // one on-time buffer: it is jitter
    } else {
        if (!late_open_) {
            late_open_ = true;
            late_since_ = house_now;
            late_min_ = margin;
        } else if (margin < late_min_) {
            late_min_ = margin;
        }
        if (house_now - late_since_ >= LATE_HOLD_NS) {
            // `delta_ticks` carries the LEVEL that forced this (negative — media
            // behind house), the same convention as the 5 s net's lag.
            reanchor(pid, last_pts, pts, -(late_min_ * 9 / 100000), house_now);
            return true;
        }
    }
    // The EARLY side: media ahead of house — live-cadence producers only.
    if (!repair_on_ || margin >= -EARLY_NS) {
        early_open_ = false;              // one on-time buffer: it is jitter
    } else {
        if (!early_open_) {
            early_open_ = true;
            early_since_ = house_now;
            early_max_ = margin;
        } else if (margin > early_max_) {
            early_max_ = margin;
        }
        if (house_now - early_since_ >= EARLY_HOLD_NS) {
            // Positive delta_ticks: media ahead of house, by the level.
            reanchor(pid, last_pts, pts, (-early_max_) * 9 / 100000, house_now);
            return true;
        }
    }
    return false;
}

namespace {
// Signed, wrap-folded difference on an N-bit counter.
int64_t fold(int64_t d, int64_t modulo) {
    d %= modulo;
    if (d < 0) d += modulo;
    return d > modulo / 2 ? d - modulo : d;
}
int64_t read_pes_dts(const uint8_t* pkt) {
    // Caller has already established a PES header with a PTS at payload_offset.
    int off = payload_offset(pkt);
    if (off + 19 > PKT) return -1;
    const uint8_t* p = pkt + off;
    if (!(p[7] & 0x40)) return -1;
    return ((int64_t)((p[14] >> 1) & 0x07) << 30) | ((int64_t)p[15] << 22) |
           ((int64_t)(p[16] >> 1) << 15) | ((int64_t)p[17] << 7) | (p[18] >> 1);
}
// Rewrite the 33-bit value of a 5-byte PES timestamp field in place, keeping
// its 4-bit prefix ('0010' PTS-only, '0011' PTS of a pair, '0001' DTS) and the
// three marker bits exactly as the mux wrote them.
void write_ts_field(uint8_t* f, int64_t v) {
    f[0] = (uint8_t)((f[0] & 0xF0) | (((v >> 30) & 0x07) << 1) | 0x01);
    f[1] = (uint8_t)((v >> 22) & 0xFF);
    f[2] = (uint8_t)((((v >> 15) & 0x7F) << 1) | 0x01);
    f[3] = (uint8_t)((v >> 7) & 0xFF);
    f[4] = (uint8_t)(((v & 0x7F) << 1) | 0x01);
}
void write_pcr(uint8_t* pkt, int64_t pcr27) {
    int64_t base = pcr27 / 300;
    int ext = (int)(pcr27 % 300);
    pkt[6] = (uint8_t)(base >> 25);
    pkt[7] = (uint8_t)(base >> 17);
    pkt[8] = (uint8_t)(base >> 9);
    pkt[9] = (uint8_t)(base >> 1);
    pkt[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
    pkt[11] = (uint8_t)(ext & 0xFF);
}
}  // namespace

namespace {
constexpr size_t COND_RECENT = 8;
}  // namespace

void TimelineStamper::cond_remember(CondClock& c, int64_t d_ns) {
    if (c.recent.size() >= COND_RECENT) c.recent.erase(c.recent.begin());
    c.recent.push_back(d_ns);
}

int64_t TimelineStamper::cond_step_ns(const CondClock& c, int64_t d_ns) {
    if (c.recent.empty()) return d_ns;
    std::vector<int64_t> v(c.recent);
    std::sort(v.begin(), v.end());
    return d_ns - v[v.size() / 2];
}

int64_t TimelineStamper::cond_pcr_floor_pts(int64_t house_now) const {
    int64_t floor = cond_ref_wpts_;
    for (const auto& kv : cond_seen_) {
        if (kv.first == cond_ref_pid_ || house_now - kv.second.second > COND_PCR_RECENT_NS) continue;
        const int64_t d = fold(kv.second.first - cond_ref_wpts_, PTS_WRAP);
        if (d < 0 && pts90k_to_ns(-d) <= COND_PCR_FLOOR_NS && fold(kv.second.first - floor, PTS_WRAP) < 0)
            floor = kv.second.first;
    }
    return floor;
}

int TimelineStamper::condition(uint8_t* data, size_t len, int64_t house_now) {
    int absorbed = 0;
    for (size_t off = 0; off + PKT <= len; off += PKT) {
        uint8_t* pkt = data + off;
        if (pkt[0] != SYNC_BYTE) continue;
        const int pid = ts_pid(pkt);
        // --- PCR (adaptation field): regenerated from the conditioned PTS ---
        int64_t pcr = read_pcr(pkt);
        if (pcr >= 0) {
            cond_pcr_pid_ = pid;
            if (timing_pid_ != pid) {
                timing_pid_ = pid;
                // Learned after the anchor was taken on another PID: re-base
                // onto the timing PID's next PES (reported as a re-anchor).
                timing_rebase_pending_ = anchored_ && anchor_pid_ != pid;
            }
            if (cond_ref_pid_ >= 0) {
                // wpts − lead, in MEDIA time: flat between frames, never advanced
                // by arrival (a 94 KB I-frame's 350 ms of wire time is not media
                // time, and interpolating by it stepped the PCR — measured on
                // the .103 capture). One frame of PCR jitter is nothing to a
                // demuxer's skew filter; a step is a discontinuity.
                int64_t w = cond_pcr_floor_pts(house_now) * 300 - floor_div(COND_PCR_LEAD_NS * 27, 1000);
                w %= PCR_MODULO;
                if (w < 0) w += PCR_MODULO;
                bool di = !cond_pcr_regen_;              // first regenerated value
                if (cond_pcr_regen_) {                    // guard among regenerated values only
                    const int64_t dw = fold(w - cond_last_wpcr_, PCR_MODULO);
                    if (dw < 0) {
                        w = cond_last_wpcr_;              // monotone guard
                    } else if (std::llabs(floor_div(dw * 1000, 27) - (house_now - cond_last_wpcr_house_)) >
                               COND_MAX_NS) {
                        // The clock moved by more than the conditioner's bound past
                        // the time that passed: a source restart, which reaches the
                        // wire as written. NOT a delivery burst — SRT hands us
                        // hundreds of ms in one go, and a demuxer told to reset on
                        // each of those re-armed the keyframe gate every GOP (.103,
                        // 2026-09-08 12:23, 61 re-arms in 4 min at a 300 ms bound).
                        di = true;
                    }
                }
                if (di) pkt[5] |= 0x80;                 // signalled discontinuity
                write_pcr(pkt, w);
                cond_pcr_regen_ = true;
                cond_last_wpcr_ = w;
                cond_last_wpcr_house_ = house_now;
                cond_have_wpcr_ = true;
                // One event per new deviation of the source's PCR from ours.
                const int64_t off = fold(w - pcr, PCR_MODULO);
                if (!cond_pcr_reported_ ||
                    std::llabs(off - cond_pcr_reported_offset_) * 1000 / 27 > COND_STEP_NS) {
                    const int64_t step = cond_pcr_reported_ ? off - cond_pcr_reported_offset_ : off;
                    cond_pcr_reported_ = true;
                    cond_pcr_reported_offset_ = off;
                    absorbed++;
                    if (on_conditioned_) on_conditioned_({pid, true, floor_div(step, 300), floor_div(off, 300), house_now});
                }
            } else {
                cond_last_wpcr_ = pcr;                  // raw, until a PTS exists
                cond_have_wpcr_ = true;
            }
        }
        // --- PES PTS/DTS ---
        if (!ts_pusi(pkt)) continue;
        const int64_t pts = read_pes_pts(pkt);
        if (pts < 0) continue;
        const int poff = payload_offset(pkt);
        auto it = cond_pes_.find(pid);
        if (it == cond_pes_.end()) {
            it = cond_pes_.emplace(pid, CondClock{pts, house_now, 0, {}}).first;
        } else {
            CondClock& c = it->second;
            const int64_t d_ns = pts90k_to_ns(fold(pts - c.last_raw, PTS_WRAP));
            const int64_t a_ns = house_now - c.last_house;
            if (std::llabs(d_ns) > COND_STEP_NS && std::llabs(d_ns) <= COND_MAX_NS &&
                std::llabs(d_ns - a_ns) > COND_STEP_NS) {
                // floor_div, not `/`: `cond_step_ns` is negative on a backward
                // PTS step (the common case here), and C++ truncation toward
                // zero would round it one tick off python's `//` — the twins
                // must write byte-identical bytes.
                const int64_t step = floor_div(cond_step_ns(c, d_ns) * 9, 100000);
                c.offset -= step;
                absorbed++;
                if (on_conditioned_) on_conditioned_({pid, false, step, c.offset, house_now});
            } else if (std::llabs(d_ns) <= COND_STEP_NS) {
                cond_remember(c, d_ns);
            }
            c.last_raw = pts;
            c.last_house = house_now;
        }
        CondClock& c = it->second;
        int64_t wpts = (pts + c.offset) % PTS_WRAP;
        if (wpts < 0) wpts += PTS_WRAP;
        // The reference PID is the one carrying the PCR (its PTS is what the PCR
        // must trail — an audio PID's PTS can lead the video's by over a second,
        // and a PCR derived from it puts every video frame that far late: .103,
        // 2026-09-08 11:41). Until a PES on the PCR PID is seen, the first PES
        // PID stands in.
        if (cond_ref_pid_ < 0 || (pid == cond_pcr_pid_ && cond_ref_pid_ != pid)) {
            cond_ref_pid_ = pid;
            cond_pcr_regen_ = false;          // a new reference is a new PCR epoch: flagged, unguarded
        }
        if (pid == cond_ref_pid_) {
            cond_ref_wpts_ = wpts;
            cond_ref_house_ = house_now;
        }
        cond_seen_[pid] = {wpts, house_now};
        if (c.offset == 0) continue;
        write_ts_field(pkt + poff + 9, wpts);
        const int64_t dts = read_pes_dts(pkt);
        if (dts >= 0) {
            int64_t wdts = (dts + c.offset) % PTS_WRAP;
            if (wdts < 0) wdts += PTS_WRAP;
            // A DTS after its own PTS is not a timeline (vMix writes one while
            // its pacer resets); decode no later than presentation.
            if (fold(wdts - wpts, PTS_WRAP) > 0) wdts = wpts;
            write_ts_field(pkt + poff + 14, wdts);
        }
    }
    return absorbed;
}

bool TimelineStamper::scan_stamp(const uint8_t* data, size_t len, int64_t house_now,
                                 int64_t* out, int* out_pid, int64_t* out_pts) {
    bool have = false;
    bool have_timing = false;
    for (size_t off = 0; off + PKT <= len; off += PKT) {
        const uint8_t* pkt = data + off;
        if (pkt[0] != SYNC_BYTE || !ts_pusi(pkt)) continue;
        int64_t pts = read_pes_pts(pkt);
        if (pts < 0) continue;
        int pid = ts_pid(pkt);
        const bool is_timing = timing_pid_ < 0 || pid == timing_pid_;
        if (!anchored_) {
            anchor_pid_ = pid;
            anchored_ = true;
            anchor_ = house_now;
            // The timing PID may already be known (its PCR was conditioned in
            // this very buffer) while the first PES in it is another PID's:
            // re-base onto the carrier's next PES, exactly as when the PCR is
            // learned later (python: `_scan_stamp`).
            timing_rebase_pending_ = timing_pid_ >= 0 && pid != timing_pid_;
            // The drift servo's t0: its settling period is measured from the
            // anchor, because what it must not measure through is the producer
            // transient that starts right here.
            slew_last_ = house_now;
            has_slew_last_ = true;
            epoch_start_ = house_now;
            has_epoch_start_ = true;
            open_latch(house_now);
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
        // The FIRST PES in the buffer (that is where its media content starts;
        // the last one would drag the stamp forward by the interleave depth) —
        // except that the timing PID's first PES wins over any other PID's.
        if (!have || (is_timing && !have_timing)) {
            have = true;
            have_timing = is_timing;
            *out = anchor_ + pts90k_to_ns(u - ref_);
            if (out_pid) *out_pid = pid;
            if (out_pts) *out_pts = pts;
        }
    }
    return have;
}

int64_t TimelineStamper::stamp(const uint8_t* data, size_t len, int64_t house_now,
                               int stream) {
    // The buffer's first PES, found once for every mechanism below — python's
    // `pes[0]` and its `if pes` gate.
    int pes_pid = 0;
    int64_t pes_pts = 0;
    const bool have_pes = first_pes(data, len, &pes_pid, &pes_pts);
    if (timing_rebase_pending_ && anchored_) {
        // The anchor was taken on a PID that is not the PCR carrier (its PES
        // arrived first); the carrier's first PES re-bases the epoch onto it.
        for (size_t off = 0; off + PKT <= len; off += PKT) {
            const uint8_t* pkt = data + off;
            if (pkt[0] != SYNC_BYTE || !ts_pusi(pkt) || ts_pid(pkt) != timing_pid_) continue;
            const int64_t pts = read_pes_pts(pkt);
            if (pts < 0) continue;
            timing_rebase_pending_ = false;
            reanchor(timing_pid_, pts, pts, 0, house_now);
            anchor_pid_ = timing_pid_;
            break;
        }
    }
    if (anchored_) {
        scan_watch(data, len, house_now);              // may re-anchor before we stamp
        if (have_pes) {
            scan_stale(pes_pid, pes_pts, house_now, stream);   // ... and so may the net
            // ... and if neither did, the drift slew nudges the anchor the few
            // ns this buffer's share of the correction is worth. After both, so
            // a re-anchor's fresh baseline is never slewed by the epoch it just
            // replaced. Timing PID only (its buffers are what the servo measured).
            if (timing_pid_ < 0 || pes_pid == timing_pid_) slew(house_now);
        }
    }
    latch_.feed(data, len);                            // epoch-consistent first PES per PID
    int64_t s = 0;
    int s_pid = -1;
    int64_t s_pts = 0;
    if (scan_stamp(data, len, house_now, &s, &s_pid, &s_pts)) {
        // Only the timing PID's buffers may judge the anchor (see timing_pid_):
        // every mechanism below reads arrival against THIS stamp, and another
        // PID's PES can legitimately sit seconds off the timing PID's.
        const bool timing = timing_pid_ < 0 || s_pid == timing_pid_;
        if (timing) {
            // The latch-repair window first: while it is open, a stamp that
            // lands after its own arrival is the anchor's error, paid back here.
            s = repair(house_now, s);
            // The late/early tier of the net: this buffer's own mapped time
            // against its arrival over the hold. It re-anchors ON this buffer,
            // which then leaves stamped with its arrival — restamped on the
            // fresh epoch (python: `_scan_late` in `stamp`). The re-anchor's
            // reference is the PES the stamp was READ FROM (`s_pts`, the
            // timing PID's — python's `timing_pes[0]`), never the buffer's
            // first PES of any PID: with an audio PES ahead of the video's
            // in the buffer, a reference taken off the audio left every
            // video stamp the written A/V skew behind house, the hold
            // matured again 10 s later, and the egress re-anchored every
            // 10 s for ever (.103, 2026-09-08 13:02-13:15, levels growing
            // to -3 s; one dropped bus buffer per re-anchor).
            if (scan_late(s_pid, s_pts, house_now, s)) {
                latch_.feed(data, len);
                scan_stamp(data, len, house_now, &s, &s_pid);
            }
            // Closed loop: this buffer's MAPPED time against the house time it
            // arrived at — before the monotone floor below.
            observe(house_now, s);
        }
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

std::string conditioned_event_json(const TimelineStamper::Conditioned& c) {
    return std::string("{\"event\":\"timeline_conditioned\",\"pid\":") + std::to_string(c.pid) +
           ",\"clock\":\"" + (c.pcr ? "pcr" : "pts") + "\"" +
           ",\"stepTicks\":" + std::to_string(c.step_ticks) +
           ",\"offsetTicks\":" + std::to_string(c.offset_ticks) +
           ",\"houseNs\":" + std::to_string(c.house_ns) + "}";
}

std::string settled_event_json(const TimelineStamper::Settled& s) {
    // `repairNs` is the number an operator reads: 0 means the first PES was on
    // cadence; -1.8e9 means the anchor was taken off the head of a 1.8 s
    // backlog and has been pulled back onto the source's delivery.
    return "{\"event\":\"timeline_settled\",\"anchorNs\":" + std::to_string(s.anchor_ns) +
           ",\"repairNs\":" + std::to_string(s.repair_ns) +
           ",\"windowNs\":" + std::to_string(s.window_ns) + "}";
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
