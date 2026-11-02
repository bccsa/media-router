#include "ts_packet.h"

#include <cstring>

#include "ts_psi.h"

namespace mrts {

bool parse_packet(uint8_t* p, PacketView* out) {
    if (p[0] != SYNC_BYTE) return false;
    PacketView& v = *out;
    v.p = p;
    v.pid = ts_pid(p);
    v.cc = p[3] & 0x0F;
    v.tei = (p[1] & 0x80) != 0;
    v.pusi = ts_pusi(p);
    v.scrambled = (p[3] & 0xC0) != 0;
    v.has_af = (p[3] & 0x20) != 0;
    v.has_payload = ts_has_payload(p);
    v.af_len = v.has_af ? p[4] : 0;
    // The flags byte exists only in an AF of one byte or more; a PCR needs six
    // more (read_pcr's own test).
    const uint8_t flags = v.af_len >= 1 ? p[5] : 0;
    v.af_discontinuity = (flags & 0x80) != 0;
    v.af_rai = (flags & 0x40) != 0;
    v.af_pcr = v.af_len >= 7 && (flags & 0x10) != 0;
    const int off = payload_offset(p);
    v.payload_off = v.has_payload && off < PKT ? off : PKT;
    return true;
}

size_t PacketWalker::resync(size_t off, const uint8_t* data, size_t n) {
    // ts_split's scan, byte for byte, so SplitterCore can move onto the walker
    // (WI-S0-6) with identical output.
    size_t scan = off + 1;
    while (scan + PKT <= n &&
           !(at(scan, data) == SYNC_BYTE &&
             (scan + 2 * PKT > n || at(scan + PKT, data) == SYNC_BYTE)))
        scan++;
    desync_ += scan - off;
    return scan;
}

uint8_t* PacketWalker::join(size_t off, const uint8_t* data) {
    const size_t head = carry_len_ - off;
    std::memcpy(join_, carry_ + off, head);
    std::memcpy(join_ + head, data, PKT - head);
    return join_;
}

void PacketWalker::keep_tail(size_t off, const uint8_t* data, size_t n) {
    const size_t c = carry_len_;
    if (off >= c) {
        if (n > off) std::memcpy(carry_, data + (off - c), n - off);
    } else {
        // Nothing completed past the old carry: it keeps its unread part and
        // gains all of this (short) chunk.
        std::memmove(carry_, carry_ + off, c - off);
        if (n > c) std::memcpy(carry_ + (c - off), data, n - c);
    }
    carry_len_ = n - off;
}

namespace {
constexpr uint8_t CC_KNOWN = 0x10, CC_DUP = 0x20;
}  // namespace

CcTracker::Result CcTracker::feed(const PacketView& v) {
    if (v.pid == PID_NULL) return Result::Ok;    // CC is undefined on null packets
    uint8_t& s = state_[v.pid];
    if (v.af_discontinuity) {
        // An adaptation-only packet's CC says nothing about the next payload's.
        s = v.has_payload ? (uint8_t)(CC_KNOWN | v.cc) : 0;
        if (v.has_payload) keep(v);
        return Result::Reset;
    }
    if (!v.has_payload) return Result::Ok;
    const uint8_t last = s & 0x0F;
    if (!(s & CC_KNOWN) || v.cc == ((last + 1) & 0x0F)) {
        s = CC_KNOWN | v.cc;
        keep(v);
        return Result::Ok;
    }
    // A duplicate repeats its original's payload (2.4.3.3; only a PCR may differ). The same CC on
    // other bytes is new content after a loss, such as a source restarted on that CC (B-203).
    const bool copy = v.cc == last && repeats(v);
    if (copy && !(s & CC_DUP)) {
        s |= CC_DUP;
        return Result::Duplicate;
    }
    // A third copy keeps the duplicate mark, so a run of repeats stays an error.
    s = (uint8_t)(CC_KNOWN | (copy ? CC_DUP : 0) | v.cc);
    if (!copy) keep(v);
    lost_++;
    return Result::Lost;
}

void CcTracker::reset() {
    for (uint8_t& s : state_) s = 0;
}

void CcTracker::keep(const PacketView& v) {
    uint16_t& at = slot_[v.pid];
    if (!at) {
        last_.emplace_back();
        at = (uint16_t)last_.size();
    }
    Last& l = last_[at - 1];
    l.pusi = v.pusi;
    l.len = (uint8_t)(PKT - v.payload_off);
    std::memcpy(l.b, v.p + v.payload_off, l.len);
}

bool CcTracker::repeats(const PacketView& v) const {
    const uint16_t at = slot_[v.pid];
    if (!at) return false;
    const Last& l = last_[at - 1];
    return l.pusi == v.pusi && l.len == PKT - v.payload_off &&
           std::memcmp(l.b, v.p + v.payload_off, l.len) == 0;
}

}  // namespace mrts
