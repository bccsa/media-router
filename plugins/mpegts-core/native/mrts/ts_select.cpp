#include "ts_select.h"

#include <algorithm>
#include <cstring>

#include "ts_gap.h"

namespace mrts {
namespace {

constexpr uint32_t REG_BSSD = 0x42535344;   // 'BSSD', SMPTE 302M's format_identifier
constexpr int64_t S302M_RATE = 48000;       // SMPTE 302M is 48 kHz only

}  // namespace

SelectStream select_stream(const char* caps_name) {
    if (caps_name && std::strcmp(caps_name, "audio/x-smpte-302m") == 0)
        return SelectStream::smpte302m;
    return SelectStream::none;
}

const char* select_caps_name(SelectStream s) {
    return s == SelectStream::smpte302m ? "audio/x-smpte-302m" : "";
}

bool select_matches(SelectStream s, const PmtStream& es) {
    return s == SelectStream::smpte302m && es.stream_type == STREAM_TYPE_PRIVATE_PES &&
           registration_format(es.es_info) == REG_BSSD;
}

int64_t s302m_frames(const uint8_t* payload, size_t n) {
    if (n <= 4) return -1;
    const uint32_t h = ((uint32_t)payload[0] << 24) | ((uint32_t)payload[1] << 16) |
                       ((uint32_t)payload[2] << 8) | payload[3];
    const uint32_t size = h >> 16;                     // audio_packet_size
    const int channels = (int)((h >> 14) & 3) * 2 + 2;
    const int bits = (int)((h >> 4) & 3) * 4 + 16;     // 16, 20, 24; 28 is reserved
    if (4 + (size_t)size != n || bits > 24) return -1;
    // Each channel pair packs two samples and their 4 AES3 bits apiece.
    const int pair_bytes = (bits + 4) / 4;
    return 2 * (int64_t)(size / pair_bytes) / channels;
}

SelectDemux::SelectDemux() : SelectDemux(Config()) {}

SelectDemux::SelectDemux(const Config& cfg)
    : cfg_(cfg), pes_(PesAssembler::Config{cfg.max_pes_bytes, true}), one_(1) {
    psi_.select_program(cfg.program);
}

void SelectDemux::feed(const uint8_t* d, size_t n, bool discont, int64_t house_now_ns,
                       std::vector<Out>& out) {
    now_ = house_now_ns;
    if (discont) {
        // Bytes may be missing before this buffer: no packet joins across, and the open PES
        // is dropped (its next unit starts at a PUSI and is DISCONT).
        walker_.reset();
        pes_.reset();
        if (pid_ >= 0) {
            discont_ = true;
            clean_ = false;
        }
    }
    walker_.feed(d, n, [&](const PacketView& v) { on_packet(v, out); });
    if (state_ != State::missing || warned_ || now_ < 0) return;
    if (missing_since_ < 0) {
        missing_since_ = now_;
    } else if (now_ - missing_since_ >= NO_STREAM_NS) {
        warned_ = true;
        Out o;
        o.kind = Out::Kind::no_stream;
        out.push_back(std::move(o));
    }
}

void SelectDemux::on_packet(const PacketView& v, std::vector<Out>& out) {
    const CcTracker::Result cc = cc_.feed(v);
    if (v.pid == PID_PAT || (psi_.pmt_pid() >= 0 && v.pid == psi_.pmt_pid())) {
        on_psi(v, out);
        return;
    }
    if (pid_ < 0 || v.pid != pid_) return;
    pes_.feed(v, cc, units_);
    for (PesUnit& u : units_) on_unit(u, out);
    units_.clear();
}

void SelectDemux::on_psi(const PacketView& v, std::vector<Out>& out) {
    std::memcpy(one_[0].b, v.p, PKT);
    psi_.feed(one_);
    if (psi_.generation() == gen_ || !psi_.pmt()) return;
    gen_ = psi_.generation();
    int match = -1;
    for (const PmtStream& s : psi_.pmt()->streams)
        if (s.pid > PID_PAT && s.pid < PID_NULL && s.pid != psi_.pmt_pid() &&
            select_matches(cfg_.stream, s)) {
            match = s.pid;
            break;
        }
    if (match >= 0) {
        if (match != pid_) {
            select_pid(match);
            Out o;
            o.kind = Out::Kind::found;
            o.pid = match;
            out.push_back(std::move(o));
        }
        state_ = State::found;
        return;
    }
    if (pid_ >= 0) {
        pes_.select(pid_, false);
        pid_ = -1;
        forget_stream();
    }
    if (state_ != State::missing) {   // a new episode: the 2 s run from this PMT
        state_ = State::missing;
        missing_since_ = now_;
        warned_ = false;
    }
}

void SelectDemux::select_pid(int pid) {
    if (pid_ >= 0) pes_.select(pid_, false);
    pid_ = pid;
    pes_.select(pid, true);
    forget_stream();
    discont_ = true;                          // another stream on the same pad
}

void SelectDemux::forget_stream() {
    uw_.reset();
    have_last_ = clean_ = false;
    n_spacings_ = next_spacing_ = 0;
}

int64_t SelectDemux::frame_ns() const {
    if (n_spacings_ < 2) return -1;
    int64_t s[SPACING_WINDOW];
    for (int i = 0; i < n_spacings_; i++) {   // insertion sort: at most 8
        int j = i;
        for (; j > 0 && s[j - 1] > spacings_[i]; j--) s[j] = s[j - 1];
        s[j] = spacings_[i];
    }
    return s[n_spacings_ / 2];                // the upper median: the longer of two
}

void SelectDemux::emit_gap(int64_t start, int64_t end, const char* reason,
                           std::vector<Out>& out) {
    Out g;
    g.kind = Out::Kind::gap;
    g.pid = pid_;
    g.pts_ns = start;
    g.dur_ns = end - start;
    g.reason = reason;
    out.push_back(std::move(g));
    k_.gaps++;
    horizon_ = end;
    have_horizon_ = true;
    discont_ = true;
}

void SelectDemux::on_unit(PesUnit& u, std::vector<Out>& out) {
    Out o;
    o.kind = Out::Kind::unit;
    o.pid = u.pid;
    const int64_t frames = cfg_.stream == SelectStream::smpte302m
                               ? s302m_frames(u.payload.data(), u.payload.size())
                               : -1;
    int64_t pts = -1, dts = -1;
    if (u.hdr.pts >= 0) {
        // B-14: the seed is the unwrapped house time + 1 h, never folded to 33 bits.
        const int64_t seed = now_ >= 0 ? ns_to_pts90k(now_) + MUX_CLOCK_BASE_90K : u.hdr.pts;
        const int64_t pts_u = uw_.feed(u.hdr.pts, seed);
        const int64_t dts_u = uw_.feed_dts(u.hdr.dts, pts_u);
        pts = pts90k_to_ns(pts_u - MUX_CLOCK_BASE_90K);
        dts = dts_u == Unwrapper::NO_DTS ? pts : pts90k_to_ns(dts_u - MUX_CLOCK_BASE_90K);
    } else {
        k_.pes_no_pts++;
    }
    if (pts < 0 || dts < 0) {
        // No place on the timeline (no PTS, or before house time 0): out untimed, nothing learned.
        o.discont = !emitted_ || discont_ || u.discont;
        o.payload = std::move(u.payload);
        out.push_back(std::move(o));
        k_.pes++;
        emitted_ = true;
        discont_ = clean_ = false;
        return;
    }
    const int64_t frame = frame_ns();
    const int64_t dur = frames >= 0 ? frames * 1000000000 / S302M_RATE : -1;
    const bool clean = have_last_ && clean_ && !u.discont;
    // The jump rule: content more than two frames past what the pad emitted is a hole.
    if (have_last_ && have_horizon_ && frame > 0 && pts - horizon_ > JUMP_FRAMES * frame)
        emit_gap(horizon_, pts, "jump", out);
    // A jump's own spacing joins (a cadence rise is learned, B-21); a gap or a loss's does not.
    if (clean && pts - last_pts_ > 0 && pts - last_pts_ <= SPACING_MAX_NS) {
        spacings_[next_spacing_] = pts - last_pts_;
        next_spacing_ = (next_spacing_ + 1) % SPACING_WINDOW;
        n_spacings_ = std::min(n_spacings_ + 1, SPACING_WINDOW);
    }
    o.pts_ns = pts;
    o.dts_ns = dts;
    o.dur_ns = dur;
    o.discont = !emitted_ || discont_ || u.discont;
    o.payload = std::move(u.payload);
    out.push_back(std::move(o));
    k_.pes++;
    emitted_ = true;
    discont_ = false;
    have_last_ = clean_ = true;
    last_pts_ = pts;
    // Its end: the 302M duration, else one learned frame, else its start.
    const int64_t end = pts + (dur >= 0 ? dur : std::max<int64_t>(frame, 0));
    if (!have_horizon_ || end > horizon_) {
        horizon_ = end;
        have_horizon_ = true;
    }
}

void SelectDemux::marker(const uint8_t* d, size_t n, int64_t end_ns, std::vector<Out>& out) {
    if (pid_ < 0) return;                     // no stream: no marker can be ours
    for (size_t i = 0; i + PKT <= n; i += PKT) {
        const uint8_t* p = d + i;
        if (p[0] != SYNC_BYTE || ts_pid(p) != pid_) continue;
        const int64_t len = read_gap_length(p);
        if (len < 0) continue;                // not a marker packet
        k_.markers++;
        if (end_ns < 0) {
            k_.markers_dropped++;
            continue;
        }
        // B-21: never before what the pad emitted (a cadence rise's two false markers lie
        // inside the last PES), and dropped when nothing remains.
        int64_t start = len >= end_ns ? 0 : end_ns - len;
        if (have_horizon_ && start < horizon_) start = horizon_;
        if (start >= end_ns) {
            k_.markers_dropped++;
            continue;
        }
        emit_gap(start, end_ns, "marker", out);
        clean_ = false;                       // an outage's or an edit's spacing is no frame
    }
}

void SelectDemux::drain(std::vector<Out>& out) {
    pes_.flush(units_);
    for (PesUnit& u : units_) on_unit(u, out);
    units_.clear();
}

void SelectDemux::flush() {
    walker_.reset();
    cc_lost_before_ += cc_.lost();
    cc_ = CcTracker();
    pes_.reset();
    forget_stream();
    have_horizon_ = emitted_ = discont_ = false;
    horizon_ = 0;
}

SelectDemux::Counters SelectDemux::counters() const {
    Counters c = k_;
    c.desync_bytes = walker_.desync_bytes();
    c.cc_lost = cc_lost_before_ + cc_.lost();
    c.pes_oversize = pes_.oversize();
    c.pes_dropped_cc = pes_.dropped_cc();
    c.psi_unsupported_sections = psi_.unsupported_sections();
    c.dts_discarded = uw_.dts_discarded();
    return c;
}

}  // namespace mrts
