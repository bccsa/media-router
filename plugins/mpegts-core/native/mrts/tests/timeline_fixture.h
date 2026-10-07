// Fixture shared by the TimelineStamper suites (ts_timeline_test.cpp,
// ts_timeline_gap_test.cpp): hand-built PES and PCR packets, the stamp driver
// and the constants their python twins use (ts_psi_test.py's `pes_ts_packet`).
#pragma once
#include <cstring>
#include <vector>

#include "../ts_psi.h"
#include "../ts_timeline.h"

// Hand-built PES packet (ts_psi_test.cpp / gst_bus_stamper_test.py parity):
// PUSI, payload 00 00 01 <stream_id>, then the '10' marker, PTS_DTS_flags and
// the 5-byte PTS. `pts` < 0 = a PES with no PTS at all.
inline mrts::TsPacket pes_packet(int pid, int64_t pts, uint8_t stream_id = 0xE0) {
    mrts::TsPacket t;
    std::memset(t.b, 0xFF, mrts::PKT);
    t.b[0] = mrts::SYNC_BYTE;
    t.b[1] = 0x40 | ((pid >> 8) & 0x1F);
    t.b[2] = pid & 0xFF;
    t.b[3] = 0x10;
    int i = 4;
    t.b[i++] = 0x00;
    t.b[i++] = 0x00;
    t.b[i++] = 0x01;
    t.b[i++] = stream_id;
    t.b[i++] = 0x00;
    t.b[i++] = 0x00;
    t.b[i++] = 0x80;
    t.b[i++] = pts >= 0 ? 0x80 : 0x00;
    t.b[i++] = pts >= 0 ? 0x05 : 0x00;
    if (pts >= 0) {
        int64_t p = pts & (mrts::PTS_WRAP - 1);
        t.b[i++] = 0x21 | (uint8_t)(((p >> 30) & 0x07) << 1);
        t.b[i++] = (uint8_t)((p >> 22) & 0xFF);
        t.b[i++] = 0x01 | (uint8_t)(((p >> 15) & 0x7F) << 1);
        t.b[i++] = (uint8_t)((p >> 7) & 0xFF);
        t.b[i++] = 0x01 | (uint8_t)((p & 0x7F) << 1);
    }
    return t;
}

// The same PES start with a DTS after its PTS (vMix writes one while its pacer
// resets; ts_psi_test.py's `pes_ts_packet(..., dts=)`).
inline mrts::TsPacket pes_dts_packet(int pid, int64_t pts, int64_t dts, uint8_t stream_id = 0xE0) {
    mrts::TsPacket t = pes_packet(pid, pts, stream_id);
    t.b[4 + 7] = 0xC0;                                    // PTS and DTS
    t.b[4 + 8] = 0x0A;                                    // header data length 10
    t.b[4 + 9] = (uint8_t)((t.b[4 + 9] & 0x0F) | 0x30);   // '0011' prefix on the PTS
    const int64_t d = dts & (mrts::PTS_WRAP - 1);
    t.b[4 + 14] = (uint8_t)(0x11 | (((d >> 30) & 0x07) << 1));
    t.b[4 + 15] = (uint8_t)((d >> 22) & 0xFF);
    t.b[4 + 16] = (uint8_t)(0x01 | (((d >> 15) & 0x7F) << 1));
    t.b[4 + 17] = (uint8_t)((d >> 7) & 0xFF);
    t.b[4 + 18] = (uint8_t)(0x01 | ((d & 0x7F) << 1));
    return t;
}

// A PCR-only packet (adaptation field, no payload) on `pid`.
inline mrts::TsPacket pcr_packet(int pid, int64_t pcr27) {
    mrts::TsPacket t;
    mrts::build_pcr_packet(pid, pcr27, 0, t.b);
    return t;
}

// A PES start carrying the PCR in its adaptation field — where mpegtsmux puts
// every PCR (the .21 muxer's video PID, 2026-10-04).
inline mrts::TsPacket pes_pcr_packet(int pid, int64_t pts, int64_t pcr27, uint8_t stream_id = 0xE0) {
    mrts::TsPacket t = pcr_packet(pid, pcr27);
    const mrts::TsPacket pes = pes_packet(pid, pts, stream_id);
    t.b[1] |= 0x40;                                     // PUSI
    t.b[3] = 0x30;                                      // adaptation field + payload
    t.b[4] = 7;                                         // its flags + the 6 PCR bytes
    std::memcpy(t.b + 12, pes.b + 4, mrts::PKT - 12);   // the PES header after them
    return t;
}

// Signed, wrap-folded difference on an N-bit counter.
inline int64_t wrap_fold(int64_t d, int64_t m) {
    d %= m;
    if (d < 0) d += m;
    return d > m / 2 ? d - m : d;
}

inline std::vector<uint8_t> bytes_of(const std::vector<mrts::TsPacket>& pkts) {
    std::vector<uint8_t> out;
    for (const auto& p : pkts) out.insert(out.end(), p.b, p.b + mrts::PKT);
    return out;
}

inline int64_t stamp_of(mrts::TimelineStamper& s, const std::vector<mrts::TsPacket>& pkts, int64_t now,
                        int stream = 0) {
    auto data = bytes_of(pkts);
    return s.stamp(data.data(), data.size(), now, stream);
}

// python's `//` — a fixture that divides a negative product.
inline int64_t fdiv(int64_t a, int64_t b) {
    int64_t q = a / b;
    if (a % b != 0 && (a < 0) != (b < 0)) q--;
    return q;
}

constexpr int64_t STEP = 3600;             // 40 ms in 90 kHz ticks
constexpr int64_t STEP_NS = 40'000'000;
constexpr int64_t FIRST_PES = 8'100'000;   // 90 s
constexpr int64_t HOUSE = 1'000'000'000'000;
