#include "house_rebase.h"

#include <algorithm>
#include <cstring>

#include "mrts/ts_pcr.h"

namespace mrfanout {
namespace {

int64_t floor_mod(int64_t a, int64_t m) {
    const int64_t r = a % m;
    return r < 0 ? r + m : r;
}

// ISO 13818-1 table 2-22: audio 110x xxxx, video 1110 xxxx.
bool video_sid(uint8_t sid) { return (sid & 0xF0) == 0xE0; }
bool audio_sid(uint8_t sid) { return (sid & 0xE0) == 0xC0; }

}  // namespace

void HouseRebase::process(const uint8_t* data, size_t len, int64_t now_ns,
                          std::vector<uint8_t>& out) {
    out.clear();
    out_ = &out;
    now_ = now_ns;
    now_bus_ = mrts::ns_to_pts90k(now_ns) + mrts::MUX_CLOCK_BASE_90K;
    in_.assign(data, data + len);
    walker_.feed(in_.data(), in_.size(), [this](mrts::PacketView& v) { on_packet(v); });
    out_ = nullptr;
}

HouseRebase::Stats HouseRebase::stats() const {
    Stats s;
    s.anchored = anchored_;
    s.shift_90k = mrts::fold33(shift_);
    s.reanchors = reanchors_;
    s.kept = kept_;
    s.dropped = dropped_;
    s.desync_bytes = walker_.desync_bytes();
    return s;
}

int HouseRebase::pcr_pid() const {
    const auto& pmt = psi_.pmt();
    return pmt ? pmt->pcr_pid : first_pcr_pid_;
}

int64_t HouseRebase::spacing(const Pid& p) {
    const int64_t* s = p.steps;
    switch (p.n_steps) {
        case 0: return 0;
        case 1: return s[0];
        case 2: return std::max(s[0], s[1]);
        default: return std::max(std::min(s[0], s[1]), std::min(std::max(s[0], s[1]), s[2]));
    }
}

int HouseRebase::rank(int pid) const {
    if (pid >= 0 && pid == pcr_pid()) return 3;
    const auto it = pids_.find(pid);
    return it == pids_.end() ? 0 : it->second.cls;
}

void HouseRebase::on_packet(mrts::PacketView& v) {
    if (v.af_pcr && first_pcr_pid_ < 0) first_pcr_pid_ = v.pid;
    if (v.pid == mrts::PID_PAT || v.pid == psi_.pmt_pid()) {
        std::memcpy(one_[0].b, v.p, mrts::PKT);
        psi_.feed(one_);
        put(v.p);
        return;
    }
    if (v.pid < 0x20 || v.pid == mrts::PID_NULL) {   // SI tables and stuffing: no time
        put(v.p);
        return;
    }
    Pid& p = pids_[v.pid];
    const bool payload = v.payload_off < mrts::PKT;
    const bool repeat = payload && v.cc == p.cc;      // ISO 13818-1 2.4.3.3: a duplicate
    if (payload) p.cc = v.cc;
    if (payload && span_.held(v.pid)) {
        // A copy of the held header goes alone; the first waits for its continuation (B-9).
        if (repeat && v.pusi) {
            dropped_++;
            return;
        }
        if (release(p, v)) return;
    }
    if (!payload) {
        // Behind a held header it waits for it, so the PID's PCRs leave in order.
        if (span_.held(v.pid) && p.held_af.size() < MAX_HELD_AF * mrts::PKT)
            p.held_af.insert(p.held_af.end(), v.p, v.p + mrts::PKT);
        else
            send(v);
        return;
    }
    if (!v.pusi) {
        if (p.drop) dropped_++;
        else if (!send(v)) p.drop = true;
        return;
    }
    p.drop = false;
    if (!v.scrambled) {
        if (span_.hold(v)) return;        // the header continues in the PID's next packet
        mrts::PesHeader h;
        if (mrts::parse_pes_header(v.p + v.payload_off, mrts::PKT - v.payload_off, &h)) {
            int64_t pts33 = h.pts, dts33 = h.dts;
            // An incomplete header cannot be rewritten, so it never goes out on source time.
            if (!h.complete || !retime(p, v.pid, h, pts33, dts33)) {
                p.drop = true;
                dropped_++;
                return;
            }
            if (h.pts >= 0) mrts::rewrite_pes_timestamps(v, h, pts33, dts33);
        }
    }
    if (!send(v)) p.drop = true;
}

bool HouseRebase::release(Pid& p, mrts::PacketView& v) {
    uint8_t first[mrts::PKT];
    bool joined = false, keep = false;
    span_.complete(v, first, [&](const mrts::PesHeader& h, int64_t& pts33, int64_t& dts33) {
        joined = true;
        keep = retime(p, v.pid, h, pts33, dts33);
    });
    if (keep) send(first);
    else dropped_++;
    for (size_t i = 0; i + mrts::PKT <= p.held_af.size(); i += mrts::PKT) send(p.held_af.data() + i);
    p.held_af.clear();
    if (keep) {
        send(v);
        return true;
    }
    // Its PES cannot be placed, or the header was not joinable (lost with a CC gap or
    // cut by a new PES): a continuation goes with it, a new PES start is handled anew.
    p.drop = true;
    if (joined) {
        dropped_++;
        return true;
    }
    return false;
}

bool HouseRebase::retime(Pid& p, int pid, const mrts::PesHeader& h, int64_t& pts33,
                         int64_t& dts33) {
    if (h.pts < 0) return true;           // no time of its own
    const bool timing = video_sid(h.sid) || audio_sid(h.sid) || pid == pcr_pid();
    if (!anchored_ && !timing) return false;
    // A PID's first PES unwraps near the source time of house now.
    const int64_t pu = p.unwrap.feed(h.pts, anchored_ ? now_bus_ - shift_ : h.pts);
    const int64_t du = p.unwrap.feed_dts(h.dts, pu);
    if (timing) {
        if (!anchored_) {                 // playout start: its PTS lands at house now
            anchored_ = true;
            shift_ = now_bus_ - pu;
        }
        track(p, pid, h.sid, du != mrts::Unwrapper::NO_DTS ? du : pu, pu);
    }
    const int64_t shift = shift_ + p.delta;
    pts33 = floor_mod(pu + shift, mrts::PTS_WRAP);
    // A damaged DTS (more than 5 s from its PTS) decodes at its PTS.
    if (h.dts >= 0)
        dts33 = du != mrts::Unwrapper::NO_DTS ? floor_mod(du + shift, mrts::PTS_WRAP) : pts33;
    return true;
}

void HouseRebase::track(Pid& p, int pid, uint8_t sid, int64_t key, int64_t pts) {
    p.cls = video_sid(sid) ? 2 : audio_sid(sid) ? 1 : 0;
    const int64_t sp = spacing(p);
    const int64_t own = key - (p.key + sp);
    const bool jumped = p.have_key && (own > JUMP_90K || own < -JUMP_90K);
    bool joined = false;
    if (p.pending) {
        // Still on its own timeline, it stays (hls-pipe's inline audio); if it jumped too,
        // it takes the mapping of the reference that re-anchored.
        p.pending = false;
        joined = jumped;
        if (joined) p.delta = p.join;
        else kept_++;
    } else if (jumped) {
        p.jumped = true;
    }
    // The reference: the PCR PID, else video, else audio; a silent one gives way.
    if (ref_ != pid) {
        const auto it = pids_.find(ref_);
        if (it == pids_.end() || now_ - it->second.seen_ns > REF_STALE_NS || rank(pid) > rank(ref_))
            ref_ = pid;
    }
    // Jumps are judged on the bus: a PID that has just taken another's re-anchor is none.
    if (ref_ == pid && p.have_key && !joined) {
        const int64_t d = key + shift_ + p.delta - (p.key_out + sp);
        if (d > JUMP_90K || d < -JUMP_90K) {
            // House time continues one spacing after the last PES, but never late: the
            // content skips, and after a stall the new timeline starts at house now.
            const int64_t cont = p.key_out + std::max<int64_t>(sp, 1);
            const int64_t shift = std::max(cont, now_bus_ + (key - pts)) - key - p.delta;
            for (auto& [q, s] : pids_) {
                if (q == pid || !s.have_key) continue;
                if (s.jumped) {               // it jumped first: the same discontinuity
                    s.delta = p.delta;
                    s.key_out = s.key + shift + s.delta;
                } else {
                    s.delta -= shift - shift_;
                    s.join = p.delta;
                    s.pending = true;
                }
            }
            shift_ = shift;
            reanchors_++;
        }
    }
    // Each reference PES starts a new stretch: a jump before it is no longer this one's.
    if (ref_ == pid)
        for (auto& [q, s] : pids_) s.jumped = false;
    if (p.have_key && key > p.key && key - p.key <= JUMP_90K) {
        p.steps[p.step_at] = key - p.key;
        p.step_at = (uint8_t)((p.step_at + 1) % 3);
        if (p.n_steps < 3) p.n_steps++;
    }
    p.have_key = true;
    p.key = key;
    p.key_out = key + shift_ + p.delta;
    p.seen_ns = now_;
}

bool HouseRebase::send(mrts::PacketView& v) {
    if (v.af_pcr) {
        if (!anchored_) {                 // no shift to move it by yet
            dropped_++;
            return false;
        }
        // A PCR moves with its own PID's PES; the PCR PID's first on a new mapping is flagged.
        Pid& p = pids_[v.pid];
        const int64_t map = shift_ + p.delta;
        if (p.pcr_sent && map != p.pcr_map && v.pid == pcr_pid())
            mrts::set_discontinuity_indicator(v);
        p.pcr_sent = true;
        p.pcr_map = map;
        const int64_t pcr = mrts::read_pcr(v.p);
        const int64_t shift27 = floor_mod(map, mrts::PTS_WRAP) * 300;
        mrts::write_pcr(v, floor_mod(pcr + shift27, mrts::PCR_MODULO));
    }
    put(v.p);
    return true;
}

bool HouseRebase::send(uint8_t* pkt) {
    mrts::PacketView v;
    mrts::parse_packet(pkt, &v);
    return send(v);
}

}  // namespace mrfanout
