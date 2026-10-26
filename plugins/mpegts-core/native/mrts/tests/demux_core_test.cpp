// demux_core (plan ch. 7 WI-P3-1; register B-121, B-122): mrts::DemuxCore, the cases of its
// Python reference's suite (py/demux_core_test.py) one for one, same names, same order (B-55's
// pattern; py/demux_core_parity_test.py holds the two lists equal), on hand-built programs and
// the conformance fixtures (tests/fixtures; MRTS_FIXTURES overrides). Case 12 is Phase 2's
// select mode, every case of the SelectDemux suite it replaces, on the ceil.
#include <dirent.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <tuple>
#include <vector>

#include "../demux_core.h"
#include "../ts_gap.h"
#include "../ts_house.h"
#include "../ts_packet.h"
#include "../ts_pcr.h"
#include "../ts_psi.h"
#include "../ts_rebase.h"
#include "check.h"

using namespace mrts;
using Bytes = std::vector<uint8_t>;
using Ev = DemuxEvent;
using K = DemuxEvent::Kind;

namespace {

constexpr int64_t MS = 1000000, SEC = 1000 * MS, H = 3600 * SEC;
constexpr int64_t BASE = MUX_CLOCK_BASE_90K, WRAP = PTS_WRAP;
constexpr int PMT_PID = 0x1000, PID_A = 0x41, PID_V = 0x100, PID_B = 0x42;
constexpr int64_t TICKS_20MS = 1800;            // 960 frames: exact in ns and in ticks

std::string g_fixtures;

std::string str(const char* fmt, long long a) {
    char b[512];
    std::snprintf(b, sizeof b, fmt, a);
    return b;
}

std::string str(const char* fmt, long long a, long long b2) {
    char b[512];
    std::snprintf(b, sizeof b, fmt, a, b2);
    return b;
}

int64_t fmod_(int64_t a, int64_t m) { return ((a % m) + m) % m; }

Bytes h(const char* s) {
    Bytes b;
    for (size_t i = 0; s[i] && s[i + 1]; i += 2)
        b.push_back((uint8_t)std::strtol(std::string(s + i, 2).c_str(), nullptr, 16));
    return b;
}

Bytes cat(Bytes a, const Bytes& b) {
    a.insert(a.end(), b.begin(), b.end());
    return a;
}

Bytes text(const char* s) { return Bytes(s, s + std::strlen(s)); }

// --- fixtures ----------------------------------------------------------------------------

std::map<std::string, Bytes> g_cache;

const Bytes& fixture(const std::string& name) {
    auto it = g_cache.find(name);
    if (it != g_cache.end()) return it->second;
    Bytes b;
    if (std::FILE* f = std::fopen((g_fixtures + "/" + name + ".ts").c_str(), "rb")) {
        uint8_t buf[65536];
        size_t k;
        while ((k = std::fread(buf, 1, sizeof buf, f)) > 0) b.insert(b.end(), buf, buf + k);
        std::fclose(f);
    }
    return g_cache[name] = b;
}

std::vector<std::string> list_dir(const char* suffix) {
    std::vector<std::string> names;
    const size_t n = std::strlen(suffix);
    if (DIR* d = opendir(g_fixtures.c_str())) {
        while (dirent* e = readdir(d)) {
            const std::string f = e->d_name;
            if (f.size() > n && f.compare(f.size() - n, n, suffix) == 0) names.push_back(f);
        }
        closedir(d);
    }
    std::sort(names.begin(), names.end());
    return names;
}

std::vector<std::string> fixture_names() {
    std::vector<std::string> names;
    for (const std::string& f : list_dir(".ts")) names.push_back(f.substr(0, f.size() - 3));
    std::sort(names.begin(), names.end());
    return names;
}

bool exists(const std::string& path) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f) std::fclose(f);
    return f != nullptr;
}

std::vector<std::string> read_lines(const std::string& path) {
    std::vector<std::string> out;
    std::ifstream f(path);
    for (std::string l; std::getline(f, l);) out.push_back(l);
    return out;
}

// One bus buffer of a sidecar: its bytes in the .ts, its PTS (-1 none), its GstBufferFlags.
struct Bus {
    size_t off = 0, len = 0;
    int64_t pts = -1;
    uint64_t flags = 0;
};

// The sidecar's flat lines: {"off":N,"len":N,"pts":N|null,"dts":..,"dur":..,"flags":N}.
int64_t field(const std::string& l, const char* key) {
    const std::string k = std::string("\"") + key + "\":";
    const size_t at = l.find(k);
    if (at == std::string::npos || l.compare(at + k.size(), 4, "null") == 0) return -1;
    return std::strtoll(l.c_str() + at + k.size(), nullptr, 10);
}

std::vector<Bus> sidecar(const std::string& name) {
    std::vector<Bus> bus;
    for (const std::string& l : read_lines(g_fixtures + "/" + name + ".bus.jsonl")) {
        if (l.find('{') == std::string::npos) continue;
        Bus b;
        b.off = (size_t)field(l, "off");
        b.len = (size_t)field(l, "len");
        b.pts = field(l, "pts");
        b.flags = (uint64_t)field(l, "flags");
        bus.push_back(b);
    }
    return bus;
}

// --- the replay (the reference's replay()) -------------------------------------------------

struct Run {
    std::vector<Ev> ev;
    DemuxCore::Counters k;
    std::vector<int> selected;
};

std::vector<std::string> lines(const std::vector<Ev>& ev) {
    std::vector<std::string> l;
    for (const Ev& e : ev) l.push_back(demux_jsonl(e));
    return l;
}

// Every event of `data` through one DemuxCore, then the drain: `chunk`-byte feeds, or per bus
// buffer (GAP buffers to marker(), DISCONT kept), at one house time (default: the first PES - 1 h).
Run replay_data(const Bytes& data, size_t chunk = 1316, uint32_t media = MEDIA_ALL,
                std::optional<int64_t> house = std::nullopt, const std::vector<Bus>* bus = nullptr,
                int program = -1) {
    DemuxCore::Config cfg;
    cfg.program = program;
    cfg.media_mask = media;
    DemuxCore core(cfg);
    const int64_t now = house ? *house : first_pes_house_ns(data.data(), data.size());
    Run r;
    if (!bus) {
        for (size_t at = 0; at < data.size(); at += chunk)
            core.feed(data.data() + at, std::min(chunk, data.size() - at), false, now, r.ev);
    } else {
        for (const Bus& b : *bus) {
            const size_t len = std::min(b.len, data.size() - std::min(b.off, data.size()));
            const uint8_t* p = data.data() + std::min(b.off, data.size());
            if (b.flags & 2048)
                core.marker(p, len, b.pts, r.ev);
            else
                core.feed(p, len, (b.flags & 64) != 0, now, r.ev);
        }
    }
    core.drain(r.ev);
    r.k = core.counters();
    r.selected = core.selected_pids();
    return r;
}

Run replay(const std::string& name, size_t chunk = 1316, uint32_t media = MEDIA_ALL,
           std::optional<int64_t> house = std::nullopt, const std::vector<Bus>* bus = nullptr,
           int program = -1) {
    return replay_data(fixture(name), chunk, media, house, bus, program);
}

std::vector<const Ev*> of(const std::vector<Ev>& ev, K kind, const char* pad = nullptr) {
    std::vector<const Ev*> r;
    for (const Ev& e : ev)
        if (e.kind == kind && (!pad || e.pad == pad)) r.push_back(&e);
    return r;
}

size_t index_of(const std::vector<Ev>& ev, const Ev* e) { return (size_t)(e - ev.data()); }

std::map<int, std::vector<const Ev*>> units_by_pid(const std::vector<Ev>& ev) {
    std::map<int, std::vector<const Ev*>> out;
    for (const Ev* e : of(ev, K::unit)) out[e->pid].push_back(e);
    return out;
}

std::vector<std::string> pad_names(const Ev& plan) {
    std::vector<std::string> n;
    for (const DemuxPad& p : plan.pads) n.push_back(p.name);
    return n;
}

// --- the stream builder (Phase 2's ts_select_test.cpp Ts) ---------------------------------

const Bytes BSSD = {0x05, 0x04, 'B', 'S', 'S', 'D'};

// A 302M payload: the AES3 header, then `frames` of channel pairs (5 bytes each at 16 bits).
Bytes s302m(int64_t frames, int channels = 2, int bits = 16, uint8_t fill = 0) {
    const int pair_bytes = (bits + 4) / 4;
    const uint32_t size = (uint32_t)(frames * channels / 2 * pair_bytes);
    const uint32_t hd = (size << 16) | ((uint32_t)(channels / 2 - 1) << 14) |
                        ((uint32_t)((bits - 16) / 4) << 4);
    Bytes p = {(uint8_t)(hd >> 24), (uint8_t)(hd >> 16), (uint8_t)(hd >> 8), (uint8_t)hd};
    for (uint32_t i = 0; i < size; i++) p.push_back((uint8_t)(fill + i * 7));
    return p;
}

void put_ts(Bytes& o, int prefix, int64_t v) {
    o.push_back((uint8_t)((prefix << 4) | (((v >> 30) & 7) << 1) | 1));
    o.push_back((uint8_t)(v >> 22));
    o.push_back((uint8_t)((((v >> 15) & 0x7F) << 1) | 1));
    o.push_back((uint8_t)(v >> 7));
    o.push_back((uint8_t)(((v & 0x7F) << 1) | 1));
}

Bytes gap_packet(int pid, uint8_t cc, int64_t length_ns) {
    Bytes p(PKT);
    build_gap_packet(pid, cc, length_ns, p.data());
    return p;
}

// A transport stream under construction: PSI, PES, raw packets, CC kept per PID.
struct Ts {
    Bytes b;
    std::map<int, uint8_t> cc;

    uint8_t next_cc(int pid) { return (uint8_t)(cc[pid]++ & 0x0F); }
    void pat(std::vector<std::pair<int, int>> programs = {{1, PMT_PID}}, int version = 0) {
        uint8_t p[PKT];
        build_pat(1, programs, next_cc(0), version, p);
        b.insert(b.end(), p, p + PKT);
    }
    void pmt(std::vector<PmtStream> streams, int pcr_pid, int version = 0, int pmt_pid = PMT_PID,
             int program = 1) {
        uint8_t p[PKT];
        build_pmt(pmt_pid, program, pcr_pid, streams, next_cc(pmt_pid), version, p);
        b.insert(b.end(), p, p + PKT);
    }
    void psi_302m(int pid = PID_A, int version = 0) {
        pat();
        pmt({{pid, STREAM_TYPE_PRIVATE_PES, BSSD}}, pid, version);
    }
    // One PES on `pid`: PTS (and DTS) raw 33-bit, -1 none; unbounded: PES_packet_length 0.
    void pes(int pid, int64_t pts33, const Bytes& payload, bool bounded = true, int64_t dts33 = -1) {
        Bytes opt;
        if (pts33 >= 0) put_ts(opt, dts33 >= 0 ? 3 : 2, pts33);
        if (dts33 >= 0) put_ts(opt, 1, dts33);
        Bytes body = {0x84, (uint8_t)(pts33 < 0 ? 0 : dts33 >= 0 ? 0xC0 : 0x80), (uint8_t)opt.size()};
        body.insert(body.end(), opt.begin(), opt.end());
        body.insert(body.end(), payload.begin(), payload.end());
        const size_t len = bounded ? body.size() : 0;
        Bytes d = {0, 0, 1, 0xBD, (uint8_t)(len >> 8), (uint8_t)len};
        d.insert(d.end(), body.begin(), body.end());
        size_t at = 0;
        for (bool first = true; first || at < d.size(); first = false) {
            uint8_t p[PKT];
            const size_t take = std::min<size_t>(184, d.size() - at);
            p[0] = SYNC_BYTE;
            p[1] = (uint8_t)((first ? 0x40 : 0) | ((pid >> 8) & 0x1F));
            p[2] = (uint8_t)pid;
            const uint8_t c = next_cc(pid);
            if (take == 184) {
                p[3] = (uint8_t)(0x10 | c);
                std::memcpy(p + 4, d.data() + at, 184);
            } else {                              // stuffing in the adaptation field
                const int af = (int)(183 - take);
                p[3] = (uint8_t)(0x30 | c);
                p[4] = (uint8_t)af;
                if (af > 0) {
                    p[5] = 0x00;
                    std::memset(p + 6, 0xFF, (size_t)af - 1);
                }
                std::memcpy(p + 5 + af, d.data() + at, take);
            }
            b.insert(b.end(), p, p + PKT);
            at += take;
        }
    }
    // The 302M PES of house tick `t` (the formula's inverse: PES = t + 1 h, 33 bits).
    void frame(int64_t t, int64_t frames = 960, int pid = PID_A) {
        pes(pid, (t + BASE) % WRAP, s302m(frames));
    }
    uint8_t last_cc(int pid) { return (uint8_t)((cc[pid] + 15) & 0x0F); }
};

DemuxCore::Config sel_cfg(int program = -1) {
    DemuxCore::Config c;
    c.select = CAPS_302M;
    c.program = program;
    return c;
}

// Feeds `ts` in `chunk`-byte pieces (0: at once) at house time `now`.
std::vector<Ev> run(DemuxCore& d, const Bytes& ts, int64_t now, size_t chunk = 0) {
    std::vector<Ev> out;
    if (!chunk) chunk = ts.size() ? ts.size() : 1;
    for (size_t at = 0; at < ts.size(); at += chunk)
        d.feed(ts.data() + at, std::min(chunk, ts.size() - at), false, now, out);
    return out;
}

std::vector<Ev> feed(DemuxCore& d, const Bytes& ts, int64_t now, bool discont = false) {
    std::vector<Ev> out;
    d.feed(ts.data(), ts.size(), discont, now, out);
    return out;
}

std::vector<Ev> marker(DemuxCore& d, const Bytes& m, int64_t end_ns) {
    std::vector<Ev> out;
    d.marker(m.data(), m.size(), end_ns, out);
    return out;
}

std::vector<Ev> drain(DemuxCore& d) {
    std::vector<Ev> out;
    d.drain(out);
    return out;
}

void append(std::vector<Ev>& a, std::vector<Ev> b) {
    for (Ev& e : b) a.push_back(std::move(e));
}

int64_t ceil_ns(int64_t ticks) { return pts90k_to_ns_ceil(ticks); }

// --- 1 classify ----------------------------------------------------------------------------

const char OPUS_STEREO[] = "audio/x-opus, rate=(int)48000, channels=(int)2, channel-mapping-family=(int)0, "
                           "stream-count=(int)1, coupled-count=(int)1";
const char OPUS_51[] = "audio/x-opus, rate=(int)48000, channels=(int)6, channel-mapping-family=(int)1, "
                       "stream-count=(int)4, coupled-count=(int)2, channel-mapping=(int)< 0, 4, 1, 2, 3, 5 >";
const char CAPS_H264[] = "video/x-h264, stream-format=(string)byte-stream";
const char CAPS_H265[] = "video/x-h265, stream-format=(string)byte-stream";
const char CAPS_AV1[] = "video/x-av1, stream-format=(string)obu-stream, alignment=(string)frame";
const char CAPS_MPA[] = "audio/mpeg, mpegversion=(int)1";
const char CAPS_ADTS[] = "audio/mpeg, mpegversion=(int)4, stream-format=(string)adts";
const char CAPS_LOAS[] = "audio/mpeg, mpegversion=(int)4, stream-format=(string)loas";
const char CAPS_AC3[] = "audio/x-ac3";
const char CAPS_EAC3[] = "audio/x-eac3";
const char CAPS_TTX[] = "application/x-teletext";
const char CAPS_DVBSUB[] = "subpicture/x-dvb";
const char CAPS_KLV[] = "meta/x-klv, parsed=(boolean)true";
const char CAPS_ID3[] = "meta/x-id3, parsed=(boolean)false";

std::string mpv(int v) {
    return "video/mpeg, mpegversion=(int)" + std::to_string(v) + ", systemstream=(boolean)false";
}

void test_classify() {
    struct Row {
        const char* name;
        int type;
        Bytes loop;
        const char* cls;
        std::string caps;
        bool sparse;
        const char* post;
        const char* lang;
    };
    const std::vector<Row> rows = {
        {"0x01 MPEG-1 video", 0x01, {}, "video", mpv(1), false, "none", ""},
        {"0x02 MPEG-2 video (tp-mpeg2video-mp2)", 0x02, {}, "video", mpv(2), false, "none", ""},
        {"0x1B H.264 (cap-occ's loop)", 0x1B, h("0e03c0c350"), "video", CAPS_H264, false, "none", ""},
        {"0x24 HEVC (tp-hevc-aac's loop)", 0x24, h("050448455643"), "video", CAPS_H265, false, "none", ""},
        {"0x06 + registration HEVC", 0x06, h("050448455643"), "video", CAPS_H265, false, "none", ""},
        {"0x06 + registration AV1G", 0x06, h("050441563147"), "video", CAPS_AV1, false, "none", ""},
        {"0x03 MPEG-1 audio (tp-mpeg2video-mp2)", 0x03, {}, "audio", CAPS_MPA, false, "none", ""},
        {"0x04 MPEG-2 audio", 0x04, {}, "audio", CAPS_MPA, false, "none", ""},
        {"0x0F AAC ADTS (cap-occ's loop: nor, 0x7C, 0x0E)", 0x0F, h("0a046e6f72007c035180030e03c003c0"),
         "audio", CAPS_ADTS, false, "adts", "nor"},
        {"0x11 AAC LATM (tp-h264-latm)", 0x11, {}, "audio", CAPS_LOAS, false, "none", ""},
        {"0x81 AC-3 (tp-h264-ac3-eac3's loop)", 0x81, h("050441432d33"), "audio", CAPS_AC3, false, "none", ""},
        {"0x81 + 0x7A: E-AC-3, tsdemux's rule", 0x81, h("7a0100"), "audio", CAPS_EAC3, false, "none", ""},
        {"0x06 + DVB AC-3 0x6A (system-b's loop)", 0x06, h("050441432d336a03c04208"), "audio", CAPS_AC3,
         false, "none", ""},
        {"0x87 E-AC-3 (tp-h264-ac3-eac3's loop)", 0x87, h("050445414333"), "audio", CAPS_EAC3, false, "none",
         ""},
        {"0x06 + DVB E-AC-3 0x7A (system-b's loop)", 0x06, h("0504454143337a0100"), "audio", CAPS_EAC3, false,
         "none", ""},
        {"0x06 + Opus stereo (cap-mux-align7's loop)", 0x06, h("0a046e6f720005044f7075737f028002"), "audio",
         OPUS_STEREO, false, "opus", "nor"},
        {"0x06 + Opus 5.1 (tp-opus-51's loop)", 0x06, h("05044f7075737f028006"), "audio", OPUS_51, false, "opus",
         ""},
        {"0x06 + BSSD (cap-302m-bssd's loop)", 0x06, BSSD, "audio", CAPS_302M, false, "none", ""},
        {"0x06 + teletext 0x56 (syn-wrap-33bit's loop)", 0x06, h("5605656e670988"), "private", CAPS_TTX, true,
         "none", ""},
        {"0x06 + DVB subtitling 0x59 (tp-h264-dvbsub's loop: und)", 0x06, h("5908756e641000010152"),
         "subpicture", CAPS_DVBSUB, true, "none", "und"},
        {"0x06 + KLVA (cap-klv-sparse's loop)", 0x06, h("05044b4c5641"), "private", CAPS_KLV, true, "none", ""},
        {"0x15 + metadata KLVA: cells split", 0x15, h("260dffff4b4c5641ff4b4c5641000f"), "private", CAPS_KLV,
         true, "klv", ""},
        {"0x06 + ID3", 0x06, h("050449443320"), "private", CAPS_ID3, true, "none", ""},
        {"0x15 + metadata ID3 (tp-id3's loop)", 0x15, h("260dffff49443320ff49443320000f050449443320"),
         "private", CAPS_ID3, true, "none", ""},
    };
    for (const Row& r : rows) {
        const std::optional<EsPlan> es = classify(r.type, r.loop);
        CHECK(("1 classify: " + std::string(r.name)).c_str(),
              es && std::string(es_class_name(es->cls)) == r.cls && es->caps == r.caps &&
                  es->sparse == r.sparse && std::string(au_post_name(es->post)) == r.post &&
                      es->lang == r.lang);
    }
    const auto opus = classify(0x06, h("05044f7075737f028006"));
    const auto av1 = classify(0x06, h("050441563147800481080c00"));
    CHECK("1 classify: the Opus extension and the AV1 descriptor bodies kept for the element",
          opus && av1 && opus->opus_ext == h("8006") && av1->av1_desc == h("81080c00") &&
              av1->caps == CAPS_AV1);
    // tsdemux's precedence where two rows match one loop: the descriptor before the registration.
    const auto ttx = classify(0x06, h("5605656e670988050442535344"));
    CHECK("1 classify: teletext before BSSD on one loop (tsdemux's order)", ttx && ttx->caps == CAPS_TTX);
    const std::vector<std::pair<const char*, std::pair<int, Bytes>>> none = {
        {"0x06 bare", {0x06, {}}},
        {"0x86 SCTE-35", {0x86, {}}},
        {"0x82 DTS (tp-h264-dts)", {0x82, {}}},
        {"0x8A DTS", {0x8A, {}}},
        {"0x06 + DTS1", {0x06, h("050444545331")}},
        {"0x06 + AC-4's extension", {0x06, h("7f0215ab")}},
        {"0x06 + Opus, no extension", {0x06, h("05044f707573")}},
        {"0x15 without a metadata descriptor", {0x15, {}}},
        {"0x05 sections", {0x05, {}}},
        {"0x0B DSM-CC", {0x0B, {}}},
    };
    std::string names;
    bool all_none = true;
    for (const auto& n : none) {
        names += (names.empty() ? "" : ", ") + std::string(n.first);
        all_none &= !classify(n.second.first, n.second.second);
    }
    CHECK(("1 classify: no row for " + names).c_str(), all_none);
    CHECK("1 classify: section types are no unknown stream (0x05, 0x0B, 0x86)",
          section_only_type(0x05) && section_only_type(0x0B) && section_only_type(0x86) &&
              !section_only_type(0x06) && !section_only_type(0x82) && !section_only_type(0x15));
    CHECK("1 classify: an unknown stream's class: DTS in any form and AC-4 audio, 0x06 bare private",
          unknown_class(0x82, {}) == EsClass::Audio && unknown_class(0x8A, {}) == EsClass::Audio &&
              unknown_class(0x06, h("050444545331")) == EsClass::Audio &&
              unknown_class(0x06, h("7f0215ab")) == EsClass::Audio &&
                  unknown_class(0x06, {}) == EsClass::Private &&
              unknown_class(0x15, {}) == EsClass::Private);
    CHECK("1 classify: registration_format is the first 0x05's, 0 when it is short (tsdemux)",
          registration_format(h("0a04656e6700050442535344")) == 0x42535344 &&
              registration_format(h("05024253050442535344")) == 0 && registration_format({}) == 0);
    CHECK("1 classify: language: the first 0x0A's last entry, else the 0x59's; under 2 bytes none",
          language(h("0a08656e6700646575000a04667261005908656e671000010152")) == "deu" &&
              language(h("5908756e641000010152")) == "und" && language(h("0a0400000000")).empty());
    // Every channel configuration tsdemux reads, its caps as tsdemux 1.28.2 makes them (measured).
    auto fam255 = [](int s, int c) {
        return "channels=(int)2, channel-mapping-family=(int)255, stream-count=(int)" + std::to_string(s) +
               ", coupled-count=(int)" + std::to_string(c);
    };
    const std::vector<std::pair<const char*, std::string>> opus_rows = {
        {"8000", fam255(1, 1) + ", channel-mapping=(int)< 0, 1 >"},
        {"8080", fam255(2, 0) + ", channel-mapping=(int)< 0, 1 >"},
        {"8001", "channels=(int)1, channel-mapping-family=(int)0, stream-count=(int)1, coupled-count=(int)0"},
        {"8003", "channels=(int)3, channel-mapping-family=(int)1, stream-count=(int)2, coupled-count=(int)1, "
                 "channel-mapping=(int)< 0, 2, 1 >"},
        {"8008", "channels=(int)8, channel-mapping-family=(int)1, stream-count=(int)5, coupled-count=(int)3, "
                 "channel-mapping=(int)< 0, 6, 1, 2, 3, 4, 5, 7 >"},
        {"8082", "channels=(int)2, channel-mapping-family=(int)1, stream-count=(int)2, coupled-count=(int)0, "
                 "channel-mapping=(int)< 0, 1 >"},
        {"8088", "channels=(int)8, channel-mapping-family=(int)1, stream-count=(int)8, coupled-count=(int)0, "
                 "channel-mapping=(int)< 0, 1, 2, 3, 4, 5, 6, 7 >"},
        {"80810200", "channels=(int)2, channel-mapping-family=(int)0, stream-count=(int)1, coupled-count=(int)1"},
        {"8081020205", "channels=(int)2, channel-mapping-family=(int)2, stream-count=(int)1, "
                       "coupled-count=(int)0, channel-mapping=(int)< 1, 1 >"},
        {"8081040130298000", "channels=(int)4, channel-mapping-family=(int)1, stream-count=(int)2, "
                             "coupled-count=(int)2, channel-mapping=(int)< 0, 1, 2, 3 >"},
    };
    bool opus_ok = true;
    for (const auto& r : opus_rows) {
        const auto c = opus_caps(h(r.first));
        opus_ok &= c && *c == "audio/x-opus, rate=(int)48000, " + r.second;
    }
    CHECK("1 classify: Opus caps for the dual-mono, 1-8, 0x82-0x88 and extended configurations", opus_ok);
    CHECK("1 classify: no Opus pad for code 0x89, a short extension or a bit field past its end",
          !opus_caps(h("8089")) && !opus_caps(h("80")) && !opus_caps(h("7f02")) &&
              !opus_caps(h("8081040161")));
}

// --- 2 pad names -----------------------------------------------------------------------------

void test_pad_name() {
    CHECK("2 pad_name: (audio, 0, 0x141) is audio_0_0141", pad_name(EsClass::Audio, 0, 0x141) == "audio_0_0141");
    CHECK("2 pad_name: (private, 17, 0x1FFF) is private_1_1fff: the generation in 4 bits",
          pad_name(EsClass::Private, 17, 0x1FFF) == "private_1_1fff");
    const Run r = replay("cap-mux-align7-aac-opus");
    const auto plans = of(r.ev, K::plan);
    CHECK("2 pad_name: the first program is generation 0 (audio_0_0100, audio_0_0108, as tsdemux)",
          plans.size() == 1 && plans[0]->generation == 0 &&
              pad_names(*plans[0]) == std::vector<std::string>{"audio_0_0100", "audio_0_0108"});
    Ts t;
    t.pat();
    for (int k = 0; k < 18; k++) t.pmt({{PID_V, k % 2 == 0 ? 0x1B : 0x24, {}}}, PID_V, k % 32);
    DemuxCore d;
    const auto ev = run(d, t.b, 100 * SEC);
    std::vector<std::string> names;
    for (const Ev* p : of(ev, K::plan)) names.push_back(p->pads[0].name);
    CHECK("2 pad_name: 18 programs, generations 0-17, named 0-f then 0, 1 again",
          names.size() == 18 && names[15] == "video_f_0100" && names[16] == "video_0_0100" &&
              names[17] == "video_1_0100" && of(ev, K::plan)[17]->generation == 17);
}

// --- 3 the 33-bit wrap -------------------------------------------------------------------------

void test_wrap() {
    const Run r = replay("syn-wrap-33bit");
    const auto by = units_by_pid(r.ev);
    bool steady = true, behind = true;
    size_t crossed = 0, bframes = 0, straddle = 0;
    for (const auto& kv : by) {
        const auto& us = kv.second;
        for (size_t i = 1; i < us.size(); i++) {
            steady &= std::llabs(us[i]->pts_ns - us[i - 1]->pts_ns) < SEC;
            if (us[i]->hdr.pts < us[i - 1]->hdr.pts - (1LL << 32)) crossed++;
        }
        for (const Ev* u : us) {
            if (u->hdr.dts >= 0) {
                bframes++;
                behind &= u->pts_ns - u->dts_ns >= 0 && u->pts_ns - u->dts_ns < 5 * SEC;
                if ((u->hdr.pts < (1LL << 32)) != (u->hdr.dts < (1LL << 32))) straddle++;
            }
        }
    }
    CHECK("3 syn-wrap-33bit: every pad's PTS continuous across 2^33 (each PID wraps once)",
          steady && crossed == by.size() && by.size() == 4);
    CHECK("3 syn-wrap-33bit: a B-frame DTS under 5 s behind its PTS, never 2^33 off, the wrap between "
          "them too",
          behind && bframes == 84 && straddle == 1);
}

// --- 4 chunking ---------------------------------------------------------------------------------

void test_chunking() {
    std::map<size_t, std::vector<std::string>> out;
    for (size_t chunk : {(size_t)188, (size_t)1000, (size_t)1316, (size_t)24576}) {
        const Run r = replay("cap-mux-align7-aac-opus", chunk);
        out[chunk] = lines(r.ev);
        out[chunk].push_back(demux_jsonl(r.k));
    }
    bool all = out[188].size() > 900;
    for (const auto& kv : out) all &= kv.second == out[188];
    CHECK("4 cap-mux-align7-aac-opus: 188, 1000, 1316 and 24576-byte feeds give identical events", all);
    size_t n = 0;
    bool same = true;
    for (const std::string& name : fixture_names()) {
        const Run a = replay(name, 188), b = replay(name, 24576);
        same &= lines(a.ev) == lines(b.ev) && demux_jsonl(a.k) == demux_jsonl(b.k);
        n++;
    }
    CHECK(str("4 every fixture: 188 and 24576-byte feeds give identical events (%lld fixtures)", (long long)n)
              .c_str(),
          n >= 30 && same);
}

// --- 5 PES without PTS ----------------------------------------------------------------------------

void test_no_pts() {
    const Run r = replay("syn-pes-no-pts");
    std::vector<const Ev*> untimed;
    for (const Ev* u : of(r.ev, K::unit))
        if (u->pts_ns < 0) untimed.push_back(u);
    size_t dumped = 0;
    for (const std::string& l : read_lines(g_fixtures + "/syn-pes-no-pts.expect.jsonl"))
        dumped += l.find("\"pid\":257,") != std::string::npos && l.find("\"pts\":null") != std::string::npos;
    bool none = true;
    for (const Ev* u : untimed) none &= u->dts_ns < 0 && u->dur_ns < 0;
    CHECK("5 syn-pes-no-pts: units without a PTS leave untimed (PTS, DTS, duration none)",
          untimed.size() == dumped && dumped == 16 && none);
    CHECK("5 syn-pes-no-pts: pes-no-pts counts them", r.k.pes_no_pts == untimed.size());
}

// --- 6 a hole without a marker --------------------------------------------------------------------

void test_gap_500ms() {
    const Run r = replay("syn-gap-500ms");
    const auto gaps = of(r.ev, K::gap);
    const auto audio = of(r.ev, K::gap, "audio_0_0102");
    const int64_t frame = 1024 * SEC / 48000;
    CHECK("6 syn-gap-500ms: one gap of 500 ms +- one frame on the audio pad, a jump",
          audio.size() == 1 && std::llabs(audio[0]->dur_ns - 500 * MS) <= frame &&
              std::string(audio[0]->reason) == "jump");
    std::vector<const Ev*> after;
    for (const Ev* u : of(r.ev, K::unit, "audio_0_0102"))
        if (!audio.empty() && u->pts_ns >= audio[0]->pts_ns) after.push_back(u);
    CHECK("6 syn-gap-500ms: the next audio unit at the gap's end, DISCONT",
          !after.empty() && after[0]->pts_ns == audio[0]->pts_ns + audio[0]->dur_ns && after[0]->discont);
    CHECK("6 syn-gap-500ms: none on video (520 ms, under 1 s), none on teletext (sparse, fed every "
          "500 ms)",
          gaps.size() == 1 && of(r.ev, K::gap, "video_0_0100").empty() &&
              of(r.ev, K::gap, "private_0_0103").empty());
    // The other loss: a bus buffer flagged DISCONT (bytes may be missing before it).
    const Bytes& data = fixture("cap-mux-align7-aac-opus");
    const int64_t now = first_pes_house_ns(data.data(), data.size());
    const Run whole = replay("cap-mux-align7-aac-opus");
    const size_t cut = 2000 * PKT + 100;      // inside a PES of each PID, not on a packet edge
    DemuxCore d;
    std::vector<Ev> out;
    d.feed(data.data(), cut, false, now, out);
    std::map<std::string, int64_t> before;
    for (const Ev* u : of(out, K::unit)) before[u->pad] = u->pts_ns;
    out.clear();
    d.feed(data.data() + cut, data.size() - cut, true, now, out);
    d.drain(out);
    std::map<std::string, const Ev*> nxt;
    for (const Ev* u : of(out, K::unit)) nxt.emplace(u->pad, u);
    std::vector<std::pair<std::string, int64_t>> lost, rest, got;
    bool all_discont = true;
    for (const auto& kv : nxt) all_discont &= kv.second->discont;
    for (const Ev* u : of(whole.ev, K::unit)) {
        if (nxt.count(u->pad) && before.count(u->pad) && before[u->pad] < u->pts_ns &&
            u->pts_ns < nxt[u->pad]->pts_ns)
            lost.push_back({u->pad, u->pts_ns});
        if (before.count(u->pad) && u->pts_ns > before[u->pad]) rest.push_back({u->pad, u->pts_ns});
    }
    got = lost;
    for (const Ev* u : of(out, K::unit)) got.push_back({u->pad, u->pts_ns});
    std::sort(got.begin(), got.end());
    std::sort(rest.begin(), rest.end());
    CHECK("6 a bus DISCONT mid-stream: the PES open at it dropped (AAC's here), nothing else lost, "
          "every pad's next unit DISCONT",
          nxt.size() == 2 && all_discont && lost.size() == 1 && lost[0].first == "audio_0_0100" &&
              got == rest);
}

// --- 7 a hole with markers --------------------------------------------------------------------------

const Ev* last_before(const std::vector<Ev>& ev, const std::string& pad, size_t at) {
    const Ev* last = nullptr;
    for (size_t i = 0; i < at; i++)
        if (ev[i].kind == K::unit && ev[i].pad == pad) last = &ev[i];
    return last;
}

// The end of the pad's last unit before index `at`: its PTS + the upper median of its last 8
// spacings (SelectDemux's frame).
int64_t horizon_before(const std::vector<Ev>& ev, const std::string& pad, size_t at) {
    std::vector<int64_t> us;
    for (size_t i = 0; i < at; i++)
        if (ev[i].kind == K::unit && ev[i].pad == pad) us.push_back(ev[i].pts_ns);
    if (us.size() > 9) us.erase(us.begin(), us.end() - 9);
    std::vector<int64_t> sp;
    for (size_t i = 1; i < us.size(); i++) sp.push_back(us[i] - us[i - 1]);
    std::sort(sp.begin(), sp.end());
    return sp.empty() ? -1 : us.back() + sp[sp.size() / 2];
}

void test_gap_marker() {
    const std::vector<Bus> bus = sidecar("syn-gap-marker");
    const Run r = replay("syn-gap-marker", 1316, MEDIA_ALL, std::nullopt, &bus);
    const auto gaps = of(r.ev, K::gap);
    std::vector<std::pair<std::string, std::string>> kinds;
    for (const Ev* g : gaps) kinds.push_back({g->pad, g->reason});
    CHECK("7 syn-gap-marker: one marker gap per marked PID (video, audio), no jump, none on teletext",
          kinds == std::vector<std::pair<std::string, std::string>>{{"video_0_0100", "marker"},
                                                                    {"audio_0_0102", "marker"}} &&
              r.k.markers == 2 && r.k.markers_dropped == 0);
    bool ok = gaps.size() == 2;
    for (const Ev* g : gaps) {
        const size_t i = index_of(r.ev, g);
        const Ev* nxt = nullptr;
        for (size_t j = i + 1; j < r.ev.size() && !nxt; j++)
            if (r.ev[j].kind == K::unit && r.ev[j].pad == g->pad) nxt = &r.ev[j];
        const Ev* last = last_before(r.ev, g->pad, i);
        ok &= nxt && last && g->pts_ns == horizon_before(r.ev, g->pad, i) &&
            g->pts_ns + g->dur_ns == nxt->pts_ns;
        ok &= nxt && last && nxt->discont && !last->discont;
    }
    CHECK("7 syn-gap-marker: each gap from its pad's last unit's end to the next unit's PTS, DISCONT "
          "next",
          ok);
    const size_t vi = gaps.empty() ? 0 : index_of(r.ev, gaps[0]);
    const Ev* vlast = gaps.empty() ? nullptr : last_before(r.ev, "video_0_0100", vi);
    CHECK("7 syn-gap-marker: the video PES open at the marker (unbounded) leaves before its gap",
          vlast && vlast->pts_ns == gaps[0]->pts_ns - 40 * MS);
    // Each marker 100 ms longer than its hole: trimmed to the horizon (B-21), the same gaps.
    Bytes data = fixture("syn-gap-marker");
    for (const Bus& b : bus)
        if (b.flags & 2048)
            for (size_t at = b.off; at < b.off + b.len; at += PKT) {
                uint64_t n = 0;
                for (int i = 0; i < 8; i++) n = (n << 8) | data[at + 7 + i];
                n += 100 * MS;
                for (int i = 0; i < 8; i++) data[at + 7 + i] = (uint8_t)(n >> (56 - 8 * i));
            }
    const Run r2 = replay_data(data, 1316, MEDIA_ALL, std::nullopt, &bus);
    std::vector<std::tuple<std::string, int64_t, int64_t>> g1, g2;
    for (const Ev* g : gaps) g1.emplace_back(g->pad, g->pts_ns, g->dur_ns);
    for (const Ev* g : of(r2.ev, K::gap)) g2.emplace_back(g->pad, g->pts_ns, g->dur_ns);
    CHECK("7 syn-gap-marker: markers 100 ms longer than the hole are trimmed to the horizon", g1 == g2);
    DemuxCore d;
    const Bytes& sg = fixture("syn-gap-marker");
    feed(d, Bytes(sg.begin(), sg.begin() + 200 * PKT), 1000 * SEC);
    const auto out = marker(d, gap_packet(0x1FF, 0, 300 * MS), 1003 * SEC);
    CHECK("7 syn-gap-marker: a marker on a PID without a pad is ignored", out.empty() &&
        d.counters().markers == 0);
}

// --- 8 video holes -----------------------------------------------------------------------------------

void test_video_hole() {
    const Run r = replay("syn-video-hole-1s");
    const auto vs = of(r.ev, K::unit, "video_0_0100");
    std::vector<int64_t> holes;
    for (size_t i = 1; i < vs.size(); i++)
        if (vs[i]->pts_ns - vs[i - 1]->pts_ns > 60 * MS) holes.push_back(vs[i]->pts_ns - vs[i - 1]->pts_ns);
    const auto gaps = of(r.ev, K::gap);
    CHECK("8 syn-video-hole-1s: 1, 2 and 5 missing frames (three times each) give no gap",
          holes.size() == 10 &&
              std::count_if(holes.begin(), holes.end(), [](int64_t x) { return x < 300 * MS; }) == 9);
    CHECK("8 syn-video-hole-1s: the 1.2 s hole gives one jump gap of it, none on audio",
          gaps.size() == 1 && gaps[0]->pad == "video_0_0100" && std::string(gaps[0]->reason) == "jump" &&
              std::llabs(gaps[0]->dur_ns - 1200 * MS) < 10 * MS);
    // B-frames (IBBP): the PTS in decode order step 3 frames up, 2 down; the DTS one frame each.
    const Run s = replay("syn-source-restart");
    const auto jump = of(s.ev, K::gap, "video_0_0100");
    std::vector<const Ev*> before;
    if (!jump.empty())
        for (size_t i = 0; i < index_of(s.ev, jump[0]); i++)
            if (s.ev[i].kind == K::unit && s.ev[i].pad == "video_0_0100") before.push_back(&s.ev[i]);
    long long reordered = 0;
    int64_t newest = -1;
    for (const Ev* u : before) {
        reordered += u->dts_ns != u->pts_ns;
        newest = std::max(newest, u->pts_ns);
    }
    CHECK(str("8 syn-source-restart (B-frames): the +3 h jump's gap starts one frame (40 ms) past the "
              "newest PTS: video spacing in DTS, not the reordered PTS (%lld of %lld)",
              reordered, (long long)before.size())
              .c_str(),
          jump.size() == 1 && reordered > 20 && jump[0]->pts_ns == newest + 40 * MS);
}

// --- 9 PMT changes -------------------------------------------------------------------------------------

void test_pmt_change() {
    const Run r = replay("syn-pmt-version-bump");
    std::vector<std::pair<std::string, int>> seq;
    for (const Ev& e : r.ev) {
        if (e.kind == K::section && std::string(e.reason) != "pat") seq.push_back({"section", e.version});
        if (e.kind == K::plan) seq.push_back({"plan", e.generation});
        if (e.kind == K::gone) seq.push_back({"gone", e.generation});
    }
    CHECK("9 pmt-version-bump: version 1 (the same streams) no plan; version 2 (0x100 to HEVC) plan(1), "
          "gone(0); version 3 (the PCR to 0x101) plan(2), gone(1)",
          seq == std::vector<std::pair<std::string, int>>{{"section", 0}, {"plan", 0}, {"section", 1},
                                                          {"section", 2}, {"plan", 1}, {"gone", 0},
                                                          {"section", 3}, {"plan", 2}, {"gone", 1}});
    const auto plans = of(r.ev, K::plan);
    std::vector<std::string> first_pads;
    std::vector<int> pcrs;
    for (const Ev* p : plans) {
        first_pads.push_back(p->pads.empty() ? "" : p->pads[0].name);
        pcrs.push_back(p->pcr_pid);
    }
    CHECK("9 pmt-version-bump: the new pads by generation, HEVC caps from version 2, the PCR PID",
          first_pads == std::vector<std::string>{"video_0_0100", "video_1_0100", "video_2_0100"} &&
              plans[1]->pads[0].es.caps == CAPS_H265 && pcrs == std::vector<int>{0x100, 0x100, 0x101});
    bool ok = true;
    for (size_t k = 1; k < plans.size(); k++) {
        const size_t i = index_of(r.ev, plans[k]);
        const std::string old_g = "_" + std::to_string(plans[k]->generation - 1) + "_",
                          new_g = "_" + std::to_string(plans[k]->generation) + "_";
        std::vector<const Ev*> later;
        for (size_t j = i; j < r.ev.size(); j++)
            if (r.ev[j].kind == K::unit) later.push_back(&r.ev[j]);
        ok &= !later.empty();
        for (const Ev* u : later) ok &= u->pad.find(old_g) == std::string::npos;
        ok &= !later.empty() && later[0]->pad.find(new_g) != std::string::npos && later[0]->discont;
    }
    CHECK("9 pmt-version-bump: the plan before the new program's first unit, no unit on the old pads "
          "after",
          ok);
    {
        Ts t;
        t.pat();
        t.pmt({{PID_V, 0x1B, {}}, {0x101, 0x0F, h("0a04656e6700")}}, PID_V, 0);
        t.pmt({{0x101, 0x0F, h("0a04667261007c0158")}, {PID_V, 0x1B, {}}}, PID_V, 1);
        DemuxCore d;
        const auto ev = run(d, t.b, 100 * SEC);
        CHECK("9 pmt change: the streams reordered and a language changed is the same program (pads kept)",
              of(ev, K::plan).size() == 1 && of(ev, K::section).size() == 3);
    }
    {
        Ts t;
        t.pat();
        t.pmt({{PID_V, 0x1B, {}}, {0x101, 0x0F, {}}, {0x102, 0x0F, {}}}, PID_V, 0);
        t.pmt({{PID_V, 0x1B, {}}, {0x101, 0x0F, {}}}, PID_V, 1);
        DemuxCore d;
        const auto ev = run(d, t.b, 100 * SEC);
        std::vector<std::pair<std::string, int>> pg;
        for (const Ev& e : ev)
            if (e.kind == K::plan ||
                e.kind == K::gone) pg.push_back({e.kind == K::plan ? "plan" : "gone", e.generation});
        const auto pl = of(ev, K::plan);
        CHECK("9 pmt change: a stream removed, the PCR PID and the rest kept, is a new program: plan(1), "
              "then gone(0) (tsdemux's stream count)",
              pg == std::vector<std::pair<std::string, int>>{{"plan", 0}, {"plan", 1}, {"gone", 0}} &&
                  pl.size() == 2 &&
                      pad_names(*pl[1]) == std::vector<std::string>{"video_1_0100", "audio_1_0101"});
    }
    {
        Ts t;
        t.pat();
        t.pmt({{PID_V, 0x1B, {}}}, PID_V, 0);
        t.pmt({}, PID_V, 1);
        t.pmt({{PID_V, 0x1B, {}}}, PID_V, 2);
        DemuxCore d;
        const auto ev = run(d, t.b, 100 * SEC);
        std::vector<K> kinds;
        for (const Ev& e : ev) kinds.push_back(e.kind);
        Ts e;
        e.pat();
        e.pmt({}, PID_V, 0);
        DemuxCore ed, sd(sel_cfg());
        auto out = run(ed, e.b, 50 * SEC);
        append(out, run(ed, e.b, 53 * SEC));
        auto sout = run(sd, e.b, 50 * SEC);
        append(sout, run(sd, e.b, 53 * SEC));
        CHECK("9 pmt change: a PMT without streams is skipped (tsdemux rejects one): no plan, the pads kept; "
              "no no-stream in demux mode, one in select mode",
              kinds == std::vector<K>{K::section, K::section, K::plan, K::section, K::section} &&
                  d.pads() == std::vector<std::string>{"video_0_0100"} && of(out, K::no_stream).empty() &&
                  ed.state() == DemuxCore::State::waiting && of(sout, K::no_stream).size() == 1);
    }
}

// --- 10 the formula ----------------------------------------------------------------------------------

void test_formula() {
    long long n = 0, inexact = 0;
    bool exact = true, trip = true, dts_trip = true;
    for (const std::string& name : fixture_names()) {
        const Run r = replay(name);
        for (const Ev* u : of(r.ev, K::unit)) {
            if (u->pts_ns < 0) continue;
            n++;
            exact &= ns_to_pts90k(u->pts_ns) == u->pts_u - BASE;
            trip &= fmod_(ns_to_pts90k(u->pts_ns) + BASE, WRAP) == u->hdr.pts;
            if (u->dts_u != Unwrapper::NO_DTS) {
                dts_trip &= fmod_(ns_to_pts90k(u->dts_ns) + BASE, WRAP) == u->hdr.dts;
                dts_trip &= ns_to_pts90k(u->dts_ns) == u->dts_u - BASE;
            }
            inexact += fmod_(u->pts_u - BASE, 9) != 0;
        }
    }
    CHECK(str("10 formula: ns_to_pts90k(PTS) == unwrapped PES - 1 h for every unit of every fixture (%lld)", n)
              .c_str(),
          n > 10000 && exact);
    CHECK(str("10 formula: through mpegtsmux's floor every PTS and DTS comes back as its PES's (%lld off the "
              "9-tick grid)",
              inexact)
              .c_str(),
          trip && dts_trip && inexact > 1000);
}

// --- 11 unknown streams, not house time ----------------------------------------------------------------

// `data` with every PES PTS and DTS and every PCR moved by `ticks`, mod 2^33.
Bytes shifted(const Bytes& data, int64_t ticks) {
    Bytes out = data;
    rebase_ts(out.data(), out.size(), ticks);
    return out;
}

void test_unknown_not_house() {
    {
        const Run r = replay("syn-private-novdesc");
        std::vector<std::tuple<int, int, std::string, int>> unk;
        for (const Ev* e : of(r.ev, K::unknown))
            unk.emplace_back(e->pid, e->stream_type, reg_text(e->reg), e->generation);
        const Bytes& data = fixture("syn-private-novdesc");
        long long pmts = 0;
        for (size_t at = 0; at + PKT <= data.size(); at += PKT) pmts += ts_pid(data.data() + at) == 0x1000;
        CHECK(str("11 syn-private-novdesc: one unknown for 0x06 bare (0x104) and DTS 0x82 (0x106), none for "
                  "0x86, across %lld PMT packets",
                  pmts)
                  .c_str(),
              unk == std::vector<std::tuple<int, int, std::string, int>>{{0x104, 0x06, "", 0},
                                                                         {0x106, 0x82, "", 0}} &&
                  pmts > 3 && r.k.unknown_streams == 2);
        const auto plans = of(r.ev, K::plan);
        CHECK("11 syn-private-novdesc: no pad for them, never reassembled",
              !plans.empty() && plans[0]->pads.size() == 1 && plans[0]->pads[0].pid == 0x102 &&
                  r.selected == std::vector<int>{0x102});
    }
    {
        const Run r = replay("tp-h264-dts");
        std::vector<std::pair<int, int>> u;
        for (const Ev* e : of(r.ev, K::unknown)) u.push_back({e->pid, e->stream_type});
        CHECK("11 tp-h264-dts: one unknown for its DTS PID", u == std::vector<std::pair<int, int>>{{0x101, 0x82}});
        const Run v = replay("tp-h264-dts", 1316, media_bit(EsClass::Video));
        CHECK("11 tp-h264-dts, media=video: no warning for an audio stream it would not expose",
              of(v.ev, K::unknown).empty() && !of(v.ev, K::plan).empty() &&
                  of(v.ev, K::plan)[0]->pads.size() == 1);
    }
    {
        Ts t;
        t.pat();
        t.pmt({{PID_V, 0x1B, {}}, {0x105, 0x8A, {}}}, PID_V, 0);
        t.pmt({{PID_V, 0x1B, {}}, {0x105, 0x8A, h("0a04656e6700")}}, PID_V, 1);
        t.pmt({{PID_V, 0x24, {}}, {0x105, 0x8A, {}}}, PID_V, 2);
        DemuxCore d;
        const auto ev = run(d, t.b, 100 * SEC);
        std::vector<std::pair<int, int>> u;
        for (const Ev* e : of(ev, K::unknown)) u.push_back({e->pid, e->generation});
        CHECK("11 unknown: once per PID per generation, not again at a version-only change",
              u == std::vector<std::pair<int, int>>{{0x105, 0}, {0x105, 1}});
    }
    auto nothouse = [](const std::vector<Ev>& ev) {
        std::vector<std::pair<int, int64_t>> n;
        for (const Ev* e : of(ev, K::not_house_time)) n.push_back({e->pid, e->offset_ms});
        return n;
    };
    const Bytes& bssd = fixture("cap-302m-bssd");
    const int64_t own = first_pes_house_ns(bssd.data(), bssd.size());
    {
        const Run r = replay_data(shifted(bssd, 2 * 3600 * 90000LL), 1316, MEDIA_ALL, own);
        const auto u = of(r.ev, K::unit);
        CHECK("11 cap-302m-bssd rebased 2 h later (every PES and PCR moved), at its own clock: one "
              "not-house-time, +7200000 ms, the units 2 h on",
              nothouse(r.ev) == std::vector<std::pair<int, int64_t>>{{0x41, 7200000}} && !u.empty() &&
                  u[0]->pts_ns == own + 2 * H);
    }
    {
        const Run r = replay("cap-302m-bssd", 1316, MEDIA_ALL, own + 2 * H);
        const auto u = of(r.ev, K::unit);
        CHECK("11 cap-302m-bssd 2 h behind the clock: one not-house-time, -7200000 ms, the units at their "
              "own time",
              nothouse(r.ev) == std::vector<std::pair<int, int64_t>>{{0x41, -7200000}} && !u.empty() &&
                  u[0]->pts_ns == own);
    }
    {
        const Bytes& a7 = fixture("cap-mux-align7-aac-opus");
        const int64_t own7 = first_pes_house_ns(a7.data(), a7.size());
        const Run r = replay("cap-mux-align7-aac-opus", 1316, MEDIA_ALL, own7 - 2 * H);
        std::map<int, int64_t> first;
        for (const Ev* u : of(r.ev, K::unit)) first.emplace(u->pid, u->pts_ns);
        std::vector<std::pair<int, int64_t>> want, got = nothouse(r.ev);
        for (const auto& kv : first) want.push_back({kv.first, (kv.second - own7 + 2 * H) / MS});
        std::sort(got.begin(), got.end());
        CHECK("11 cap-mux-align7 2 h ahead of the clock: once per PID (two pads, two), each its own offset",
              got == want && first.size() == 2);
    }
    {
        const Run r = replay("cap-302m-bssd", 1316, MEDIA_ALL, own - 59 * SEC);
        const Run r2 = replay("cap-302m-bssd", 1316, MEDIA_ALL, (int64_t)-1);
        const auto u = of(r2.ev, K::unit);
        CHECK("11 not-house-time: none at 59 s, none without a clock",
              nothouse(r.ev).empty() && nothouse(r2.ev).empty() && !u.empty() && u[0]->pts_ns == own);
    }
}

// --- 12 the select configuration (Phase 2's ts_select_test.cpp) ----------------------------------------

bool found_on(const Bytes& loop, int stype = 0x06) {
    Ts t;
    t.pat();
    t.pmt({{PID_A, stype, loop}}, PID_A);
    DemuxCore d(sel_cfg());
    run(d, t.b, 100 * SEC);
    return d.pid() == PID_A;
}

void select_formula() {
    const int64_t t0 = 9000000;               // 100 s in ticks, a multiple of 9
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 50; k++) t.frame(t0 + k * TICKS_20MS);
    DemuxCore d(sel_cfg());
    const auto out = run(d, t.b, 100 * SEC - 40 * MS);
    const auto us = of(out, K::unit);
    bool exact = us.size() == 50, rest = true, disc = true;
    for (size_t k = 0; exact && k < us.size(); k++) {
        exact &= us[k]->pts_ns == ceil_ns(t0 + (int64_t)k * TICKS_20MS);
        rest &= us[k]->dts_ns == us[k]->pts_ns && us[k]->dur_ns == 20 * MS && us[k]->bytes == s302m(960);
        disc &= us[k]->discont == (k == 0) && us[k]->pad == "src";
    }
    CHECK("12 select: formula: one unit per PES, PTS = ceil(PES - 1 h) exactly", exact);
    CHECK("12 select: formula: DTS = PTS (302M has none); duration from the AES3 header; the payload",
          exact && rest);
    CHECK("12 select: formula: DISCONT on the pad's first unit only, the pad named src", exact && disc);
    CHECK("12 select: formula: units alone (no plan, section or found event)", out.size() == 50);
    const DemuxCore::Counters c = d.counters();
    CHECK("12 select: formula: state found, PID, program, frame 20 ms; counters",
          d.state() == DemuxCore::State::found && d.pid() == PID_A && d.program() == 1 &&
              d.frame_ns() == 20 * MS &&
              c.pes == 50 && c.gaps == 0 && c.cc_lost == 0 && c.pes_dropped_cc == 0 && c.desync_bytes == 0);
    bool same = true;
    for (size_t chunk : {(size_t)188, (size_t)1316, (size_t)7, (size_t)1000, (size_t)24576}) {
        DemuxCore e(sel_cfg());
        same &= lines(run(e, t.b, 100 * SEC - 40 * MS, chunk)) == lines(out);
    }
    CHECK("12 select: chunking: 188, 1316, 7, 1000 and 24576-byte feeds give the same units", same);
}

void select_seed() {
    const int64_t house = 30 * H;
    const int64_t t0 = ns_to_pts90k(house);
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 3; k++) t.frame(t0 + k * TICKS_20MS);
    DemuxCore d(sel_cfg());
    const auto ev = run(d, t.b, house + 5 * MS);
    const auto us = of(ev, K::unit);
    CHECK("12 select: B-14: at 30 h the PES are 33-bit folded and come out at 30 h, not 26.5 h behind",
          us.size() == 3 && t0 + BASE > WRAP && us[0]->pts_ns == ceil_ns(t0) &&
              us[2]->pts_ns == ceil_ns(t0 + 3600));
    DemuxCore e(sel_cfg()), f(sel_cfg());
    const auto lev = run(e, t.b, house + 12 * H), eev = run(f, t.b, house - 12 * H);
    const auto late = of(lev, K::unit), early = of(eev, K::unit);
    CHECK("12 select: seed: content 12 h before or after the clock still unwraps to it",
          late.size() == 3 && early.size() == 3 && late[0]->pts_ns == early[0]->pts_ns &&
              late[0]->pts_ns == ceil_ns(t0));
    Ts u;
    u.psi_302m();
    u.frame(450000);
    DemuxCore g(sel_cfg());
    const auto nev = run(g, u.b, -1);
    const auto none = of(nev, K::unit);
    CHECK("12 select: no clock: the PES seeds itself, 1 h + 5 s gives 5 s", none.size() == 1 &&
        none[0]->pts_ns == 5 * SEC);
}

void select_wrap() {
    const int64_t wrap_t = WRAP - BASE;       // the house tick where the PES field wraps
    const int64_t t0 = wrap_t - 50 * TICKS_20MS;
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 100; k++) t.frame(t0 + k * TICKS_20MS);
    DemuxCore d(sel_cfg());
    const auto ev = run(d, t.b, pts90k_to_ns(t0) + 10 * MS, 1316);
    const auto us = of(ev, K::unit);
    bool even = us.size() == 100;
    for (size_t k = 1; even && k < us.size(); k++) even &= us[k]->pts_ns - us[k - 1]->pts_ns == 20 * MS;
    const bool crossed = us.size() == 100 && us[49]->pts_ns < ceil_ns(wrap_t) &&
        us[50]->pts_ns == ceil_ns(wrap_t) &&
                         us[99]->pts_ns == ceil_ns(t0 + 99 * TICKS_20MS);
    CHECK("12 select: wrap: 100 PES across 2^33, every step 20 ms, the PTS continuous through it", even &&
        crossed);
    CHECK("12 select: wrap: no gap", d.counters().gaps == 0);
}

void select_jump() {
    const int64_t t0 = 9000000;
    {
        Ts t;
        t.psi_302m();
        for (int k = 0; k < 10; k++) t.frame(t0 + k * TICKS_20MS);
        const int64_t hole_at = t0 + 10 * TICKS_20MS;    // where the 11th frame would be
        t.frame(hole_at + 45000);                         // 500 ms of nothing, CC unbroken
        t.frame(hole_at + 45000 + TICKS_20MS);
        DemuxCore d(sel_cfg());
        const auto out = run(d, t.b, 100 * SEC);
        const auto gaps = of(out, K::gap), us = of(out, K::unit);
        CHECK("12 select: jump: a 500 ms hole gives one GAP of exactly 500 ms from the last frame's end",
              gaps.size() == 1 && gaps[0]->pts_ns == ceil_ns(hole_at) && gaps[0]->dur_ns == 500 * MS &&
                  std::string(gaps[0]->reason) == "jump");
        const size_t i = gaps.empty() ? out.size() : index_of(out, gaps[0]);
        CHECK("12 select: jump: the GAP comes right before the unit after the hole, which is DISCONT",
              i + 1 < out.size() && out[i + 1].kind == K::unit && out[i + 1].discont &&
                  out[i + 1].pts_ns == ceil_ns(hole_at + 45000));
        CHECK("12 select: jump: 12 units, gaps 1, the next unit not DISCONT",
              us.size() == 12 && !us[11]->discont && d.counters().gaps == 1);
    }
    for (const int64_t extra : {(int64_t)0, (int64_t)1}) {
        Ts u;
        u.psi_302m();
        for (int k = 0; k < 5; k++) u.frame(t0 + k * TICKS_20MS);
        u.frame(t0 + 5 * TICKS_20MS + 2 * TICKS_20MS + extra);
        DemuxCore e(sel_cfg());
        const auto ev = run(e, u.b, 100 * SEC);
        const auto g = of(ev, K::gap);
        if (extra == 0)
            CHECK("12 select: jump: a hole of exactly two frames is no gap", g.empty());
        else
            CHECK("12 select: jump: two frames and a tick is a gap", g.size() == 1);
    }
    {
        Ts v;
        v.psi_302m();
        v.frame(t0);
        v.frame(t0 + TICKS_20MS + 45000);
        DemuxCore f(sel_cfg());
        const auto ev = run(f, v.b, 100 * SEC);
        CHECK("12 select: jump: no test before two spacings are known", of(ev, K::gap).empty() &&
            f.frame_ns() == -1);
    }
    {
        Ts w;
        w.psi_302m();
        int64_t at = t0;
        for (int k = 0; k < 6; k++, at += 960) w.frame(at, 512);     // 512 frames = 960 ticks
        for (int k = 0; k < 6; k++, at += 3840) w.frame(at, 2048);   // 2048 frames = 3840 ticks
        DemuxCore g(sel_cfg());
        const auto wo = run(g, w.b, 100 * SEC);
        CHECK("12 select: jump: a cadence rise 512 -> 2048 frames gives no gap",
              of(wo, K::gap).empty() && of(wo, K::unit).size() == 12);
    }
    {
        Ts j;
        j.psi_302m();
        int64_t at = t0;
        const Bytes junk(300, 0x5A);
        for (int k = 0; k < 9; k++, at += TICKS_20MS) j.pes(PID_A, (at + BASE) % WRAP, junk);
        for (int k = 0; k < 12; k++, at += 4 * TICKS_20MS) j.pes(PID_A, (at + BASE) % WRAP, junk);
        DemuxCore jd(sel_cfg());
        const auto jo = run(jd, j.b, 100 * SEC);
        CHECK("12 select: jump: no duration, a lasting 20 -> 80 ms rise: 4 gaps, then the rise is learned",
              of(jo, K::gap).size() == 4 && jd.frame_ns() == 80 * MS && of(jo, K::unit).size() == 21);
    }
    {
        Ts m2;
        m2.psi_302m();
        m2.frame(t0);
        m2.frame(t0 + TICKS_20MS);
        m2.frame(t0 + TICKS_20MS + 2700);
        DemuxCore md(sel_cfg());
        run(md, m2.b, 100 * SEC);
        CHECK("12 select: frame: the upper median of the spacings (20 and 30 ms: 30)", md.frame_ns() == 30 * MS);
    }
    {
        Ts x;
        x.psi_302m();
        for (int k = 0; k < 5; k++) x.frame(t0 + k * TICKS_20MS);
        x.frame(t0);
        DemuxCore hd(sel_cfg());
        const auto xo = run(hd, x.b, 100 * SEC);
        const auto us = of(xo, K::unit);
        CHECK("12 select: jump: a backward step is no gap and is emitted at its own PTS",
              of(xo, K::gap).empty() && us.size() == 6 && us[5]->pts_ns == ceil_ns(t0));
    }
}

void select_cc_loss() {
    const int64_t t0 = 9000000;
    {
        Ts t;
        t.psi_302m();
        for (int k = 0; k < 4; k++) t.frame(t0 + k * TICKS_20MS);
        const size_t cut = t.b.size() + 3 * PKT;          // a packet inside the 5th PES
        for (int k = 4; k < 8; k++) t.frame(t0 + k * TICKS_20MS);
        Bytes lost(t.b.begin(), t.b.begin() + (std::ptrdiff_t)cut);
        lost.insert(lost.end(), t.b.begin() + (std::ptrdiff_t)(cut + PKT), t.b.end());
        DemuxCore d(sel_cfg());
        const auto ev = run(d, lost, 100 * SEC);
        const auto us = of(ev, K::unit);
        CHECK("12 select: cc loss: the PES it cut is dropped, the next unit DISCONT",
              us.size() == 7 && us[4]->pts_ns == ceil_ns(t0 + 5 * TICKS_20MS) && us[4]->discont &&
                  !us[3]->discont &&
                  !us[5]->discont);
        const DemuxCore::Counters c = d.counters();
        CHECK("12 select: cc loss: cc-lost 1, pes-dropped-cc 1, and no gap for one missing frame",
              c.cc_lost == 1 && c.pes_dropped_cc == 1 && c.gaps == 0);
    }
    {
        Ts u;
        u.psi_302m();
        for (int k = 0; k < 4; k++) u.frame(t0 + k * TICKS_20MS);
        const size_t a = u.b.size();
        for (int k = 4; k < 7; k++) u.frame(t0 + k * TICKS_20MS);
        const size_t b = u.b.size();
        for (int k = 7; k < 10; k++) u.frame(t0 + k * TICKS_20MS);
        Bytes gone(u.b.begin(), u.b.begin() + (std::ptrdiff_t)a);
        gone.insert(gone.end(), u.b.begin() + (std::ptrdiff_t)b, u.b.end());
        DemuxCore e(sel_cfg());
        const auto o2 = run(e, gone, 100 * SEC);
        const auto g2 = of(o2, K::gap);
        const auto u2 = of(o2, K::unit);
        CHECK("12 select: cc loss: three frames lost give a GAP of 60 ms and a DISCONT unit",
              g2.size() == 1 && g2[0]->dur_ns == 60 * MS && e.counters().cc_lost == 1 && u2.size() > 4 &&
                  u2[4]->discont);
    }
    {
        // A spacing across a loss is no frame: three 40 ms ones leave the frame at 20 ms.
        Ts w;
        w.psi_302m();
        int64_t at = t0;
        for (int k = 0; k < 3; k++, at += TICKS_20MS) w.frame(at);
        Bytes lossy = w.b;
        for (int k = 0; k < 3; k++) {
            w.b.clear();
            w.frame(at);                          // lost whole: the CC jump shows at the next
            at += TICKS_20MS;
            w.b.clear();
            w.frame(at);
            lossy.insert(lossy.end(), w.b.begin(), w.b.end());
            at += TICKS_20MS;
        }
        w.b.clear();
        w.frame(at + 4500);
        lossy.insert(lossy.end(), w.b.begin(), w.b.end());
        DemuxCore f(sel_cfg());
        const auto ev = run(f, lossy, 100 * SEC);
        const auto g3 = of(ev, K::gap);
        CHECK("12 select: spacing: none across a CC loss is learned; a 50 ms hole after three is a gap",
              f.counters().cc_lost == 3 && f.frame_ns() == 20 * MS && g3.size() == 1 &&
                  g3[0]->dur_ns == 50 * MS);
    }
}

void select_spacing_across_markers() {
    const int64_t t0 = 9000000;
    Ts x;
    x.psi_302m();
    int64_t at = t0;
    for (int k = 0; k < 3; k++, at += TICKS_20MS) x.frame(at);
    DemuxCore d(sel_cfg());
    std::vector<Ev> out = run(d, x.b, 100 * SEC);
    for (int k = 0; k < 3; k++) {
        append(out, marker(d, gap_packet(PID_A, x.last_cc(PID_A), 20 * MS), pts90k_to_ns(at) + 20 * MS));
        at += TICKS_20MS;
        x.b.clear();
        x.frame(at);
        append(out, run(d, x.b, 100 * SEC));
        at += TICKS_20MS;
    }
    x.b.clear();
    x.frame(at + 4500);
    const auto gev = run(d, x.b, 100 * SEC);
    const auto g = of(gev, K::gap);
    CHECK("12 select: spacing: none across a marker is learned; a 50 ms hole after three is a gap",
          of(out, K::gap).size() == 3 && d.frame_ns() == 20 * MS && g.size() == 1 &&
              g[0]->dur_ns == 50 * MS &&
              std::string(g[0]->reason) == "jump");
}

void select_markers() {
    const int64_t t0 = 9000000;
    const int64_t t_end = ceil_ns(t0 + 5 * TICKS_20MS);   // the 5th frame's end
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 5; k++) t.frame(t0 + k * TICKS_20MS);
    const uint8_t cc = t.last_cc(PID_A);
    {
        DemuxCore d(sel_cfg());
        run(d, t.b, 100 * SEC);
        auto out = marker(d, gap_packet(PID_A, cc, 300 * MS), t_end + 400 * MS);
        CHECK("12 select: marker: [end - length, end) when it starts past the last PES",
              out.size() == 1 && out[0].kind == K::gap && out[0].pts_ns == t_end + 100 * MS &&
                  out[0].dur_ns == 300 * MS && std::string(out[0].reason) == "marker");
        Ts n;
        n.cc = t.cc;
        n.frame(ns_to_pts90k(t_end + 400 * MS));
        out = run(d, n.b, 100 * SEC);
        CHECK("12 select: marker: the unit after it is DISCONT, no jump GAP for the same hole",
              out.size() == 1 && out[0].kind == K::unit && out[0].discont);
        const DemuxCore::Counters c = d.counters();
        CHECK("12 select: marker: counted (markers 1, dropped 0, gaps 1)",
              c.markers == 1 && c.markers_dropped == 0 && c.gaps == 1);
    }
    {
        DemuxCore d(sel_cfg());
        run(d, t.b, 100 * SEC);
        const auto out = marker(d, gap_packet(PID_A, cc, 50 * MS), t_end + 30 * MS);
        CHECK("12 select: marker: one overlapping the last PES starts at its end",
              out.size() == 1 && out[0].pts_ns == t_end && out[0].dur_ns == 30 * MS);
    }
    {
        DemuxCore d(sel_cfg());
        run(d, t.b, 100 * SEC);
        const Bytes m = gap_packet(PID_A, cc, 15 * MS);
        auto out = marker(d, m, t_end - 2 * MS);
        append(out, marker(d, m, t_end));
        const DemuxCore::Counters c = d.counters();
        CHECK("12 select: marker: ones ending inside or at the last PES's end are dropped",
              out.empty() && c.markers == 2 && c.markers_dropped == 2 && c.gaps == 0);
    }
    {
        Ts v;
        v.pat();
        v.pmt({{PID_V, 0x1B, {}}, {PID_A, 0x06, BSSD}}, PID_V);
        for (int k = 0; k < 5; k++) v.frame(t0 + k * TICKS_20MS);
        DemuxCore d(sel_cfg());
        run(d, v.b, 100 * SEC);
        const Bytes buf = cat(gap_packet(PID_V, 3, 500 * MS), gap_packet(0x1FF, 3, 500 * MS));
        auto out = marker(d, buf, t_end + 600 * MS);
        CHECK("12 select: marker: ones for other PIDs, the PCR PID's included, are ignored",
              out.empty() && d.counters().markers == 0);
        const Bytes mine = gap_packet(PID_A, 0, 100 * MS);
        out = marker(d, mine, -1);
        CHECK("12 select: marker: one with no placeable PTS is counted and dropped",
              out.empty() && d.counters().markers == 1 && d.counters().markers_dropped == 1);
        out = marker(d, cat(buf, mine), t_end + 600 * MS);
        CHECK("12 select: marker: in a buffer of several PIDs only the selected one's packet counts",
              out.size() == 1 && out[0].pts_ns == t_end + 500 * MS && out[0].dur_ns == 100 * MS &&
                  d.counters().markers == 2);
    }
    {
        DemuxCore d(sel_cfg());
        run(d, t.b, 100 * SEC);
        std::vector<Ev> out;
        for (int i = 0; i < 4; i++) {
            const int64_t end = t_end + 1000 * MS + i * 250 * MS;
            append(out, marker(d, gap_packet(PID_A, cc, end - t_end), end));
        }
        bool tiled = out.size() == 4 && out[0].pts_ns == t_end && out[0].dur_ns == 1000 * MS;
        for (size_t i = 1; tiled && i < out.size(); i++)
            tiled &= out[i].pts_ns == out[i - 1].pts_ns + out[i - 1].dur_ns && out[i].dur_ns == 250 * MS;
        CHECK("12 select: marker: an outage's repeated markers tile the timeline, never overlapping", tiled);
    }
    {
        Ts p;
        p.psi_302m();
        DemuxCore d(sel_cfg());
        run(d, p.b, 100 * SEC);
        const Bytes m = gap_packet(PID_A, 0, 250 * MS);
        const auto out = marker(d, m, 100 * SEC);
        CHECK("12 select: marker: before the stream's first PES, the gap as given",
              out.size() == 1 && out[0].pts_ns == 100 * SEC - 250 * MS && out[0].dur_ns == 250 * MS);
        DemuxCore e(sel_cfg());
        CHECK("12 select: marker: with no stream selected, ignored",
              marker(e, m, 100 * SEC).empty() && e.counters().markers == 0);
    }
}

void select_no_stream() {
    Ts t;
    t.pat();
    t.pmt({{PID_V, 0x1B, {}}, {PID_B, 0x0F, {}}}, PID_V);
    const Bytes pmt = t.b;
    DemuxCore d(sel_cfg());
    std::vector<Ev> out = feed(d, pmt, 50 * SEC);
    CHECK("12 select: no stream: a PMT without 302M is `missing`, no warning yet",
          d.state() == DemuxCore::State::missing && out.empty() && d.pid() == -1);
    for (int64_t now = 50 * SEC + 100 * MS; now < 52 * SEC; now += 100 * MS) append(out, feed(d, pmt, now));
    CHECK("12 select: no stream: none within 2 s of the first PMT", out.empty());
    out = feed(d, pmt, 52 * SEC);
    CHECK("12 select: no stream: one `nostream` at 2 s", out.size() == 1 && out[0].kind == K::no_stream);
    out.clear();
    for (int64_t now = 52 * SEC; now < 60 * SEC; now += 500 * MS) append(out, feed(d, pmt, now));
    CHECK("12 select: no stream: only one per episode", out.empty());
    Ts u;
    u.cc = t.cc;
    u.pmt({{PID_V, 0x1B, {}}, {PID_A, 0x06, BSSD}}, PID_V, 1);
    out = feed(d, u.b, 60 * SEC);
    CHECK("12 select: no stream: a later PMT with the stream finds it",
          out.empty() && d.state() == DemuxCore::State::found && d.pid() == PID_A);
    Ts w;
    w.cc = u.cc;
    w.pmt({{PID_V, 0x1B, {}}}, PID_V, 2);
    out = feed(d, w.b, 61 * SEC);
    append(out, feed(d, w.b, 62 * SEC));
    CHECK("12 select: no stream: the stream gone again is missing, no warning before 2 s",
          out.empty() && d.state() == DemuxCore::State::missing && d.pid() == -1);
    out = feed(d, w.b, 63 * SEC);
    CHECK("12 select: no stream: the new episode warns once at 2 s", out.size() == 1 &&
        out[0].kind == K::no_stream);
    DemuxCore e(sel_cfg());
    Ts p;
    p.pat();
    out.clear();
    for (int64_t s = 0; s < 10; s++) append(out, feed(e, p.b, s * SEC));
    CHECK("12 select: no stream: no PMT is `waiting`, with no warning",
          out.empty() && e.state() == DemuxCore::State::waiting);
}

void select_programs_and_pid_change() {
    const int64_t t0 = 9000000;
    {
        Ts t;
        t.pat({{1, 0x100}, {2, 0x200}});
        t.pmt({{PID_B, 0x0F, {}}}, PID_B, 0, 0x100, 1);
        t.pmt({{PID_A, 0x06, BSSD}}, PID_A, 0, 0x200, 2);
        for (int k = 0; k < 3; k++) t.frame(t0 + k * TICKS_20MS);
        DemuxCore first(sel_cfg()), second(sel_cfg(2));
        run(first, t.b, 100 * SEC);
        const auto ev = run(second, t.b, 100 * SEC);
        const auto us = of(ev, K::unit);
        CHECK("12 select: program-number -1 follows the PAT's first program (no 302M there)",
              first.state() == DemuxCore::State::missing && first.program() == 1);
        CHECK("12 select: program-number 2 follows the second, whose 302M comes out",
              second.state() == DemuxCore::State::found && second.program() == 2 && second.pid() == PID_A &&
                  us.size() == 3);
    }
    {
        Ts u;
        u.psi_302m(PID_A, 0);
        for (int k = 0; k < 3; k++) u.frame(t0 + k * TICKS_20MS, 960, PID_A);
        u.pmt({{PID_B, 0x06, BSSD}}, PID_B, 1);
        for (int k = 3; k < 6; k++) u.frame(t0 + k * TICKS_20MS, 960, PID_B);
        DemuxCore d(sel_cfg());
        const auto ev = run(d, u.b, 100 * SEC);
        const auto us = of(ev, K::unit);
        CHECK("12 select: pid change: on 0x41, then on 0x42; six units, the 4th DISCONT",
              us.size() == 6 && us[3]->discont && us[3]->pid == PID_B && !us[4]->discont && d.pid() == PID_B);
    }
    {
        const int64_t t20 = t0 + 20LL * 3600 * 90000;     // the new stream's content 20 h after the old's
        Ts v;
        v.psi_302m(PID_A, 0);
        v.frame(t0, 960, PID_A);
        DemuxCore e(sel_cfg());
        run(e, v.b, 100 * SEC);
        v.b.clear();
        v.pmt({{PID_B, 0x06, BSSD}}, PID_B, 1);
        v.frame(t20, 960, PID_B);
        const auto fev = run(e, v.b, pts90k_to_ns(t20));
        const auto far = of(fev, K::unit);
        CHECK("12 select: pid change: the new PID seeds on the clock, not on the old stream's last PTS",
              far.size() == 1 && far[0]->pts_ns == ceil_ns(t20));
    }
}

void select_discont_drain_flush() {
    const int64_t t0 = 9000000;
    Ts t;
    t.psi_302m();
    size_t third = 0;
    for (int k = 0; k < 4; k++) {
        if (k == 2) third = t.b.size() + 5 * PKT;
        t.frame(t0 + k * TICKS_20MS);
    }
    {
        DemuxCore d(sel_cfg());
        auto out = feed(d, Bytes(t.b.begin(), t.b.begin() + (std::ptrdiff_t)third), 100 * SEC);
        append(out, feed(d, Bytes(t.b.begin() + (std::ptrdiff_t)third, t.b.end()), 100 * SEC, true));
        const auto us = of(out, K::unit);
        CHECK("12 select: bus discont: the open PES is dropped and the next unit is DISCONT",
              us.size() == 3 && us[2]->pts_ns == ceil_ns(t0 + 3 * TICKS_20MS) && us[2]->discont);
    }
    {
        Ts u;
        u.psi_302m();
        u.pes(PID_A, (t0 + BASE) % WRAP, s302m(960), false);
        DemuxCore e(sel_cfg());
        const auto ev = run(e, u.b, 100 * SEC);
        const bool held = of(ev, K::unit).empty();
        const auto out = drain(e);
        CHECK("12 select: drain: an unbounded PES is held, then out at EOS",
              held && out.size() == 1 && out[0].kind == K::unit && out[0].pts_ns == ceil_ns(t0) &&
                  out[0].bytes == s302m(960));
    }
    {
        DemuxCore f(sel_cfg());
        run(f, t.b, 100 * SEC);
        f.flush();
        Ts again;                                 // as after a seek: the CC starts afresh
        again.frame(t0);
        const auto o2 = run(f, again.b, 100 * SEC);
        CHECK("12 select: flush: the next unit is DISCONT at its own PTS; a fresh CC is no loss",
              o2.size() == 1 && o2[0].discont && o2[0].pts_ns == ceil_ns(t0) && f.counters().cc_lost == 0);
        f.flush();
        const auto o3 = marker(f, gap_packet(PID_A, 0, 40 * MS), ceil_ns(t0) + 20 * MS);
        CHECK("12 select: flush: a marker after it is not trimmed by the old horizon",
              o3.size() == 1 && o3[0].pts_ns == ceil_ns(t0) - 20 * MS && o3[0].dur_ns == 40 * MS);
    }
}

void select_no_pts() {
    Ts t;
    t.psi_302m();
    t.frame(9000000);
    t.frame(9000000 + TICKS_20MS);
    t.pes(PID_A, -1, s302m(960));
    t.frame(9000000 + 3 * TICKS_20MS);
    DemuxCore d(sel_cfg());
    const auto ev = run(d, t.b, 100 * SEC);
    const auto us = of(ev, K::unit);
    CHECK("12 select: no PTS: out untimed, counted as pes-no-pts",
          us.size() == 4 && us[2]->pts_ns < 0 && us[2]->dts_ns < 0 && d.counters().pes_no_pts == 1 &&
              us[3]->pts_ns == ceil_ns(9000000 + 3 * TICKS_20MS));
    CHECK("12 select: no PTS: the spacing across it is not learned (one spacing: no frame yet)",
          d.frame_ns() == -1);
}

void test_select() {
    DemuxCore s(sel_cfg());
    CHECK("12 select: audio/x-smpte-302m is the one stream select names; another refused",
          s.config().select == CAPS_302M && s.select_mode() && DemuxCore::selectable(CAPS_302M) &&
              !DemuxCore::selectable("audio/mpeg"));
    const Bytes a = s302m(1024), b = s302m(480, 8, 24), c = s302m(2000, 6, 20);
    CHECK("12 select: s302m_frames: 1024 frames stereo 16-bit (5124 bytes, mpegtsmux's shape)",
          a.size() == 5124 && s302m_frames(a.data(), a.size()) == 1024);
    CHECK("12 select: s302m_frames: 480 frames of 8 channels at 24 bits; 2000 of 6 at 20",
          s302m_frames(b.data(), b.size()) == 480 && s302m_frames(c.data(), c.size()) == 2000);
    Bytes reserved = a, longer = a;
    reserved[3] |= 0x30;
    longer.push_back(0);
    CHECK("12 select: s302m_frames: -1 when the size disagrees, on the reserved width, at 4 bytes or "
          "less",
          s302m_frames(longer.data(), longer.size()) == -1 &&
              s302m_frames(reserved.data(), reserved.size()) == -1 &&
              s302m_frames(a.data(), 4) == -1 && s302m_frames(a.data(), 0) == -1);
    const Bytes opus = h("05044f707573");
    CHECK("12 select: the stream is 0x06 whose first registration is BSSD",
          found_on(BSSD) && found_on(cat(h("0a04656e6700"), BSSD)));
    CHECK("12 select: not 0x06 without BSSD, nor with another first registration, nor another stream "
          "type with BSSD",
          !found_on({}) && !found_on(opus) && !found_on(cat(opus, BSSD)) && !found_on(BSSD, 0x0F));
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 6; k++) t.frame(1000 + k * TICKS_20MS);
    Bytes data(t.b.begin(), t.b.begin() + 400);
    data.insert(data.end(), {0x00, 0x47, 0x12});
    data.insert(data.end(), t.b.begin() + 400, t.b.end());
    DemuxCore d1(sel_cfg()), d2(sel_cfg());
    const auto o1 = run(d1, data, 100 * SEC, 77), o2 = run(d2, data, 100 * SEC);
    CHECK("12 select: walk: 77-byte feeds and garbage give one feed's units, 3 bytes resynced",
          lines(o1) == lines(o2) && o1.size() == 6 && d1.counters().desync_bytes == 3);
    select_formula();
    select_seed();
    select_wrap();
    select_jump();
    select_cc_loss();
    select_spacing_across_markers();
    select_markers();
    select_no_stream();
    select_programs_and_pid_change();
    select_discont_drain_flush();
    select_no_pts();
}

// --- 13 media ------------------------------------------------------------------------------------------

void test_media() {
    {
        const Run r = replay("cap-occ-1080i-h264-aac-ttx", 1316, media_bit(EsClass::Video));
        const auto plans = of(r.ev, K::plan);
        CHECK("13 cap-occ-1080i-h264-aac-ttx, media=video: one pad, video_0_0065",
              plans.size() == 1 && pad_names(*plans[0]) == std::vector<std::string>{"video_0_0065"});
        std::set<std::string> pads;
        for (const Ev* u : of(r.ev, K::unit)) pads.insert(u->pad);
        CHECK("13 media=video: units on it alone, the audio and teletext PIDs never reassembled",
              pads == std::set<std::string>{"video_0_0065"} && r.selected == std::vector<int>{0x65} &&
                  of(r.ev, K::unknown).empty());
    }
    {
        Ts t;
        t.pat();
        t.pmt({{PID_V, 0x1B, {}}}, PID_V, 0);
        const Bytes pmt = t.b;
        DemuxCore::Config cfg;
        cfg.media_mask = media_bit(EsClass::Audio);
        DemuxCore d(cfg);
        std::vector<std::pair<int64_t, K>> out;
        for (int64_t now = 50 * SEC; now < 53 * SEC; now += 250 * MS)
            for (const Ev& e : feed(d, pmt, now)) out.push_back({now, e.kind});
        Ts u;
        u.cc = t.cc;
        u.pmt({{PID_V, 0x1B, {}}, {0x101, 0x0F, {}}}, PID_V, 1);
        const auto later = feed(d, u.b, 53 * SEC);
        std::vector<K> lk;
        for (const Ev& e : later) lk.push_back(e.kind);
        CHECK("13 media=audio on a video-only program: a plan without a pad, no-stream once at 2 s, then "
              "found with the audio stream (E16)",
              out == std::vector<std::pair<int64_t, K>>{{50 * SEC, K::section}, {50 * SEC, K::section},
                                                        {50 * SEC, K::plan}, {52 * SEC, K::no_stream}} &&
                  lk == std::vector<K>{K::section, K::plan, K::gone} &&
                      d.state() == DemuxCore::State::found &&
                  d.pads() == std::vector<std::string>{"audio_1_0101"});
    }
    {
        const Run r = replay("cap-occ-1080i-h264-aac-ttx");
        bool behind = false;
        for (const Ev* u : of(r.ev, K::unit, "video_0_0065")) behind |= u->dts_ns < u->pts_ns;
        const auto plans = of(r.ev, K::plan);
        CHECK("13 cap-occ-1080i-h264-aac-ttx (S27: B-frames, teletext): DTS behind PTS on video, the "
              "teletext pad sparse with its units",
              behind && !plans.empty() && plans[0]->pads.size() > 9 &&
                  plans[0]->pads[9].name == "private_0_0020" &&
                  plans[0]->pads[9].es.sparse && of(r.ev, K::unit, "private_0_0020").size() == 14);
    }
    {
        const Run r = replay("cap-occ-1080i-h264-21aac-ttx");
        const auto plans = of(r.ev, K::plan);
        std::set<std::string> fed, all;
        for (const Ev* u : of(r.ev, K::unit)) fed.insert(u->pad);
        size_t aac = 0;
        if (!plans.empty())
            for (const DemuxPad& p : plans[0]->pads) {
                all.insert(p.name);
                aac += p.name.rfind("audio_0_", 0) == 0;
            }
        CHECK("13 cap-occ-1080i-h264-21aac-ttx (S27: many pads), media default: 23 pads (video, 21 AAC, "
              "teletext), units on every one",
              !plans.empty() && plans[0]->pads.size() == 23 && aac == 21 && fed == all);
    }
}

// --- 14 program time on a sparse PCR -------------------------------------------------------------------

// The recording with a teletext stream on `pid` in each PMT, no packet of it sent.
Bytes with_idle_teletext(const Bytes& data, int pid = 0x120) {
    Bytes out = data;
    for (size_t at = 0; at + PKT <= out.size(); at += PKT) {
        uint8_t* p = out.data() + at;
        if (ts_pid(p) != 0x1000 || !(p[1] & 0x40)) continue;
        std::deque<TsPacket> one(1);
        std::memcpy(one[0].b, p, PKT);
        std::optional<Pmt> pmt = parse_pmt(one, 0x1000);
        if (!pmt) continue;
        std::vector<PmtStream> streams = pmt->streams;
        streams.push_back({pid, 0x06, h("5605656e670988")});
        build_pmt(0x1000, pmt->program_number, pmt->pcr_pid, streams, p[3] & 0x0F, pmt->version, p);
    }
    return out;
}

void test_sparse_pcr() {
    const Bytes& data = fixture("cap-vmix-h264-aac");
    long long pcrs = 0, n = 0;
    for (size_t at = 0; at + PKT <= data.size(); at += PKT) pcrs += read_pcr(data.data() + at) >= 0;
    DemuxCore core;
    const int64_t now = first_pes_house_ns(data.data(), data.size());
    bool follows = true;
    for (size_t at = 0; at < data.size(); at += 1316) {
        std::vector<Ev> out;
        core.feed(data.data() + at, std::min<size_t>(1316, data.size() - at), false, now, out);
        for (const Ev& e : out)
            if (e.kind == K::unit && e.pts_ns >= 0) {
                n++;
                follows &= core.program_time_ns() >= e.pts_ns;
            }
    }
    CHECK(str("14 cap-vmix-h264-aac (%lld PCRs, 2 s apart): program time at or past every unit's PTS (%lld)",
              pcrs, n)
              .c_str(),
          pcrs == 2 && n > 150 && follows);
    {
        const Run r = replay_data(with_idle_teletext(data));
        const auto gaps = of(r.ev, K::gap, "private_0_0120");
        int64_t start = INT64_MAX;
        for (const Ev* u : of(r.ev, K::unit)) start = std::min(start, u->pts_ns);
        bool contiguous = true, sparse = true;
        for (size_t i = 1; i < gaps.size(); i++)
            contiguous &= gaps[i]->pts_ns == gaps[i - 1]->pts_ns + gaps[i - 1]->dur_ns;
        for (const Ev* g : gaps)
            sparse &= std::string(g->reason) == "sparse" && g->dur_ns > 500 * MS && g->dur_ns < 600 * MS;
        CHECK("14 cap-vmix + an idle teletext PID (2 s): two sparse gaps of half a second from its start, "
              "contiguous: they follow the newest PTS, not the PCR (a GAP of 1.5 s at the second)",
              gaps.size() == 2 && contiguous && gaps[0]->pts_ns == start && sparse);
    }
    {
        const Run r = replay("tp-h264-dvbsub");
        const std::string pad = "subpicture_0_0102";
        std::vector<const Ev*> later;
        for (size_t i = 0; i < r.ev.size(); i++) {
            if (r.ev[i].kind != K::gap || r.ev[i].pad != pad) continue;
            const Ev* u = nullptr;
            for (size_t j = i; j < r.ev.size() && !u; j++)
                if (r.ev[j].kind == K::unit && r.ev[j].pad == pad) u = &r.ev[j];
            if (u && std::find(later.begin(), later.end(), u) == later.end()) later.push_back(u);
        }
        bool none = true;
        for (const Ev* u : later) none &= !u->discont;
        CHECK("14 tp-h264-dvbsub: a sparse gap marks no loss: the pad's next unit not DISCONT, not "
              "counted",
              of(r.ev, K::gap, pad.c_str()).size() == 9 && later.size() == 2 && none && r.k.gaps == 0);
    }
}

// --- 15 AU post-processing -----------------------------------------------------------------------------

std::set<int> versions(const std::vector<Ev>& ev, const char* pad = nullptr) {
    std::set<int> v;
    for (const Ev* u : of(ev, K::unit, pad)) v.insert(adts_mpegversion(u->bytes.data(), u->bytes.size()));
    return v;
}

void test_au_post() {
    const Run ev = replay("syn-adts-mpeg2"), occ = replay("cap-occ-1080i-h264-aac-ttx"),
              vmix = replay("cap-vmix-h264-aac");
    CHECK("15 adts_mpegversion: syn-adts-mpeg2's AAC (the ID bit) is 2, as tsdemux refines it",
          versions(ev.ev) == std::set<int>{2});
    const Bytes zeros(40, 0), short_h = h("fff9");
    CHECK("15 adts_mpegversion: OCC's AAC is MPEG-2 too, the vMix's MPEG-4; no header or a short one 4",
          versions(occ.ev, "audio_0_00c9") == std::set<int>{2} &&
              versions(vmix.ev, "audio_0_0100") == std::set<int>{4} &&
              adts_mpegversion(zeros.data(), zeros.size()) == 4 &&
                  adts_mpegversion(short_h.data(), short_h.size()) == 4);
    {
        const Run r = replay("cap-mux-align7-aac-opus");
        const auto us = of(r.ev, K::unit, "audio_0_0108");
        bool ok = us.size() == 501;
        for (const Ev* u : us) {
            std::vector<OpusAu> aus;
            const bool parsed = opus_access_units(u->bytes.data(), u->bytes.size(), &aus);
            ok &= parsed && aus.size() == 1 && aus[0].len < u->bytes.size() &&
                aus[0].off + aus[0].len == u->bytes.size();
        }
        CHECK("15 opus_access_units: cap-mux-align7: mpegtsmux's control header stripped, one packet a PES", ok);
    }
    {
        const Run r = replay("tp-opus-51");
        bool ok = true;
        std::vector<std::tuple<int, int, int>> trims;
        int i = 0;
        for (const Ev* u : of(r.ev, K::unit, "audio_0_0101")) {
            std::vector<OpusAu> aus;
            const bool parsed = opus_access_units(u->bytes.data(), u->bytes.size(), &aus);
            ok &= parsed && aus.size() >= 1 && aus.size() <= 3;
            for (const OpusAu& a : aus)
                if (a.trim_start || a.trim_end) trims.emplace_back(i, a.trim_start, a.trim_end);
            i++;
        }
        CHECK("15 opus_access_units: tp-opus-51 (ffmpeg): one to three packets a PES, the pre-skip and "
              "the end trimmed",
              ok && trims == std::vector<std::tuple<int, int, int>>{{0, 312, 0}, {199, 0, 648}});
    }
    {
        const Bytes raw = h("fc0102"), cut1 = h("7fe0"), cut2 = h("7fe005fcff"), one = h("01");
        std::vector<OpusAu> a, b, c, d;
        const bool ra = opus_access_units(raw.data(), raw.size(), &a);
        CHECK("15 opus_access_units: a payload without a control header is one raw packet; a cut one fails",
              ra && a.size() == 1 && a[0].off == 0 && a[0].len == 3 && a[0].trim_start == 0 &&
                  a[0].trim_end == 0 &&
                  !opus_access_units(cut1.data(), cut1.size(), &b) &&
                      !opus_access_units(cut2.data(), cut2.size(), &c) &&
                  !opus_access_units(one.data(), one.size(), &d));
    }
    {
        const Bytes au = cat(cat(cat(h("0001800005"), text("KLV01")), h("0102000003")), text("ABC"));
        std::vector<KlvCell> cells;
        const bool ok = klv_metadata_cells(au.data(), au.size(), &cells);
        auto cell = [&](const KlvCell& k) {
            return Bytes(au.begin() + (std::ptrdiff_t)k.off, au.begin() + (std::ptrdiff_t)(k.off + k.len));
        };
        CHECK("15 klv_metadata_cells: a 0x15 AU of two cells split, service, sequence, flags kept",
              ok && cells.size() == 2 && cells[0].service_id == 0 && cells[0].sequence == 1 &&
                  cells[0].flags == 0x80 &&
                  cell(cells[0]) == text("KLV01") && cells[1].service_id == 1 && cells[1].sequence == 2 &&
                  cells[1].flags == 0 && cell(cells[1]) == text("ABC"));
        const Bytes longer = cat(h("0001000009"), text("ABC")), shortb = cat(au, h("0001"));
        std::vector<KlvCell> c2, c3;
        const bool ok2 = klv_metadata_cells(longer.data(), longer.size(), &c2);
        CHECK("15 klv_metadata_cells: a cell longer than the AU cut to it; a header short of 5 bytes fails",
              ok2 && c2.size() == 1 && c2[0].service_id == 0 && c2[0].sequence == 1 && c2[0].flags == 0 &&
                  c2[0].off == 5 && c2[0].len == 3 && !klv_metadata_cells(shortb.data(), shortb.size(), &c3));
    }
}

// --- 16 the expectations -------------------------------------------------------------------------------

// Each <name>.demux.jsonl (and .p<N>.demux.jsonl, program N) is the CLI's output at its defaults,
// through the fixture's sidecar where it has one; every fixture has one.
void test_expectations() {
    const std::vector<std::string> files = list_dir(".demux.jsonl");
    const std::vector<std::string> names = fixture_names();
    for (const std::string& f : files) {
        std::string stem = f.substr(0, f.size() - std::strlen(".demux.jsonl"));
        int program = -1;
        const size_t dot = stem.rfind(".p");
        if (dot != std::string::npos && dot + 2 < stem.size() &&
            stem.find_first_not_of("0123456789", dot + 2) == std::string::npos) {
            program = std::atoi(stem.c_str() + dot + 2);
            stem = stem.substr(0, dot);
        }
        const std::vector<std::string> want = read_lines(g_fixtures + "/" + f);
        std::vector<std::string> got;
        if (std::find(names.begin(), names.end(), stem) != names.end()) {
            std::vector<Bus> bus;
            const bool has_bus = exists(g_fixtures + "/" + stem + ".bus.jsonl");
            if (has_bus) bus = sidecar(stem);
            const Run r = replay(stem, 1316, MEDIA_ALL, std::nullopt, has_bus ? &bus : nullptr, program);
            got = lines(r.ev);
            got.push_back(demux_jsonl(r.k));
        }
        size_t diff = 0;
        while (diff < got.size() && diff < want.size() && got[diff] == want[diff]) diff++;
        const std::string where = got == want ? "" : str(", first difference at line %lld", (long long)diff + 1);
        CHECK(("16 " + f + str(": the reference's output (%lld lines)", (long long)want.size()) + where).c_str(),
              got == want);
    }
    bool every = true;
    for (const std::string& n : names)
        every &= std::find(files.begin(), files.end(), n + ".demux.jsonl") != files.end();
    CHECK("16 every fixture has its .demux.jsonl", every);
}

}  // namespace

int main(int, char** argv) {
    if (const char* e = std::getenv("MRTS_FIXTURES")) {
        g_fixtures = e;
    } else {
        const std::string a = argv[0];
        const size_t slash = a.rfind('/');
        g_fixtures = (slash == std::string::npos ? std::string(".") : a.substr(0, slash)) +
                     "/../../../tests/fixtures";
    }
    test_classify();
    test_pad_name();
    test_wrap();
    test_chunking();
    test_no_pts();
    test_gap_500ms();
    test_gap_marker();
    test_video_hole();
    test_pmt_change();
    test_formula();
    test_unknown_not_house();
    test_select();
    test_media();
    test_sparse_pcr();
    test_au_post();
    test_expectations();
    return test_summary("demux_core");
}
