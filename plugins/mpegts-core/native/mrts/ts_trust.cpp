#include "ts_trust.h"

#include <algorithm>
#include <cstdio>

#include "ts_house.h"

namespace mrts {
namespace {

int64_t floor_div(int64_t a, int64_t b) {
    const int64_t q = a / b;
    return (a % b != 0 && a < 0) ? q - 1 : q;
}

int64_t floor_mod(int64_t a, int64_t m) {
    const int64_t r = a % m;
    return r < 0 ? r + m : r;
}

int64_t net_to_bus_e(int64_t pts, int64_t e_ns) {
    return floor_mod(pts - ns_to_pts90k(e_ns) + MUX_CLOCK_BASE_90K, PTS_WRAP);
}

constexpr int CLASS_MAX = hcdesc::ERROR_CLASS_MAX;

}  // namespace

const char* trust_state_name(TrustGate::State s) {
    switch (s) {
        case TrustGate::State::deciding: return "deciding";
        case TrustGate::State::qualifying: return "qualifying";
        case TrustGate::State::trust: return "trust";
        case TrustGate::State::converging: return "converging";
        case TrustGate::State::fallback: return "fallback";
        case TrustGate::State::returning: return "returning";
        default: return "restamp";
    }
}

const char* trust_decision_name(TrustGate::Decision d) {
    switch (d) {
        case TrustGate::Decision::hold: return "hold";
        case TrustGate::Decision::release_restamp: return "release-restamp";
        case TrustGate::Decision::release_trust: return "release-trust";
        case TrustGate::Decision::switch_to_trust: return "switch-to-trust";
        case TrustGate::Decision::switch_to_restamp: return "switch-to-restamp";
        default: return "none";
    }
}

const char* trust_mapping_name(TrustGate::Mapping m) {
    switch (m) {
        case TrustGate::Mapping::restamp: return "restamp";
        case TrustGate::Mapping::trust: return "trust";
        case TrustGate::Mapping::converging: return "converging";
        default: return "stc";
    }
}

uint32_t crc32_ieee(uint32_t crc, const void* data, size_t n) {
    static uint32_t table[256];
    static bool ready = false;
    if (!ready) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
        ready = true;
    }
    const uint8_t* p = (const uint8_t*)data;
    crc = ~crc;
    for (size_t i = 0; i < n; i++) crc = table[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
    return ~crc;
}

TrustGate::TrustGate(int program, const TrustConfig& cfg, const ClockDecl& clock, bool trust_selected,
                     int64_t now)
    : program_(program), cfg_(cfg), clock_(clock), trust_selected_(trust_selected),
      state_(trust_selected ? State::deciding : State::restamp), since_(now) {}

// --- the conditions -------------------------------------------------------------------------

void TrustGate::bounds(int64_t* lo, int64_t* hi) const {
    const int cls = have_decl_ ? decl_.clock_error_class : 255;
    const int64_t sender = cls == 255 ? UNKNOWN_TERM_NS : (int64_t(1) << std::min(cls, CLASS_MAX)) * 1000;
    const int64_t local = !clock_.error_us || *clock_.error_us < 0 ? UNKNOWN_TERM_NS : *clock_.error_us * 1000;
    *lo = -ns_to_pts90k(cfg_.neg_base_ns + sender + local);
    *hi = ns_to_pts90k(cfg_.l_ns + cfg_.tau_ns);
}

const char* TrustGate::failed(int64_t now) const {
    if (!have_decl_ || !have_pmt_ || now - pmt_at_ > cfg_.pmt_stale_ns) return "no-descriptor";
    if (!decl_.house_time_tai) return "not-house-time";
    if (!decl_.disciplined) return "sender-undisciplined";
    if (!clock_.disciplined || clock_.e_ns == 0) return "local-undisciplined";
    if (bad_run_ >= cfg_.bad_pcrs) return bad_side_;
    if (!judged_) return "no-pcr";
    return nullptr;
}

// --- inputs ---------------------------------------------------------------------------------

void TrustGate::on_pmt(const HouseTimeDecl* decl, int64_t now) {
    have_decl_ = decl != nullptr;
    if (decl) decl_ = *decl;
    pmt_at_ = now;
    have_pmt_ = true;
}

void TrustGate::on_pcr(int64_t pcr27, int64_t now) {
    if (!have_decl_ || !decl_.house_time_tai || clock_.e_ns == 0) return;
    const int64_t a = ns_to_pts90k(now + clock_.e_ns);
    const int64_t tr = fold33(a - (floor_div(pcr27, 300) + (int64_t)decl_.d_e_90k));
    ring_.push_back(tr);
    if ((int)ring_.size() > RING) ring_.erase(ring_.begin());
    int64_t lo, hi;
    bounds(&lo, &hi);
    judged_ = true;
    if (lo <= tr && tr <= hi) {
        bad_run_ = 0;
        good_++;
    } else {
        bad_run_++;
        bad_side_ = tr > hi ? "transit-high" : "transit-negative";
    }
}

void TrustGate::on_natural_gap(int64_t gap_ns, int64_t now) {
    gap_ = have_gap_ ? std::max(gap_, gap_ns) : gap_ns;
    have_gap_ = true;
    if (have_pmt_) pmt_at_ = std::max(pmt_at_, now);
}

void TrustGate::set_mode(bool trust, int64_t now) {
    trust_selected_ = trust;
    const State st = state_;
    if (trust) {
        have_pending_ = false;
        if (st == State::restamp) go(State::qualifying, Decision::none, now);
        return;
    }
    if (st == State::deciding) {
        go(State::restamp, Decision::release_restamp, now);
    } else if (st == State::qualifying || st == State::fallback || st == State::returning) {
        go(State::restamp, Decision::none, now);
    } else if (mapped() && !have_pending_) {
        have_pending_ = true;
        restamp_pending_ = now;
    }
}

void TrustGate::set_clock(const ClockDecl& clock, int64_t now) {
    const ClockDecl old = clock_;
    clock_ = clock;
    if (mapped() && clock.e_ns != old.e_ns && clock.e_ns != 0 && have_last_) {
        const int64_t was = f_on(last_pts_, old.e_ns);
        switch_trust(fold33(was - net_to_bus_e(last_pts_, clock.e_ns)), now);
    }
}

// --- the mapping ----------------------------------------------------------------------------

int64_t TrustGate::k_at(int64_t x) const {
    if (k0_ <= 0) return 0;
    const int64_t d = fold33(x - x0_);
    return d <= 0 ? k0_ : std::max<int64_t>(0, k0_ - floor_div(d, cfg_.converge_div));
}

int64_t TrustGate::f_on(int64_t x, int64_t e_ns) const {
    return floor_mod(net_to_bus_e(x, e_ns) + k_at(x), PTS_WRAP);
}

TrustGate::Mapped TrustGate::map(int64_t pts, int64_t dmp, int64_t stc_out) const {
    Mapped m;
    const bool has_dts = dmp != 0;
    const int64_t dts = has_dts ? floor_mod(pts + dmp, PTS_WRAP) : -1;
    if (mapped()) {
        m.kind = state_ == State::trust ? Mapping::trust : Mapping::converging;
        m.k90k = k_at(pts);
        m.pts = f(pts);
        m.dts = has_dts ? f(dts) : -1;
        return m;
    }
    m.kind = state_ == State::restamp ? Mapping::restamp : Mapping::stc;
    m.pts = stc_out >= 0 ? floor_mod(stc_out, PTS_WRAP) : -1;
    m.dts = m.pts >= 0 && has_dts ? floor_mod(m.pts + dmp, PTS_WRAP) : -1;
    return m;
}

void TrustGate::emitted(int pid, int64_t pts, const Mapped& m, int64_t now) {
    if (m.kind == Mapping::trust || m.kind == Mapping::converging) {
        char b[96];
        int n = m.dts >= 0 ? std::snprintf(b, sizeof b, "%d:%lld:%lld;", pid, (long long)m.pts, (long long)m.dts)
                           : std::snprintf(b, sizeof b, "%d:%lld:None;", pid, (long long)m.pts);
        crc_ = crc32_ieee(crc_, b, (size_t)n);
    }
    counts_[(int)m.kind]++;
    if (m.pts >= 0) {
        have_last_ = true;
        last_pts_ = pts;
        last_out_ = m.pts;
    }
    if (m.kind == Mapping::converging && m.k90k == 0) {
        k0_ = 0;
        go(State::trust, Decision::none, now);
    }
}

TrustGate::Transition TrustGate::line(State s, Decision d, int64_t now) const {
    Transition t;
    t.t = now;
    t.decision = d;
    t.from = state_;
    t.state = s;
    t.failed = failed(now);
    return t;
}

void TrustGate::go(State s, Decision d, int64_t now) { go(line(s, d, now)); }

void TrustGate::go(const Transition& t) {
    log_.push_back(t);
    if (t.state != state_) {
        state_ = t.state;
        since_ = t.t;
        have_ready_ = false;
        if (t.state == State::deciding) good_ = 0;
    }
}

// Into Trust with k ticks of the old timeline left (less a natural gap taken there).
void TrustGate::switch_trust(int64_t k, int64_t now) {
    switches_++;
    have_pending_ = false;
    if (k > 0) {
        k0_ = k;
        x0_ = last_pts_;
        Transition t = line(State::converging, Decision::switch_to_trust, now);
        t.has_k = true;
        t.k_ns = pts90k_to_ns(k);
        t.k90k = k;
        go(t);
    } else {
        k0_ = 0;
        Transition t = line(State::trust, Decision::switch_to_trust, now);
        t.has_gap = true;
        t.gap_ns = pts90k_to_ns(-k);
        go(t);
    }
}

void TrustGate::switch_restamp(State s, int64_t now) {
    switches_++;
    k0_ = 0;
    have_pending_ = false;
    go(s, Decision::switch_to_restamp, now);
}

// --- the step -------------------------------------------------------------------------------

TrustGate::Decision TrustGate::step(int64_t now) {
    const char* why = failed(now);
    if (!why) {
        if (!have_qual_) {
            have_qual_ = true;
            qual_since_ = now;
        }
    } else {
        have_qual_ = false;
    }
    const bool gap = have_gap_;
    const int64_t gap_ns = gap_;
    have_gap_ = false;
    gap_ = 0;
    const State st = state_;
    const int64_t qualified_for = have_qual_ ? now - std::max(qual_since_, since_) : -1;
    if (st == State::deciding) {
        if (good_ >= cfg_.decide_pcrs && !why) {
            go(State::trust, Decision::release_trust, now);
            return Decision::release_trust;
        }
        if (bad_run_ >= cfg_.bad_pcrs || good_ >= cfg_.decide_pcrs || now - since_ >= cfg_.decide_max_ns) {
            go(State::fallback, Decision::release_restamp, now);
            return Decision::release_restamp;
        }
        return Decision::hold;
    }
    if (st == State::trust || st == State::converging) {
        if (why) {
            switch_restamp(trust_selected_ ? State::fallback : State::restamp, now);
            return Decision::switch_to_restamp;
        }
        if (have_pending_ && (gap || now - restamp_pending_ >= cfg_.return_gap_wait_ns)) {
            switch_restamp(State::restamp, now);
            return Decision::switch_to_restamp;
        }
        if (st == State::converging && gap && have_last_) {
            const int64_t k = k_at(last_pts_) - ns_to_pts90k(gap_ns);
            if (k > 0) {
                k0_ = k;
                x0_ = last_pts_;
                Transition t = line(State::converging, Decision::none, now);
                t.has_k = true;
                t.k_ns = pts90k_to_ns(k);
                t.k90k = k;
                go(t);
            } else {
                k0_ = 0;
                Transition t = line(State::trust, Decision::none, now);
                t.has_gap = true;
                t.gap_ns = pts90k_to_ns(-k);
                go(t);
            }
        }
        return Decision::none;
    }
    if (st == State::fallback) {
        if (qualified_for >= cfg_.return_qualified_ns) go(State::returning, Decision::none, now);
        return Decision::none;
    }
    if (st == State::qualifying || st == State::returning) {
        if (st == State::returning && why) {
            go(State::fallback, Decision::none, now);
            return Decision::none;
        }
        int64_t start;
        if (st == State::qualifying) {
            if (qualified_for < cfg_.qualify_ns) {
                have_ready_ = false;
                return Decision::none;
            }
            if (!have_ready_) {
                have_ready_ = true;
                ready_at_ = now;
            }
            start = ready_at_;
        } else {
            start = since_;
        }
        if (gap || now - start >= cfg_.return_gap_wait_ns) {
            int64_t k = 0;
            if (have_last_) k = fold33(last_out_ - net_to_bus_e(last_pts_, clock_.e_ns));
            if (gap) k -= ns_to_pts90k(gap_ns);
            switch_trust(k, now);
            return Decision::switch_to_trust;
        }
    }
    return Decision::none;
}

TrustGate::Decision TrustGate::give_up(int64_t now) {
    if (state_ != State::deciding) return Decision::none;
    go(State::fallback, Decision::release_restamp, now);
    return Decision::release_restamp;
}

// --- stats ----------------------------------------------------------------------------------

TrustGate::Stats TrustGate::stats(int64_t now) const {
    Stats s;
    s.state = state_;
    s.trust_selected = trust_selected_;
    s.failed = failed(now);
    s.switches = switches_;
    for (int i = 0; i < 4; i++) s.pes[i] = counts_[i];
    s.digest = crc_;
    if (!ring_.empty()) {
        std::vector<int64_t> v = ring_;
        std::sort(v.begin(), v.end());
        s.have_transit = true;
        s.transit_min_ns = pts90k_to_ns(v.front());
        s.transit_median_ns = pts90k_to_ns(v[(v.size() - 1) / 2]);
        s.transit_max_ns = pts90k_to_ns(v.back());
    }
    int64_t lo, hi;
    bounds(&lo, &hi);
    s.bound_lo_ns = pts90k_to_ns(lo);
    s.bound_hi_ns = pts90k_to_ns(hi);
    s.k_ns = pts90k_to_ns(k0_);
    s.have_decl = have_decl_;
    if (have_decl_) s.decl = decl_;
    return s;
}

std::vector<TrustGate::Transition> TrustGate::take_log() {
    std::vector<Transition> out;
    out.swap(log_);
    return out;
}

}  // namespace mrts
