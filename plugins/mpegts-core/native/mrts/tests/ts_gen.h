// Synthetic .ts fixtures (plan ch. 3 part 7.2, WI-S0-9) for fixture_gen --ts and
// ts_conformance_test: the port of py/native_parity_fixture.py (LCG and all) and the
// shapes no field capture reaches. Deterministic: one kind, one set of bytes.
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "../ts_house.h"
#include "../ts_packet.h"
#include "../ts_pcr.h"
#include "../ts_pes.h"
#include "../ts_psi.h"
#include "../ts_trace.h"
#include "trace_gen.h"

namespace ts_gen {

using Bytes = std::vector<uint8_t>;

inline void put(Bytes& out, const uint8_t* p, size_t n = mrts::PKT) { out.insert(out.end(), p, p + n); }

// --- Elementary-stream bytes that ffprobe and hls-pipe accept ----------------------------

// A real 1080i50 H.264 SPS, as py/native_parity_fixture.py carries it.
inline Bytes h264_sps() {
    static const char hex[] =
        "67640028ad843fff9087fff210ffffffffffffffff087fffffffffffffff"
        "2cc501e0113f780a10101014000003000400000300ca50";
    Bytes b;
    auto v = [](char c) { return c <= '9' ? c - '0' : c - 'a' + 10; };
    for (size_t i = 0; hex[i] && hex[i + 1]; i += 2) b.push_back((uint8_t)(v(hex[i]) << 4 | v(hex[i + 1])));
    return b;
}

// Seeded filler with the top bit set: no zero byte, so no start code is emulated, and
// every PES gets a crc32 of its own.
inline void fill(Bytes& b, size_t n, uint32_t seed) {
    uint32_t s = seed * 2654435761u + 1;
    while (b.size() < n) {
        s = s * 1664525u + 1013904223u;
        b.push_back((uint8_t)((s >> 24) | 0x80));
    }
}

enum class Es { h264_idr, h264, mp2, aac, teletext, data };

// n bytes of that ES (mp2: one 384-byte frame whatever n; teletext: 1 + 46 k bytes).
inline Bytes es_bytes(Es kind, size_t n, uint32_t seed) {
    Bytes b;
    switch (kind) {
        case Es::h264_idr: {
            b = {0, 0, 0, 1, 0x09, 0x10, 0, 0, 0, 1};
            const Bytes sps = h264_sps();
            b.insert(b.end(), sps.begin(), sps.end());
            const uint8_t rest[] = {0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65};
            b.insert(b.end(), rest, rest + sizeof rest);
            break;
        }
        case Es::h264: b = {0, 0, 0, 1, 0x09, 0x30, 0, 0, 1, 0x41}; break;
        case Es::mp2: b = {0xFF, 0xFD, 0x84, 0x00}; n = 384; break;   // Layer II, 128 kb/s, 48 kHz
        case Es::aac: {                    // ADTS, LC, 48 kHz, stereo, one raw block
            n = std::max<size_t>(n, 8);
            b = {0xFF, 0xF1, 0x4C, (uint8_t)(0x80 | (n >> 11)), (uint8_t)(n >> 3),
                 (uint8_t)(((n & 7) << 5) | 0x1F), 0xFC};
            break;
        }
        case Es::teletext: {               // data_identifier, then EBU data units of 44 bytes
            b = {0x10};
            const size_t units = std::max<size_t>(1, (n - 1) / 46);
            for (size_t u = 0; u < units; u++) {
                b.push_back(0x02);
                b.push_back(0x2C);
                fill(b, b.size() + 44, seed + (uint32_t)u);
            }
            return b;
        }
        case Es::data: break;
    }
    fill(b, n, seed);
    return b;
}

// --- A PES writer -------------------------------------------------------------------------

inline void ts_field(uint8_t* f, int prefix, int64_t v33) {
    f[0] = (uint8_t)(prefix << 4);
    mrts::write_pes_ts_field(f, v33);
}

// A PES header: PTS (and DTS when dts >= 0) unless pts < 0; payload_len -1 = unbounded.
inline Bytes pes_header(uint8_t sid, int64_t pts, int64_t dts, int64_t payload_len) {
    const bool has_dts = pts >= 0 && dts >= 0;
    const int fields = pts < 0 ? 0 : has_dts ? 10 : 5;
    Bytes h = {0, 0, 1, sid, 0, 0, 0x80, (uint8_t)(pts < 0 ? 0x00 : has_dts ? 0xC0 : 0x80), (uint8_t)fields};
    h.resize(9 + (size_t)fields, 0xFF);
    if (pts >= 0) ts_field(h.data() + 9, has_dts ? 3 : 2, pts);
    if (has_dts) ts_field(h.data() + 14, 1, dts);
    const int64_t len = payload_len < 0 ? 0 : (int64_t)h.size() - 6 + payload_len;
    h[4] = (uint8_t)(len >> 8);
    h[5] = (uint8_t)len;
    return h;
}

inline Bytes pes(uint8_t sid, int64_t pts, int64_t dts, const Bytes& es, bool bounded) {
    Bytes h = pes_header(sid, pts, dts, bounded ? (int64_t)es.size() : -1);
    h.insert(h.end(), es.begin(), es.end());
    return h;
}

// Packets with continuity counters per PID; an adaptation field carries the PCR, the
// discontinuity flag and the stuffing that ends a PES exactly at its last byte.
class Mux {
  public:
    explicit Mux(Bytes& out) : out_(out) {}
    void pat(int ts_id, const std::vector<std::pair<int, int>>& programs, int version = 0) {
        uint8_t p[mrts::PKT];
        mrts::build_pat(ts_id, programs, next_cc(mrts::PID_PAT), version, p);
        put(out_, p);
    }
    void pmt(int pmt_pid, int program, int pcr_pid, const std::vector<mrts::PmtStream>& streams,
             int version = 0) {
        uint8_t p[mrts::PKT];
        mrts::build_pmt(pmt_pid, program, pcr_pid, streams, next_cc(pmt_pid), version, p);
        put(out_, p);
    }
    // A PCR-only packet: adaptation field, no payload, the CC of the PID's last payload.
    void pcr(int pid, int64_t pcr27, bool discontinuity = false) {
        uint8_t p[mrts::PKT];
        mrts::build_pcr_packet(pid, pcr27, (cc_[pid] + 15) & 0x0F, discontinuity, p);
        put(out_, p);
    }
    // One packet with n payload bytes (<= 184; <= 176 with a PCR, <= 182 with the flag), the
    // adaptation field taking the rest. False, nothing written, when n does not fit.
    bool packet(int pid, bool pusi, const uint8_t* data, size_t n, int64_t pcr27 = -1, bool di = false) {
        const size_t af = 184 - std::min<size_t>(n, 184);   // adaptation bytes, length byte included
        if (n > 184 || (pcr27 >= 0 && af < 8) || (di && af < 2)) return false;
        uint8_t p[mrts::PKT];
        p[0] = mrts::SYNC_BYTE;
        p[1] = (uint8_t)((pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1F));
        p[2] = (uint8_t)(pid & 0xFF);
        p[3] = (uint8_t)((af ? 0x20 : 0x00) | (n ? 0x10 : 0x00) | (n ? next_cc(pid) : (cc_[pid] + 15) & 0x0F));
        size_t at = 4;
        if (af) {
            p[4] = (uint8_t)(af - 1);
            at = 5;
            if (af >= 2) {
                p[5] = (uint8_t)((di ? 0x80 : 0) | (pcr27 >= 0 ? 0x10 : 0));
                at = 6;
                if (pcr27 >= 0) {
                    const int64_t base = (pcr27 / 300) & 0x1FFFFFFFFLL, ext = pcr27 % 300;
                    p[6] = (uint8_t)(base >> 25);
                    p[7] = (uint8_t)(base >> 17);
                    p[8] = (uint8_t)(base >> 9);
                    p[9] = (uint8_t)(base >> 1);
                    p[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
                    p[11] = (uint8_t)ext;
                    at = 12;
                }
                std::memset(p + at, 0xFF, 4 + af - at);
                at = 4 + af;
            }
        }
        if (n) std::memcpy(p + at, data, n);
        put(out_, p);
        return true;
    }
    // A whole PES, a PCR or the flag in its first packet's adaptation field.
    void pes(int pid, const Bytes& b, int64_t pcr27 = -1, bool di = false) {
        const size_t first = std::min<size_t>(b.size(), pcr27 >= 0 ? 176 : di ? 182 : 184);
        packet(pid, true, b.data(), first, pcr27, di);
        rest(pid, b.data() + first, b.size() - first);
    }
    // Continuation packets (no PUSI) for these bytes.
    void rest(int pid, const uint8_t* b, size_t n) {
        for (size_t off = 0; off < n;) {
            const size_t k = std::min<size_t>(184, n - off);
            packet(pid, false, b + off, k);
            off += k;
        }
    }
    void reset_cc() { std::fill(std::begin(cc_), std::end(cc_), 0); }

  private:
    int next_cc(int pid) {
        const int c = cc_[pid];
        cc_[pid] = (c + 1) & 0x0F;
        return c;
    }
    Bytes& out_;
    int cc_[8192] = {};
};

// --- The port of py/native_parity_fixture.py ----------------------------------------------

constexpr int VIDEO_PID = 0x65, AUDIO_PID = 0xC9, OPUS_PID = 0xCA, KLV_PID = 0x1F0, PMT_PID = 0x30;

inline Bytes opus_desc() { return {0x05, 0x04, 'O', 'p', 'u', 's', 0x7f, 0x02, 0x80, 0x02}; }

// The python Lcg, the same sequence on every run and platform.
struct PyLcg {
    uint64_t s = 0x5EED;
    uint32_t next(uint32_t mod) {
        s = (s * 1103515245ULL + 12345ULL) & 0x7FFFFFFFULL;
        return (uint32_t)(s % mod);
    }
};

struct ParityCc {
    int pat = 0, pmt = 0, v = 0, a = 0, o = 0, k = 0;
};

inline void es_packet(Bytes& out, int pid, int cc, bool pusi, uint8_t value) {
    uint8_t p[mrts::PKT];
    p[0] = mrts::SYNC_BYTE;
    p[1] = (uint8_t)((pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1F));
    p[2] = (uint8_t)(pid & 0xFF);
    p[3] = (uint8_t)(0x10 | (cc & 0x0F));
    std::memset(p + 4, value, mrts::PKT - 4);
    put(out, p);
}

// Annex-B [SPS + filler IDR] in one PES without PTS, split into TS packets.
inline int video_pes_packets(Bytes& out, int pid, int cc) {
    Bytes es = {0, 0, 0, 1};
    const Bytes sps = h264_sps();
    es.insert(es.end(), sps.begin(), sps.end());
    es.insert(es.end(), {0, 0, 1, 0x65});
    es.insert(es.end(), 400, 0xAA);
    static const uint8_t head[9] = {0, 0, 1, 0xE0, 0, 0, 0x80, 0x00, 0x00};
    Bytes pes;
    pes.reserve(sizeof head + es.size());
    pes.insert(pes.end(), head, head + sizeof head);
    pes.insert(pes.end(), es.begin(), es.end());
    for (size_t off = 0; off < pes.size(); off += 184) {
        uint8_t p[mrts::PKT];
        std::memset(p, 0xFF, sizeof p);
        p[0] = mrts::SYNC_BYTE;
        p[1] = (uint8_t)((off == 0 ? 0x40 : 0x00) | ((pid >> 8) & 0x1F));
        p[2] = (uint8_t)(pid & 0xFF);
        p[3] = (uint8_t)(0x10 | (cc & 0x0F));
        const size_t n = std::min<size_t>(184, pes.size() - off);
        std::memcpy(p + 4, pes.data() + off, n);
        cc = (cc + 1) & 0x0F;
        put(out, p);
    }
    return cc;
}

// The second program of syn-mpts-two-programs: H.264 carrying its PCR, MPEG-1 audio, real
// PTS (video DTS 80 ms behind), its own PMT, its own jitter-free clock.
struct Program2 {
    static constexpr int PMT = 0x31, VIDEO = 0x165, AUDIO = 0x1C9;
    explicit Program2(Bytes& out) : m(out) {}
    Mux m;
    int64_t pts_v = 900000, pts_a = 900000;
    uint32_t n_v = 0, n_a = 0;
    void cycle(int i) {
        if (i % 25 == 0) {
            std::vector<mrts::PmtStream> s(2);
            s[0].pid = VIDEO;
            s[0].stream_type = mrts::STREAM_TYPE_AVC;
            s[1].pid = AUDIO;
            s[1].stream_type = 0x03;
            m.pmt(PMT, 2, VIDEO, s);
        }
        if (i % 10 == 5) m.pcr(VIDEO, (pts_v - 9000) * 300);
        if (i % 8 == 0) {                  // a 40 ms frame every 8 cycles, an IDR every 12th
            const Es k = n_v % 12 == 0 ? Es::h264_idr : Es::h264;
            m.pes(VIDEO, pes(0xE0, (pts_v + 7200) & 0x1FFFFFFFFLL, pts_v & 0x1FFFFFFFFLL,
                             es_bytes(k, 900 + (n_v * 53) % 500, 7000 + n_v), false));
            pts_v += 3600;
            n_v++;
        }
        if (i % 4 == 2) {                  // a 24 ms frame every 4 cycles
            m.pes(AUDIO, pes(0xC0, (pts_a + 9000) & 0x1FFFFFFFFLL, -1, es_bytes(Es::mp2, 0, 9000 + n_a), true));
            pts_a += 2160;
            n_a++;
        }
    }
};

// One segment of the python build(): PSI, jittered PCR, video PES, audio/opus/klv ES and
// desync garbage. q (mpts only) adds program 2 to the PAT and its packets to every cycle.
inline void parity_build(Bytes& out, int video_stream_type, int n_cycles, PyLcg& lcg, ParityCc& cc,
                         int64_t& pcr, Program2* q = nullptr) {
    using mrts::PmtStream;
    std::vector<PmtStream> streams(4);
    streams[0].pid = VIDEO_PID;
    streams[0].stream_type = video_stream_type;
    streams[1].pid = AUDIO_PID;
    streams[1].stream_type = mrts::STREAM_TYPE_AAC;
    streams[2].pid = OPUS_PID;
    streams[2].stream_type = mrts::STREAM_TYPE_PRIVATE_PES;
    streams[2].es_info = opus_desc();
    streams[3].pid = KLV_PID;
    streams[3].stream_type = mrts::STREAM_TYPE_KLV;
    std::vector<std::pair<int, int>> programs = {{1, PMT_PID}};
    if (q) programs.push_back({2, Program2::PMT});
    uint8_t p[mrts::PKT];
    for (int i = 0; i < n_cycles; i++) {
        if (i % 25 == 0) {
            mrts::build_pat(7, programs, cc.pat, 0, p);
            put(out, p);
            cc.pat = (cc.pat + 1) & 0xF;
            mrts::build_pmt(PMT_PID, 1, VIDEO_PID, streams, cc.pmt, 0, p);
            put(out, p);
            cc.pmt = (cc.pmt + 1) & 0xF;
        }
        if (i % 10 == 0) {
            pcr += 27000000 / 50 + lcg.next(27000);   // 20 ms + jitter
            mrts::build_pcr_packet(VIDEO_PID, pcr, cc.v, p);
            put(out, p);
        }
        if (i % 40 == 0) {
            cc.v = video_pes_packets(out, VIDEO_PID, cc.v);
        } else {
            for (int k = 0; k < 4; k++) {
                es_packet(out, VIDEO_PID, cc.v, false, 0xAA);
                cc.v = (cc.v + 1) & 0xF;
            }
        }
        es_packet(out, AUDIO_PID, cc.a, i % 5 == 0, 0xBB);
        cc.a = (cc.a + 1) & 0xF;
        if (i % 7 == 3) cc.o = (cc.o + 2) & 0xF;   // deliberate CC gap on the opus pid
        es_packet(out, OPUS_PID, cc.o, i % 5 == 1, 0xCC);
        cc.o = (cc.o + 1) & 0xF;
        if (i % 11 == 0) {
            es_packet(out, KLV_PID, cc.k, true, 0xDD);
            cc.k = (cc.k + 1) & 0xF;
        }
        if (q) q->cycle(i);
        if (i % 97 == 43) {                // deterministic desync garbage
            const uint8_t v = (uint8_t)lcg.next(0x40);
            out.insert(out.end(), 13 + lcg.next(160), v);
        }
    }
}

// native_parity_fixture.py's output exactly: 900 AVC cycles, then 4800 HEVC.
inline Bytes parity() {
    Bytes out;
    PyLcg lcg;
    ParityCc cc;
    int64_t pcr = 27000000;
    parity_build(out, mrts::STREAM_TYPE_AVC, 900, lcg, cc, pcr);
    parity_build(out, mrts::STREAM_TYPE_HEVC, 4800, lcg, cc, pcr);
    return out;
}

// syn-mpts-two-programs: the parity stream's program 1 (sparse PSI, PCR jitter, Opus, KLV,
// CC gaps, desync garbage, AVC -> HEVC) with a second program in the same PAT; 450 + 450
// cycles, since PsiDiscovery re-parses a changed PMT at once.
inline Bytes mpts_two_programs() {
    Bytes out;
    PyLcg lcg;
    ParityCc cc;
    int64_t pcr = 27000000;
    Program2 q(out);
    parity_build(out, mrts::STREAM_TYPE_AVC, 450, lcg, cc, pcr, &q);
    parity_build(out, mrts::STREAM_TYPE_HEVC, 450, lcg, cc, pcr, &q);
    return out;
}

// --- Streams of trace_gen's model, written as TS -----------------------------------------

// trace_gen's records (the PMT's table, then PCR and PES in send order) as TS: PAT + PMT
// every 500 ms, PCR-only packets, PES of real size (video unbounded, an IDR every 12th;
// MPEG-1 audio, AAC ADTS and teletext bounded). restart_at_ns >= 0: every CC starts again
// at 0 there, as a restarted mux does.
inline Bytes from_trace(const std::vector<mrts::TraceRecord>& recs, int64_t restart_at_ns = -1) {
    using mrts::TraceKind;
    Bytes out;
    Mux m(out);
    std::vector<mrts::PmtStream> streams;
    std::vector<uint32_t> n_by_pid(8192, 0);
    std::vector<int> type_by_pid(8192, 0);
    int pcr_pid = mrts::PID_NULL;
    const int pmt_pid = 0x1000;
    int64_t t0 = -1, last_psi = -1;
    bool restarted = false;
    for (const mrts::TraceRecord& r : recs) {
        if (t0 < 0) t0 = r.arrival_ns;
        if (r.kind == TraceKind::psi) {
            if (r.value & mrts::TRACE_PSI_PCR) {
                pcr_pid = r.pid;
                continue;
            }
            mrts::PmtStream s;
            s.pid = r.pid;
            s.stream_type = (int)((r.value >> 16) & 0xFF);
            if (s.stream_type == 0x06) s.es_info = {0x56, 0x05, 'e', 'n', 'g', 0x09, 0x88};   // teletext
            type_by_pid[r.pid] = s.stream_type;
            streams.push_back(s);
            continue;
        }
        if (r.kind == TraceKind::outage) continue;
        const int64_t t = r.arrival_ns - t0;
        if (restart_at_ns >= 0 && !restarted && t >= restart_at_ns) {
            m.reset_cc();
            restarted = true;
            last_psi = -1;
        }
        if (last_psi < 0 || t - last_psi >= 500 * trace_gen::MS) {
            m.pat(1, {{1, pmt_pid}});
            m.pmt(pmt_pid, 1, pcr_pid, streams);
            last_psi = t;
        }
        const bool di = (r.flags & mrts::TRACE_FLAG_DISCONTINUITY) != 0;
        if (r.kind == TraceKind::pcr) {
            m.pcr(r.pid, (int64_t)(r.value % (uint64_t)mrts::PCR_MODULO), di);
            continue;
        }
        const int64_t pts = (int64_t)r.value;
        const int64_t dts =
            r.dts_minus_pts_90k ? (pts + r.dts_minus_pts_90k + mrts::PTS_WRAP) % mrts::PTS_WRAP : -1;
        const uint32_t k = n_by_pid[r.pid]++;
        const uint32_t seed = (uint32_t)r.pid * 100000u + k;
        switch (type_by_pid[r.pid]) {
            case 0x1B:
                m.pes(r.pid, pes(0xE0, pts, dts, es_bytes(k % 12 == 0 ? Es::h264_idr : Es::h264,
                                                          k % 12 == 0 ? 3000 : 1000 + (k * 37) % 700, seed), false));
                break;
            case 0x03: m.pes(r.pid, pes(0xC0, pts, dts, es_bytes(Es::mp2, 0, seed), true)); break;
            case 0x0F: m.pes(r.pid, pes(0xC1, pts, dts, es_bytes(Es::aac, 300 + (k * 13) % 200, seed), true)); break;
            default: m.pes(r.pid, pes(0xBD, pts, dts, es_bytes(Es::teletext, 1 + 46 * 7, seed), true)); break;
        }
    }
    return out;
}

// syn-wrap-33bit: trace_gen's v (IPBB, the PCR), a1, a2, t with the PCR base wrapping 2^33
// wrap_at_ns in; PTS and DTS wrap with it, B-frame DTS behind PTS across the wrap.
inline Bytes wrap_33bit(int64_t wrap_at_ns = 5 * trace_gen::S) {
    trace_gen::Config c;
    c.wrap_at_ns = wrap_at_ns;
    c.duration_ns = 10 * trace_gen::S;
    c.pids = "v,a1,a2,t";
    c.jitter_mean_ns = 0;
    return from_trace(trace_gen::generate(c));
}

// syn-source-restart: the source restarts at_ns in: its timeline jumps +3 h, the first PCR
// after carries discontinuity_indicator, every CC starts again at 0.
inline Bytes source_restart(int64_t at_ns = 3 * trace_gen::S) {
    trace_gen::Config c;
    c.duration_ns = 6 * trace_gen::S;
    c.pids = "v,a1,a2";
    c.jitter_mean_ns = 0;
    c.jumps.push_back({at_ns, 3LL * 3600 * 1000 * trace_gen::MS, true});
    return from_trace(trace_gen::generate(c), at_ns);
}

// syn-pes-header-split: video PES whose header the PUSI packet's adaptation field cuts after
// 1..18 bytes (the PCR in that field every 4th), the rest in the PID's next packet, an AAC
// PES on another PID between the two.
inline Bytes pes_header_split() {
    Bytes out;
    Mux m(out);
    const int V = 0x100, A = 0x101, PMTP = 0x1000;
    std::vector<mrts::PmtStream> s(2);
    s[0].pid = V;
    s[0].stream_type = mrts::STREAM_TYPE_AVC;
    s[1].pid = A;
    s[1].stream_type = mrts::STREAM_TYPE_AAC;
    int64_t pts_v = 90000, pts_a = 90000 + 900;
    for (int i = 0; i < 72; i++) {
        if (i % 12 == 0) {
            m.pat(1, {{1, PMTP}});
            m.pmt(PMTP, 1, V, s);
        }
        const size_t cut = 1 + (size_t)(i % 18);   // header bytes in the PUSI packet
        const Bytes v = pes(0xE0, pts_v + 3600, pts_v,
                            es_bytes(i % 12 == 0 ? Es::h264_idr : Es::h264, 600 + 17 * (size_t)i, (uint32_t)i), false);
        const int64_t pcr = i % 4 == 0 ? (pts_v - 9000) * 300 : -1;
        m.packet(V, true, v.data(), cut, pcr);
        m.pes(A, pes(0xC1, pts_a, -1, es_bytes(Es::aac, 120 + (size_t)i, 1000u + (uint32_t)i), true));
        m.rest(V, v.data() + cut, v.size() - cut);
        pts_v += 3600;
        pts_a += 3600;
    }
    return out;
}

// syn-pes-no-pts: PES without PTS (PTS_DTS_flags 00) and the ids with no optional header
// (0xBE padding, 0xBF private_stream_2), among PES with PTS.
inline Bytes pes_no_pts() {
    Bytes out;
    Mux m(out);
    const int A = 0x101, P = 0x102, PMTP = 0x1000;
    std::vector<mrts::PmtStream> s(2);
    s[0].pid = A;
    s[0].stream_type = 0x03;
    s[1].pid = P;
    s[1].stream_type = mrts::STREAM_TYPE_PRIVATE_PES;
    int64_t pts = 900000;
    for (int i = 0; i < 48; i++) {
        if (i % 12 == 0) {
            m.pat(1, {{1, PMTP}});
            m.pmt(PMTP, 1, A, s);
            m.pcr(A, (pts - 9000) * 300);
        }
        // MPEG audio, every 3rd PES without a PTS.
        m.pes(A, pes(0xC0, i % 3 == 2 ? -1 : pts, -1, es_bytes(Es::mp2, 0, (uint32_t)i), true));
        // The private PID in turn: padding, private_stream_2, private_stream_1 without and with a PTS.
        const int kind = i % 4;
        const size_t n = 90 + (size_t)i;
        if (kind < 2) {
            Bytes h = {0, 0, 1, (uint8_t)(kind == 0 ? 0xBE : 0xBF), (uint8_t)(n >> 8), (uint8_t)n};
            if (kind == 0) h.insert(h.end(), n, 0xFF);
            else fill(h, h.size() + n, 500u + (uint32_t)i);
            m.pes(P, h);
        } else {
            m.pes(P, pes(0xBD, kind == 2 ? -1 : pts, -1, es_bytes(Es::data, n, 500u + (uint32_t)i), true));
        }
        pts += 2160;
    }
    return out;
}

// --- --drop: packets removed from a capture -----------------------------------------------

struct Drop {
    int pid;
    long index;                           // the PID's packet index in the input, from 0
};

// The input with those packets removed (a walk on the 188-byte grid; an unaligned tail stays).
inline Bytes drop(const Bytes& in, const std::vector<Drop>& d, size_t* removed) {
    Bytes out;
    std::vector<long> seen(8192, 0);
    *removed = 0;
    size_t off = 0;
    for (; off + mrts::PKT <= in.size(); off += mrts::PKT) {
        const uint8_t* p = in.data() + off;
        const int pid = mrts::ts_pid(p);
        const long idx = seen[pid]++;
        if (std::any_of(d.begin(), d.end(), [&](const Drop& x) { return x.pid == pid && x.index == idx; })) {
            (*removed)++;
            continue;
        }
        put(out, p);
    }
    out.insert(out.end(), in.begin() + (long)off, in.end());
    return out;
}

}  // namespace ts_gen
