#include "ts_dump.h"

#include <array>
#include <cinttypes>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <utility>

namespace mrts {

uint32_t crc32_zlib(const uint8_t* data, size_t n) {
    static const std::array<uint32_t, 256> table = [] {
        std::array<uint32_t, 256> t{};
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            t[i] = c;
        }
        return t;
    }();
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) c = table[(c ^ data[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

namespace {

void add(std::string& s, const char* fmt, ...) {
    char buf[256];
    va_list ap, again;
    va_start(ap, fmt);
    va_copy(again, ap);
    const int n = std::vsnprintf(buf, sizeof buf, fmt, ap);
    if (n > 0 && (size_t)n < sizeof buf) {
        s.append(buf, (size_t)n);
    } else if (n > 0) {                   // longer than the buffer: format it again in place
        const size_t at = s.size();
        s.resize(at + (size_t)n + 1);
        std::vsnprintf(&s[at], (size_t)n + 1, fmt, again);
        s.resize(at + (size_t)n);
    }
    va_end(again);
    va_end(ap);
}

void add_hex(std::string& s, const std::vector<uint8_t>& b) {
    static const char d[] = "0123456789abcdef";
    for (uint8_t x : b) {
        s += d[x >> 4];
        s += d[x & 0x0F];
    }
}

void add_value(std::string& s, const char* key, bool present, int64_t v) {
    if (present)
        add(s, ",\"%s\":%" PRId64, key, v);
    else
        add(s, ",\"%s\":null", key);
}

}  // namespace

PesIndex::PesIndex(Sink sink, int program) : sink_(std::move(sink)) {
    if (program >= 0) disc_.select_program(program);
}

void PesIndex::feed(uint8_t* data, size_t len) {
    walker_.feed(data, len, [&](PacketView& v) { packet(v); });
}

void PesIndex::finish() {
    pes_.flush(units_);
    emit_units();
    uint64_t discarded = dts_discarded_;
    for (const auto& kv : uw_) discarded += kv.second.dts_discarded();
    std::string s;
    add(s, "{\"counters\":{\"desyncBytes\":%" PRIu64 ",\"ccLost\":%" PRIu64 ",\"pesOversize\":%" PRIu64
        ",\"pesDroppedCc\":%" PRIu64 ",\"pesMalformed\":%" PRIu64 ",\"unsupportedSections\":%" PRIu64
        ",\"dtsDiscarded\":%" PRIu64 "}}",
        walker_.desync_bytes(), cc_.lost(), pes_.oversize(), pes_.dropped_cc(), pes_.malformed(),
        disc_.unsupported_sections(), discarded);
    sink_(s);
}

void PesIndex::packet(const PacketView& v) {
    const CcTracker::Result cc = cc_.feed(v);
    if (v.pid == PID_PAT || v.pid == disc_.pmt_pid()) psi(v);
    pes_.feed(v, cc, units_);
    emit_units();
}

void PesIndex::psi(const PacketView& v) {
    std::memcpy(one_[0].b, v.p, PKT);
    disc_.feed(one_);
    if (disc_.pmt_pid() != pmt_pid_ || disc_.program() != program_) {
        pmt_pid_ = disc_.pmt_pid();
        program_ = disc_.program();
        std::string s;
        add(s, "{\"psi\":\"pat\",\"program\":%d,\"pmtPid\":%d}", program_, pmt_pid_);
        sink_(s);
    }
    if (disc_.generation() == gen_ || !disc_.pmt()) return;
    gen_ = disc_.generation();
    const Pmt& m = *disc_.pmt();
    std::string s;
    add(s, "{\"psi\":\"pmt\",\"program\":%d,\"version\":%d,\"gen\":%d,\"pcrPid\":%d,\"programInfo\":\"",
        m.program_number, m.version, gen_, m.pcr_pid);
    add_hex(s, m.program_info);
    s += "\",\"streams\":[";
    std::set<int> now;
    for (size_t i = 0; i < m.streams.size(); i++) {
        const PmtStream& st = m.streams[i];
        add(s, "%s{\"pid\":%d,\"type\":%d,\"esInfo\":\"", i ? "," : "", st.pid, st.stream_type);
        add_hex(s, st.es_info);
        s += "\"}";
        now.insert(st.pid);
    }
    s += "]}";
    sink_(s);
    for (int pid : selected_)
        if (!now.count(pid)) {
            pes_.select(pid, false);
            auto it = uw_.find(pid);
            if (it != uw_.end()) {
                dts_discarded_ += it->second.dts_discarded();
                uw_.erase(it);
            }
        }
    for (int pid : now) pes_.select(pid, true);
    selected_ = std::move(now);
}

// Each PID unwraps continuously; its first PTS lands nearest the program's
// latest one, so PIDs that start on either side of a wrap agree.
void PesIndex::emit_units() {
    for (const PesUnit& u : units_) {
        const PesHeader& h = u.hdr;
        int64_t pts_u = 0, dts_u = Unwrapper::NO_DTS;
        if (h.pts >= 0) {
            Unwrapper& w = uw_[u.pid];
            pts_u = w.feed(h.pts, have_ref_ ? ref_ : h.pts);
            dts_u = w.feed_dts(h.dts, pts_u);
            ref_ = pts_u;
            have_ref_ = true;
        }
        std::string s;
        add(s, "{\"pid\":%d,\"sid\":%d", u.pid, h.sid);
        add_value(s, "pts", h.pts >= 0, h.pts);
        add_value(s, "dts", h.dts >= 0, h.dts);
        add_value(s, "ptsUnwrapped", h.pts >= 0, pts_u);
        add_value(s, "dtsUnwrapped", dts_u != Unwrapper::NO_DTS, dts_u);
        add(s, ",\"len\":%zu,\"crc32\":\"%08x\",\"discont\":%s,\"seq\":%" PRIu64 "}", u.size,
            crc32_zlib(u.payload.data(), u.payload.size()), u.discont ? "true" : "false", u.seq);
        sink_(s);
    }
    units_.clear();
}

}  // namespace mrts
