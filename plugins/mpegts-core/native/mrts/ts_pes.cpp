#include "ts_pes.h"

#include <algorithm>
#include <cstring>
#include <utility>

namespace mrts {

namespace {

// ISO 13818-1 2.4.3.7: program_stream_map, padding, private_stream_2, ECM, EMM,
// DSM-CC, H.222.1 type E and program_stream_directory carry no optional header.
bool no_optional_header(uint8_t sid) {
    switch (sid) {
        case 0xBC: case 0xBE: case 0xBF: case 0xF0:
        case 0xF1: case 0xF2: case 0xF8: case 0xFF:
            return true;
        default:
            return false;
    }
}

int64_t read_ts_field(const uint8_t* f) {
    return ((int64_t)((f[0] >> 1) & 0x07) << 30) | ((int64_t)f[1] << 22) |
           ((int64_t)(f[2] >> 1) << 15) | ((int64_t)f[3] << 7) | (f[4] >> 1);
}

}  // namespace

bool parse_pes_header(const uint8_t* pes, size_t n, PesHeader* out) {
    static const uint8_t kStartCode[3] = {0x00, 0x00, 0x01};
    for (size_t i = 0; i < 3 && i < n; i++)
        if (pes[i] != kStartCode[i]) return false;
    PesHeader h;
    size_t need = 9;                      // header bytes, flagged fields included
    if (n >= 4) {
        h.sid = pes[3];
        if (no_optional_header(h.sid)) {
            h.header_len = 6;
            need = 6;
        } else {
            if (n >= 7) {
                if ((pes[6] & 0xC0) != 0x80) return false;     // the '10' marker
                h.data_alignment = (pes[6] & 0x04) != 0;
            }
            if (n >= 9) {
                h.header_len = 9 + pes[8];
                // Read at 9 and 14 whatever PES_header_data_length says, as
                // read_pes_pts does; '01' (forbidden) reads as no PTS, as there.
                const int flags = pes[7] >> 6;
                if (flags & 2) {
                    need = flags == 3 ? 19 : 14;
                    if (n >= 14) {
                        h.pts_off = 9;
                        h.pts = read_ts_field(pes + 9);
                    }
                    if (flags == 3 && n >= 19) {
                        h.dts_off = 14;
                        h.dts = read_ts_field(pes + 14);
                    }
                }
                need = std::max(need, (size_t)h.header_len);
            }
        }
        if (h.header_len > 0 && n >= 6) {
            const int64_t len = (pes[4] << 8) | pes[5];
            if (len > 0 && 6 + len >= h.header_len) h.payload_len = 6 + len - h.header_len;
        }
    }
    h.complete = h.header_len > 0 && n >= need;
    *out = h;
    return true;
}

void write_pes_ts_field(uint8_t* f, int64_t v33) {
    const uint64_t v = (uint64_t)v33;     // two's complement: the low 33 bits are v33 mod 2^33
    f[0] = (uint8_t)((f[0] & 0xF0) | (((v >> 30) & 0x07) << 1) | 0x01);
    f[1] = (uint8_t)((v >> 22) & 0xFF);
    f[2] = (uint8_t)((((v >> 15) & 0x7F) << 1) | 0x01);
    f[3] = (uint8_t)((v >> 7) & 0xFF);
    f[4] = (uint8_t)(((v & 0x7F) << 1) | 0x01);
}

bool rewrite_pes_timestamps(PacketView& v, const PesHeader& h, int64_t pts33, int64_t dts33) {
    if (!h.complete || v.payload_off >= PKT) return false;
    // A header parsed from other bytes must not steer a write past this packet.
    if (v.payload_off + std::max({h.header_len, h.pts_off + 5, h.dts_off + 5}) > PKT) return false;
    uint8_t* pes = v.p + v.payload_off;
    if (h.pts_off >= 0) write_pes_ts_field(pes + h.pts_off, pts33);
    if (h.dts_off >= 0) write_pes_ts_field(pes + h.dts_off, dts33);
    return true;
}

// --- PesHeaderSpan -------------------------------------------------------------

size_t PesHeaderSpan::find(int pid) const {
    size_t i = 0;
    while (i < held_.size() && held_[i].pid != pid) i++;
    return i;
}

bool PesHeaderSpan::hold(const PacketView& v) {
    if (!v.pusi || v.payload_off >= PKT || held(v.pid)) return false;
    if (v.pid == dup_pid_ && v.cc == dup_cc_) {
        dup_pid_ = -1;
        return false;
    }
    PesHeader h;
    if (!parse_pes_header(v.p + v.payload_off, PKT - v.payload_off, &h) || h.complete) return false;
    held_.emplace_back();
    Held& s = held_.back();
    s.pid = v.pid;
    s.payload_off = v.payload_off;
    s.cc = v.cc;
    std::memcpy(s.b, v.p, PKT);
    return true;
}

bool PesHeaderSpan::join(const Held& s, const PacketView& v, PesHeader* h) {
    // A duplicate (2.4.3.3, PCR aside): the decoder keeps the first copy, so a
    // rewrite of the second would pair new bytes with old. Every copy passes as is.
    if (v.pusi && v.cc == s.cc && v.payload_off == s.payload_off &&
        std::memcmp(v.p + v.payload_off, s.b + s.payload_off, PKT - v.payload_off) == 0) {
        dup_pid_ = v.pid;
        dup_cc_ = v.cc;
        return false;
    }
    // After a CC gap or at a new PES start the next bytes are not this header's.
    if (v.pusi || v.cc != ((s.cc + 1) & 0x0F)) return false;
    uint8_t buf[2 * PKT];
    const size_t k = PKT - s.payload_off, m = PKT - v.payload_off;
    std::memcpy(buf, s.b + s.payload_off, k);
    std::memcpy(buf + k, v.p + v.payload_off, m);
    return parse_pes_header(buf, k + m, h) && h->complete;
}

void PesHeaderSpan::write(Held& s, PacketView& v, const PesHeader& h, int64_t pts33,
                          int64_t dts33) {
    const int k = PKT - s.payload_off;
    auto put = [&](int off, int64_t val) {
        uint8_t* at[5];
        uint8_t f[5];
        for (int j = 0; j < 5; j++) {
            const int i = off + j;
            at[j] = i < k ? s.b + s.payload_off + i : v.p + v.payload_off + (i - k);
            f[j] = *at[j];
        }
        write_pes_ts_field(f, val);
        for (int j = 0; j < 5; j++) *at[j] = f[j];
    };
    if (h.pts_off >= 0) put(h.pts_off, pts33);
    if (h.dts_off >= 0) put(h.dts_off, dts33);
}

void PesHeaderSpan::release(size_t i, uint8_t* first) {
    std::memcpy(first, held_[i].b, PKT);
    held_.erase(held_.begin() + (std::ptrdiff_t)i);
}

void PesHeaderSpan::flush(std::vector<uint8_t>& out) {
    for (const Held& s : held_) out.insert(out.end(), s.b, s.b + PKT);
    broken_ += held_.size();
    held_.clear();
}

// --- PesAssembler --------------------------------------------------------------

void PesAssembler::select(int pid, bool on) {
    if (on)
        pids_.try_emplace(pid);
    else
        pids_.erase(pid);
}

void PesAssembler::feed(const PacketView& v, CcTracker::Result cc, std::vector<PesUnit>& out) {
    auto it = pids_.find(v.pid);
    if (it == pids_.end() || cc == CcTracker::Result::Duplicate) return;   // its bytes are in
    Pid& s = it->second;
    if (cc == CcTracker::Result::Lost || cc == CcTracker::Result::Reset) {
        if (s.open) {
            drop(s);
            dropped_cc_++;
        }
        s.lost = true;
    }
    if (v.payload_off >= PKT) return;
    const uint8_t* p = v.p + v.payload_off;
    const size_t n = PKT - v.payload_off;
    if (v.pusi) {
        if (s.open) close(s, out);
        begin(s, v.pid, p, n, out);
    } else if (s.open) {
        add(s, p, n, out);
    } else if (!s.started) {
        s.lost = true;                    // joined mid-PES: its head never came
    }
}

void PesAssembler::begin(Pid& s, int pid, const uint8_t* p, size_t n,
                         std::vector<PesUnit>& out) {
    s.started = true;
    PesHeader h;
    if (!parse_pes_header(p, n, &h)) {
        malformed_++;
        s.lost = true;
        return;
    }
    s.open = true;
    s.have_hdr = false;
    s.bytes = 0;
    s.unit.pid = pid;
    s.unit.hdr = PesHeader();
    s.unit.discont = s.lost;
    s.unit.seq = s.next_seq++;
    s.lost = false;
    if (h.complete) {
        open_body(s, h);
        body(s, p + h.header_len, n - h.header_len, out);
    } else {
        s.head.assign(p, p + n);
    }
}

void PesAssembler::add(Pid& s, const uint8_t* p, size_t n, std::vector<PesUnit>& out) {
    if (s.have_hdr) {
        body(s, p, n, out);
        return;
    }
    // A header cut by the packet boundary: re-parsed until it is whole (it is
    // at most 264 bytes, so this ends within two more packets).
    s.head.insert(s.head.end(), p, p + n);
    PesHeader h;
    if (!parse_pes_header(s.head.data(), s.head.size(), &h)) {
        drop(s);
        malformed_++;
        s.lost = true;
        return;
    }
    if (!h.complete) return;
    open_body(s, h);
    std::vector<uint8_t> head;
    head.swap(s.head);
    body(s, head.data() + h.header_len, head.size() - h.header_len, out);
}

void PesAssembler::open_body(Pid& s, const PesHeader& h) {
    s.unit.hdr = h;
    s.have_hdr = true;
    if (cfg_.keep_payload && h.payload_len > 0)
        s.unit.payload.reserve(std::min((size_t)h.payload_len, cfg_.max_bytes));
}

void PesAssembler::body(Pid& s, const uint8_t* p, size_t n, std::vector<PesUnit>& out) {
    const int64_t want = s.unit.hdr.payload_len;
    if (want >= 0) n = std::min(n, (size_t)want - s.bytes);   // past the end: stuffing
    if (n > cfg_.max_bytes - s.bytes) {
        drop(s);
        oversize_++;
        s.lost = true;
        return;
    }
    if (cfg_.keep_payload) s.unit.payload.insert(s.unit.payload.end(), p, p + n);
    s.bytes += n;
    if (want >= 0 && s.bytes == (size_t)want) emit(s, out);
}

void PesAssembler::close(Pid& s, std::vector<PesUnit>& out) {
    if (s.have_hdr && s.unit.hdr.payload_len < 0) {
        emit(s, out);
        return;
    }
    drop(s);
    malformed_++;
    s.lost = true;
}

void PesAssembler::emit(Pid& s, std::vector<PesUnit>& out) {
    s.unit.size = s.bytes;
    out.push_back(std::move(s.unit));
    s.unit = PesUnit();
    s.open = false;
    s.have_hdr = false;
}

void PesAssembler::drop(Pid& s) {
    s.open = false;
    s.have_hdr = false;
    std::vector<uint8_t>().swap(s.unit.payload);   // an oversize unit's memory goes now
    s.head.clear();
}

void PesAssembler::flush(std::vector<PesUnit>& out) {
    for (auto& kv : pids_) {
        Pid& s = kv.second;
        if (s.open) close(s, out);
        s.started = false;                // what follows may resume mid-PES
    }
}

void PesAssembler::reset() {
    for (auto& kv : pids_) {
        const uint64_t seq = kv.second.next_seq;
        kv.second = Pid();
        kv.second.next_seq = seq;
    }
}

}  // namespace mrts
