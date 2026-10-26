#include "demux_core.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <map>
#include <set>

#include "ts_dump.h"
#include "ts_gap.h"
#include "ts_pcr.h"

namespace mrts {
namespace {

constexpr int64_t SEC = 1000000000;
constexpr int64_t S302M_RATE = 48000;          // SMPTE 302M is 48 kHz only

constexpr uint32_t fourcc(const char* s) {
    return ((uint32_t)(uint8_t)s[0] << 24) | ((uint32_t)(uint8_t)s[1] << 16) |
           ((uint32_t)(uint8_t)s[2] << 8) | (uint32_t)(uint8_t)s[3];
}
constexpr uint32_t REG_BSSD = fourcc("BSSD"), REG_AV1G = fourcc("AV1G"), REG_OPUS = fourcc("Opus"),
                   REG_HEVC = fourcc("HEVC"), REG_KLVA = fourcc("KLVA"), REG_ID3 = fourcc("ID3 "),
                   REG_AC4 = fourcc("AC-4"), REG_VP09 = fourcc("VP09"), REG_DTS1 = fourcc("DTS1"),
                   REG_DTS2 = fourcc("DTS2"), REG_DTS3 = fourcc("DTS3");

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

bool has(const std::vector<uint8_t>& loop, int tag, int ext = -1) {
    return find_descriptor(loop, tag, ext, nullptr);
}

// tsdemux's Opus channel-configuration table (tsdemux.c's Opus case).
const int OPUS_COUPLED[9] = {1, 0, 1, 1, 2, 2, 2, 3, 3};
const std::vector<int> OPUS_MAP_A[8] = {{0}, {0, 1}, {0, 2, 1}, {0, 1, 2, 3}, {0, 4, 1, 2, 3},
                                        {0, 4, 1, 2, 3, 5}, {0, 4, 1, 2, 3, 5, 6},
                                        {0, 6, 1, 2, 3, 4, 5, 7}};

// MSB-first reads of up to 8 bits (gst_bit_reader's uint8); false past the end.
class Bits {
  public:
    Bits(const uint8_t* d, size_t n) : d_(d), n_(n) {}
    bool read(int bits, int* v) {
        if (bits > 8 || pos_ + (size_t)bits > n_ * 8) return false;
        int x = 0;
        for (int i = 0; i < bits; i++, pos_++) x = (x << 1) | ((d_[pos_ >> 3] >> (7 - (pos_ & 7))) & 1);
        *v = x;
        return true;
    }

  private:
    const uint8_t* d_;
    size_t n_, pos_ = 0;
};

int bit_storage(int n) {                       // g_bit_storage
    int b = 0;
    for (; n > 0; n >>= 1) b++;
    return std::max(b, 1);
}

uint32_t be32(const uint8_t* p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

}  // namespace

const char* es_class_name(EsClass c) {
    switch (c) {
        case EsClass::Video: return "video";
        case EsClass::Audio: return "audio";
        case EsClass::Private: return "private";
        default: return "subpicture";
    }
}

bool es_class_from_name(const std::string& name, EsClass* out) {
    for (EsClass c : {EsClass::Video, EsClass::Audio, EsClass::Private, EsClass::Subpicture})
        if (name == es_class_name(c)) {
            *out = c;
            return true;
        }
    return false;
}

const char* au_post_name(AuPost p) {
    switch (p) {
        case AuPost::Adts: return "adts";
        case AuPost::Opus: return "opus";
        case AuPost::Klv: return "klv";
        default: return "none";
    }
}

bool find_descriptor(const std::vector<uint8_t>& loop, int tag, int ext, std::vector<uint8_t>* body) {
    bool found = false;
    for_each_descriptor(loop.data(), (int)loop.size(), [&](const Descriptor& d) {
        if (d.tag != tag || (ext >= 0 && (d.len < 1 || d.data[0] != ext))) return true;
        found = true;
        if (body) body->assign(d.data, d.data + d.len);
        return false;
    });
    return found;
}

std::string language(const std::vector<uint8_t>& loop) {
    std::vector<uint8_t> body;
    size_t size = 4;
    if (!find_descriptor(loop, 0x0A, -1, &body)) {
        size = 8;
        if (!find_descriptor(loop, 0x59, -1, &body)) return "";
    }
    std::string last;
    for (size_t i = 0; i + size <= body.size(); i += size) {
        std::string code;
        for (size_t j = 0; j < 3 && body[i + j] != 0; j++) code += (char)body[i + j];
        if (code.size() >= 2) last = code;     // tsdemux tags none shorter (a C string)
    }
    return last;
}

uint32_t metadata_format(const std::vector<uint8_t>& loop) {
    std::vector<uint8_t> b;
    if (!find_descriptor(loop, 0x26, -1, &b) || b.size() < 5) return 0;
    const size_t at = b[0] == 0xFF && b[1] == 0xFF ? 6 : 2;
    if (b.size() < at + 5 || b[at] != 0xFF) return 0;
    return be32(b.data() + at + 1);
}

std::optional<std::string> opus_caps(const std::vector<uint8_t>& ext) {
    if (ext.size() < 2 || ext[0] != 0x80) return std::nullopt;
    const int code = ext[1];
    if (code >= 0x89) return std::nullopt;
    int channels = code ? (code & 0x0F) : 2, family = 0, streams = 0, coupled = 0;
    std::vector<int> mapping;
    if (code == 0 || code == 0x80) {           // dual mono
        channels = 2;
        family = 255;
        streams = code == 0 ? 1 : 2;
        coupled = code == 0 ? 1 : 0;
        mapping = {0, 1};
    } else if (code <= 8) {
        family = channels > 2 ? 1 : 0;
        streams = code - OPUS_COUPLED[code];
        coupled = OPUS_COUPLED[code];
        if (family) mapping = OPUS_MAP_A[channels - 1];
    } else if (code >= 0x82) {
        family = 1;
        streams = channels;
        for (int i = 0; i < channels; i++) mapping.push_back(i);
    } else {                                   // 0x81: the extended configuration
        if (ext.size() < 4 || ext[2] == 0) return std::nullopt;
        channels = ext[2];
        family = ext[3];
        if (family == 0 && channels <= 2) {
            streams = channels - OPUS_COUPLED[channels];
            coupled = OPUS_COUPLED[channels];
        } else {
            Bits r(ext.data() + 4, ext.size() - 4);
            int m1 = 0;
            if (!r.read(bit_storage(channels), &m1)) return std::nullopt;
            streams = m1 + 1;
            if (!r.read(bit_storage(streams + 1), &coupled)) return std::nullopt;
            for (int i = 0; i < channels; i++) {
                int m = 0;
                if (!r.read(bit_storage(streams + coupled + 1), &m)) return std::nullopt;
                mapping.push_back(m);
            }
        }
    }
    char head[160];
    if (family == 0) {                         // gst_codec_utils_opus_create_caps' checks
        if (channels > 2 || streams > 1 || coupled > 1) return std::nullopt;
        if (!channels) channels = 2;
        if (!streams) streams = 1;
        if (!coupled) coupled = channels == 2 ? 1 : 0;
        std::snprintf(head, sizeof head,
                      "audio/x-opus, rate=(int)48000, channels=(int)%d, channel-mapping-family=(int)%d, "
                      "stream-count=(int)%d, coupled-count=(int)%d",
                      channels, family, streams, coupled);
        return std::string(head);
    }
    if (channels == 0 || streams == 0 || coupled > streams) return std::nullopt;
    std::snprintf(head, sizeof head,
                  "audio/x-opus, rate=(int)48000, channels=(int)%d, channel-mapping-family=(int)%d, "
                  "stream-count=(int)%d, coupled-count=(int)%d, channel-mapping=(int)< ",
                  channels, family, streams, coupled);
    std::string caps = head;
    for (size_t i = 0; i < mapping.size(); i++) caps += (i ? ", " : "") + std::to_string(mapping[i]);
    return caps + " >";
}

std::optional<EsPlan> classify(int t, const std::vector<uint8_t>& es_info) {
    EsPlan e;
    e.reg = registration_format(es_info);
    e.lang = language(es_info);
    auto row = [&](EsClass cls, std::string caps, bool sparse = false, AuPost post = AuPost::None) {
        e.cls = cls;
        e.caps = std::move(caps);
        e.sparse = sparse;
        e.post = post;
        return std::optional<EsPlan>(e);
    };
    if (t == 0x01 || t == 0x02)
        return row(EsClass::Video, "video/mpeg, mpegversion=(int)" + std::to_string(t) +
                                       ", systemstream=(boolean)false");
    if (t == 0x1B) return row(EsClass::Video, CAPS_H264);
    if (t == 0x24) return row(EsClass::Video, CAPS_H265);
    if (t == 0x03 || t == 0x04) return row(EsClass::Audio, CAPS_MPA);
    if (t == 0x0F) return row(EsClass::Audio, CAPS_ADTS, false, AuPost::Adts);
    if (t == 0x11) return row(EsClass::Audio, CAPS_LOAS);
    if (t == 0x81) return row(EsClass::Audio, has(es_info, 0x7A) ? CAPS_EAC3 : CAPS_AC3);   // tsdemux
    if (t == 0x87) return row(EsClass::Audio, CAPS_EAC3);
    if (t == 0x15) {
        const uint32_t fmt = metadata_format(es_info);
        if (fmt == REG_KLVA) return row(EsClass::Private, CAPS_KLV, true, AuPost::Klv);
        if (fmt == REG_ID3) return row(EsClass::Private, CAPS_ID3, true);
        return std::nullopt;
    }
    if (t != STREAM_TYPE_PRIVATE_PES) return std::nullopt;
    if (has(es_info, 0x7F, 0x15)) return std::nullopt;    // AC-4: tsdemux's audio/x-ac4, no row
    if (has(es_info, 0x6A)) return row(EsClass::Audio, CAPS_AC3);
    if (has(es_info, 0x7A)) return row(EsClass::Audio, CAPS_EAC3);
    if (has(es_info, 0x56)) return row(EsClass::Private, CAPS_TTX, true);
    if (has(es_info, 0x59)) return row(EsClass::Subpicture, CAPS_DVBSUB, true);
    if (e.reg == REG_BSSD) return row(EsClass::Audio, CAPS_302M);
    if (e.reg == REG_AV1G) {
        // The av1C fields of tsdemux's caps come from the descriptor, through pbutils: the element's.
        find_descriptor(es_info, 0x80, -1, &e.av1_desc);
        return row(EsClass::Video, CAPS_AV1);
    }
    if (e.reg == REG_OPUS) {
        find_descriptor(es_info, 0x7F, -1, &e.opus_ext);
        const std::optional<std::string> caps = opus_caps(e.opus_ext);
        if (!caps) return std::nullopt;
        return row(EsClass::Audio, *caps, false, AuPost::Opus);
    }
    if (e.reg == REG_HEVC) return row(EsClass::Video, CAPS_H265);
    if (e.reg == REG_KLVA) return row(EsClass::Private, CAPS_KLV, true);
    if (e.reg == REG_ID3) return row(EsClass::Private, CAPS_ID3, true);
    return std::nullopt;
}

EsClass unknown_class(int t, const std::vector<uint8_t>& es_info) {
    if (t == STREAM_TYPE_PRIVATE_PES) {
        const uint32_t reg = registration_format(es_info);
        if (has(es_info, 0x7F, 0x15) || reg == REG_DTS1 || reg == REG_DTS2 || reg == REG_DTS3 ||
            reg == REG_AC4 || reg == REG_OPUS)
            return EsClass::Audio;
        return reg == REG_VP09 ? EsClass::Video : EsClass::Private;
    }
    static const std::set<int> video = {0x10, 0x21, 0x32, 0x33, 0x42, 0x80, 0xD1, 0xEA};
    static const std::set<int> audio = {0x82, 0x83, 0x84, 0x85, 0x8A, 0x8B, 0xA1, 0xA2};
    static const std::set<int> subpicture = {0x90, 0x92, 0xFF};
    if (video.count(t)) return EsClass::Video;
    if (audio.count(t)) return EsClass::Audio;
    return subpicture.count(t) ? EsClass::Subpicture : EsClass::Private;
}

bool section_only_type(int t) {
    // tsdemux's PSI list (mpegtsbase.c _stream_is_private_section).
    switch (t) {
        case 0x05: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x13: case 0x16: case 0x86:
            return true;
        default:
            return false;
    }
}

std::string pad_name(EsClass c, int generation, int pid) {
    char b[32];
    std::snprintf(b, sizeof b, "%s_%01x_%04x", es_class_name(c), generation & 0xF, pid);
    return b;
}

bool same_program(const Pmt& a, const Pmt& b) {
    if (a.program_number != b.program_number || a.pcr_pid != b.pcr_pid) return false;
    if (a.streams.size() != b.streams.size()) return false;
    std::map<int, int> types;
    for (const PmtStream& s : a.streams) types[s.pid] = s.stream_type;
    for (const PmtStream& s : b.streams) {
        const auto it = types.find(s.pid);
        if (it == types.end() || it->second != s.stream_type) return false;
    }
    return true;
}

std::string reg_text(uint32_t reg) {
    if (reg == 0) return "";
    std::string s;
    for (int sh = 24; sh >= 0; sh -= 8) {
        const int c = (reg >> sh) & 0xFF;
        if (c < 0x20 || c >= 0x7F) {
            char b[16];
            std::snprintf(b, sizeof b, "0x%08x", reg);
            return b;
        }
        s += (char)c;
    }
    return s;
}

int64_t s302m_frames(const uint8_t* payload, size_t n) {
    if (n <= 4) return -1;
    const uint32_t h = be32(payload);
    const uint32_t size = h >> 16;                     // audio_packet_size
    const int channels = (int)((h >> 14) & 3) * 2 + 2;
    const int bits = (int)((h >> 4) & 3) * 4 + 16;     // 16, 20, 24; 28 is reserved
    if (4 + (size_t)size != n || bits > 24) return -1;
    // Each channel pair packs two samples and their 4 AES3 bits apiece.
    const int pair_bytes = (bits + 4) / 4;
    return 2 * (int64_t)(size / pair_bytes) / channels;
}

int adts_mpegversion(const uint8_t* p, size_t n) {
    if (n < 6) return 4;
    size_t loc = 0;
    while (loc + 2 < n && !(p[loc] == 0xFF && (p[loc + 1] & 0xF6) == 0xF0)) loc++;
    if (loc + 2 >= n || n - loc < 6) return 4;
    const int frame_len = ((p[loc + 3] & 0x03) << 11) | (p[loc + 4] << 3) | ((p[loc + 5] & 0xE0) >> 5);
    if (frame_len < 7 + ((p[loc + 1] & 0x01) ? 0 : 2)) return 4;
    return (p[loc + 1] & 0x08) ? 2 : 4;
}

bool opus_access_units(const uint8_t* p, size_t n, std::vector<OpusAu>* out) {
    out->clear();
    if (n < 2) return false;
    if ((((p[0] << 8) | p[1]) >> 5) != 0x3FF) {        // no control header: one raw packet
        out->push_back(OpusAu{0, n, 0, 0});
        return true;
    }
    for (size_t i = 0;;) {
        if (i + 2 > n) return false;
        const int cid = (p[i] << 8) | p[i + 1];
        i += 2;
        if ((cid >> 5) != 0x3FF) return false;
        size_t size = 0;
        for (;;) {
            if (i >= n) return false;
            const uint8_t b = p[i++];
            size += b;
            if (b != 0xFF) break;
        }
        OpusAu au;
        if (cid & 0x10) {
            if (i + 2 > n) return false;
            au.trim_start = (p[i] << 8) | p[i + 1];
            i += 2;
        }
        if (cid & 0x08) {
            if (i + 2 > n) return false;
            au.trim_end = (p[i] << 8) | p[i + 1];
            i += 2;
        }
        if (cid & 0x04) {
            if (i >= n || i + 1 + p[i] > n) return false;
            i += 1 + p[i];
        }
        // tsdemux's FIXME: au_size counts the packet alone (ffmpeg's and obe's streams).
        if (n - i < size) return false;
        au.off = i;
        au.len = size;
        out->push_back(au);
        i += size;
        if (i >= n) return true;
    }
}

bool klv_metadata_cells(const uint8_t* p, size_t n, std::vector<KlvCell>* out) {
    out->clear();
    for (size_t i = 0;;) {
        if (n - i < 5) return false;
        KlvCell c;
        c.service_id = p[i];
        c.sequence = p[i + 1];
        c.flags = p[i + 2];
        c.len = std::min<size_t>((size_t)((p[i + 3] << 8) | p[i + 4]), n - i - 5);
        i += 5;
        c.off = i;
        out->push_back(c);
        i += c.len;
        if (i >= n) return true;
    }
}

// --- DemuxCore ---------------------------------------------------------------------------

int64_t DemuxCore::Pad::frame() const {
    if (n_spacings < 2) return -1;
    int64_t s[SPACING_WINDOW];
    for (int i = 0; i < n_spacings; i++) {   // insertion sort: at most 8
        int j = i;
        for (; j > 0 && s[j - 1] > spacings[i]; j--) s[j] = s[j - 1];
        s[j] = spacings[i];
    }
    return s[n_spacings / 2];                // the upper median: the longer of two
}

void DemuxCore::Pad::learn(int64_t spacing) {
    spacings[next_spacing] = spacing;
    next_spacing = (next_spacing + 1) % SPACING_WINDOW;
    n_spacings = std::min(n_spacings + 1, SPACING_WINDOW);
}

void DemuxCore::Pad::forget_stream() {
    uw.reset();
    have_last = clean = false;
    n_spacings = next_spacing = 0;
}

bool DemuxCore::selectable(const std::string& select) {
    return select.empty() || select == CAPS_302M;
}

DemuxCore::DemuxCore() : DemuxCore(Config()) {}

DemuxCore::DemuxCore(const Config& cfg)
    : cfg_(cfg), select_(!cfg.select.empty()),
      pes_(PesAssembler::Config{cfg.max_pes_bytes, true}) {
    psi_.select_program(cfg.program);
    std::fill(std::begin(pad_index_), std::end(pad_index_), (int16_t)-1);
    one_.name = "src";
    one_.stream_type = STREAM_TYPE_PRIVATE_PES;
    one_.es.cls = EsClass::Audio;
    one_.es.caps = CAPS_302M;
    one_.es.reg = REG_BSSD;
    one_.s302m = true;
}

std::vector<std::string> DemuxCore::pads() const {
    std::vector<std::string> names;
    if (select_) {
        if (one_.pid >= 0) names.push_back(one_.name);
    } else {
        for (const Pad& p : pads_) names.push_back(p.name);
    }
    return names;
}

DemuxCore::Pad* DemuxCore::pad_of(int pid) {
    if (pid < 0 || pid > PID_NULL) return nullptr;
    if (select_) return one_.pid >= 0 && pid == one_.pid ? &one_ : nullptr;
    const int i = pad_index_[pid];
    return i >= 0 ? &pads_[(size_t)i] : nullptr;
}

int64_t DemuxCore::seed(int64_t own) const {
    // B-14: the unwrapped house time + 1 h, never folded to 33 bits.
    return now_ >= 0 ? ns_to_pts90k(now_) + MUX_CLOCK_BASE_90K : own;
}

void DemuxCore::feed(const uint8_t* d, size_t n, bool bus_discont, int64_t house_now_ns,
                     std::vector<DemuxEvent>& out) {
    now_ = house_now_ns;
    if (bus_discont) {
        // No packet joins across, the open PES are dropped, every pad's next unit is DISCONT.
        walker_.reset();
        pes_.reset();
        if (select_) {
            if (one_.pid >= 0) {
                one_.discont = true;
                one_.clean = false;
            }
        } else {
            for (Pad& p : pads_) {
                p.discont = true;
                p.clean = false;
            }
        }
    }
    walker_.feed(d, n, [&](const PacketView& v) { on_packet(v, out); });
    if (state_ != State::missing || warned_ || now_ < 0) return;
    if (missing_since_ < 0) {
        missing_since_ = now_;
    } else if (now_ - missing_since_ >= NO_STREAM_NS) {
        warned_ = true;
        DemuxEvent e;
        e.kind = DemuxEvent::Kind::no_stream;
        out.push_back(std::move(e));
    }
}

void DemuxCore::on_packet(const PacketView& v, std::vector<DemuxEvent>& out) {
    const CcTracker::Result cc = cc_.feed(v);
    if (v.pid == PID_PAT || (psi_.pmt_pid() >= 0 && v.pid == psi_.pmt_pid())) {
        on_psi(v, out);
        return;
    }
    // A PCR first: the adaptation field precedes the payload.
    if (v.af_pcr && have_program_ && v.pid == program_pmt_.pcr_pid) on_pcr(v, out);
    Pad* pad = pad_of(v.pid);
    if (!pad) return;
    pes_.feed(v, cc, units_);
    std::vector<PesUnit> units;
    units.swap(units_);
    for (PesUnit& u : units) on_unit(*pad, u, out);
    units.clear();
    units_.swap(units);
}

void DemuxCore::on_psi(const PacketView& v, std::vector<DemuxEvent>& out) {
    std::memcpy(one_pkt_[0].b, v.p, PKT);
    psi_.feed(one_pkt_);
    if (select_) {
        on_psi_select();
        return;
    }
    if (psi_.pat_generation() != pat_gen_) {
        pat_gen_ = psi_.pat_generation();
        section("pat", PID_PAT, true, out);
    }
    if (psi_.generation() == gen_ || !psi_.pmt()) return;
    gen_ = psi_.generation();
    // The PMT section before the pads, unlike tsdemux: the muxer hooks read it there (S14).
    section("pmt", psi_.pmt_pid(), false, out);
    const Pmt pmt = *psi_.pmt();
    on_pmt(pmt, out);
}

void DemuxCore::section(const char* table, int pid, bool pat, std::vector<DemuxEvent>& out) {
    DemuxEvent e;
    if (!(pat ? psi_.pat_section(e.bytes) : psi_.pmt_section(e.bytes))) return;
    e.kind = DemuxEvent::Kind::section;
    e.reason = table;
    e.pid = pid;
    e.version = e.bytes.size() > 5 ? (e.bytes[5] >> 1) & 0x1F : -1;
    out.push_back(std::move(e));
}

void DemuxCore::on_psi_select() {
    // SelectDemux::on_psi: at each PMT change the first stream select names, else missing.
    if (psi_.generation() == gen_ || !psi_.pmt()) return;
    gen_ = psi_.generation();
    int match = -1;
    if (cfg_.select == CAPS_302M)
        for (const PmtStream& s : psi_.pmt()->streams)
            if (s.pid > PID_PAT && s.pid < PID_NULL && s.pid != psi_.pmt_pid() &&
                s.stream_type == STREAM_TYPE_PRIVATE_PES && registration_format(s.es_info) == REG_BSSD) {
                match = s.pid;
                break;
            }
    if (match >= 0) {
        if (match != one_.pid) {
            if (one_.pid >= 0) pes_.select(one_.pid, false);
            one_.pid = match;
            pes_.select(match, true);
            one_.forget_stream();
            one_.discont = true;                // another stream on the same pad
        }
        state_ = State::found;
        return;
    }
    if (one_.pid >= 0) {
        pes_.select(one_.pid, false);
        one_.pid = -1;
        one_.forget_stream();
    }
    missing();
}

void DemuxCore::missing() {
    if (state_ != State::missing) {             // a new episode: the 2 s run from this plan
        state_ = State::missing;
        missing_since_ = now_;
        warned_ = false;
    }
}

void DemuxCore::on_pmt(const Pmt& pmt, std::vector<DemuxEvent>& out) {
    // A new program by tsdemux's rule: the old pads' open PES drained, the plan (generation
    // + 1), its unknown streams, then the old program gone (tsdemux's drain, add, remove).
    if (pmt.streams.empty()) return;            // tsdemux skips a PMT without entries
    if (have_program_ && same_program(program_pmt_, pmt)) return;
    const bool had = have_program_;
    const int old_gen = program_gen_;
    if (had) {
        std::vector<PesUnit> units;
        pes_.flush(units);
        for (PesUnit& u : units) on_unit(pads_[(size_t)pad_index_[u.pid]], u, out);
        for (Pad& p : pads_) {
            pes_.select(p.pid, false);
            dts_discarded_before_ += p.uw.dts_discarded();
            pad_index_[p.pid] = -1;
        }
    }
    const int gen = had ? old_gen + 1 : 0;
    std::vector<Pad> pads;
    std::vector<DemuxEvent> unknown;
    std::set<int> seen;
    for (const PmtStream& s : pmt.streams) {
        if (s.pid <= PID_PAT || s.pid >= PID_NULL || s.pid == psi_.pmt_pid() || seen.count(s.pid))
            continue;
        seen.insert(s.pid);
        std::optional<EsPlan> es = classify(s.stream_type, s.es_info);
        if (!es) {
            if (!section_only_type(s.stream_type) &&
                (cfg_.media_mask & media_bit(unknown_class(s.stream_type, s.es_info)))) {
                DemuxEvent e;
                e.kind = DemuxEvent::Kind::unknown;
                e.pid = s.pid;
                e.stream_type = s.stream_type;
                e.reg = registration_format(s.es_info);
                e.generation = gen;
                unknown.push_back(std::move(e));
            }
            continue;
        }
        if (!(cfg_.media_mask & media_bit(es->cls))) continue;
        Pad p;
        p.name = pad_name(es->cls, gen, s.pid);
        p.pid = s.pid;
        p.stream_type = s.stream_type;
        p.sparse = es->sparse;
        p.s302m = es->caps == CAPS_302M;
        p.video = es->cls == EsClass::Video;
        p.es = std::move(*es);
        pads.push_back(std::move(p));
    }
    pads_ = std::move(pads);
    for (size_t i = 0; i < pads_.size(); i++) {
        Pad& p = pads_[i];
        pad_index_[p.pid] = (int16_t)i;
        pes_.select(p.pid, true);
        if (p.sparse && have_pt_) {
            p.have_horizon = true;
            p.horizon = pt_;
        }
    }
    pcr_uw_ = Unwrapper();
    have_program_ = true;
    program_gen_ = gen;
    program_pmt_ = pmt;
    DemuxEvent plan;
    plan.kind = DemuxEvent::Kind::plan;
    plan.generation = gen;
    plan.program = pmt.program_number;
    plan.pcr_pid = pmt.pcr_pid;
    for (const Pad& p : pads_) plan.pads.push_back(DemuxPad{p.name, p.pid, p.stream_type, p.es});
    out.push_back(std::move(plan));
    for (DemuxEvent& e : unknown) {
        k_.unknown_streams++;
        out.push_back(std::move(e));
    }
    if (had) {
        DemuxEvent g;
        g.kind = DemuxEvent::Kind::gone;
        g.generation = old_gen;
        out.push_back(std::move(g));
    }
    if (!pads_.empty())
        state_ = State::found;
    else
        missing();
}

void DemuxCore::on_pcr(const PacketView& v, std::vector<DemuxEvent>& out) {
    const int64_t pcr = read_pcr(v.p);
    if (pcr < 0) return;
    const int64_t base = pcr / 300;
    const int64_t base_u = pcr_uw_.feed(base, seed(base));
    advance(pcr27_to_ns((base_u - MUX_CLOCK_BASE_90K) * 300 + pcr % 300), out);
}

void DemuxCore::advance(int64_t t, std::vector<DemuxEvent>& out) {
    // Program time on to t (B-86: a sparse PCR is valid, so units move it too); each sparse pad
    // a GAP [horizon, t - lag) once that span is past the lag.
    if (t < 0 || (have_pt_ && t <= pt_)) return;
    have_pt_ = true;
    pt_ = t;
    const int64_t lag = cfg_.sparse_gap_lag_ns;
    for (Pad& p : pads_) {
        if (!p.sparse || lag <= 0) continue;
        if (!p.have_horizon) {
            p.have_horizon = true;
            p.horizon = t;
        } else if (t - lag - p.horizon > lag) {
            // No data lost: no DISCONT and not counted with the holes.
            DemuxEvent g;
            g.kind = DemuxEvent::Kind::gap;
            g.pid = p.pid;
            g.pad = p.name;
            g.pts_ns = p.horizon;
            g.dur_ns = t - lag - p.horizon;
            g.reason = "sparse";
            out.push_back(std::move(g));
            p.horizon = t - lag;
        }
    }
}

void DemuxCore::gap(Pad& pad, int64_t start, int64_t end, const char* reason,
                    std::vector<DemuxEvent>& out) {
    DemuxEvent g;
    g.kind = DemuxEvent::Kind::gap;
    g.pid = pad.pid;
    g.pad = pad.name;
    g.pts_ns = start;
    g.dur_ns = end - start;
    g.reason = reason;
    out.push_back(std::move(g));
    k_.gaps++;
    pad.have_horizon = true;
    pad.horizon = end;
    pad.discont = true;
}

void DemuxCore::unit(Pad& pad, PesUnit& u, int64_t pts, int64_t dts, int64_t dur, bool discont,
                     int64_t pts_u, int64_t dts_u, std::vector<DemuxEvent>& out) {
    k_.pes++;
    DemuxEvent e;
    e.kind = DemuxEvent::Kind::unit;
    e.pid = u.pid;
    e.pad = pad.name;
    e.pts_ns = pts;
    e.dts_ns = dts;
    e.dur_ns = dur;
    e.discont = discont;
    e.hdr = u.hdr;
    e.pts_u = pts_u;
    e.dts_u = dts_u;
    e.bytes = std::move(u.payload);
    out.push_back(std::move(e));
}

void DemuxCore::on_unit(Pad& pad, PesUnit& u, std::vector<DemuxEvent>& out) {
    int64_t dur = -1;
    if (pad.s302m) {
        const int64_t frames = s302m_frames(u.payload.data(), u.payload.size());
        if (frames >= 0) dur = frames * SEC / S302M_RATE;
    }
    int64_t pts = -1, dts = -1, pts_u = Unwrapper::NO_DTS, dts_u = Unwrapper::NO_DTS;
    if (u.hdr.pts >= 0) {
        pts_u = pad.uw.feed(u.hdr.pts, seed(u.hdr.pts));
        dts_u = pad.uw.feed_dts(u.hdr.dts, pts_u);
        pts = pts90k_to_ns_ceil(pts_u - MUX_CLOCK_BASE_90K);
        dts = dts_u == Unwrapper::NO_DTS ? pts : pts90k_to_ns_ceil(dts_u - MUX_CLOCK_BASE_90K);
    } else {
        k_.pes_no_pts++;
    }
    if (pts < 0 || dts < 0) {
        // No place on the timeline (no PTS, or before house time 0): out untimed, nothing learned.
        unit(pad, u, -1, -1, -1, !pad.emitted || pad.discont || u.discont, pts_u, dts_u, out);
        pad.emitted = true;
        pad.discont = pad.clean = false;
        return;
    }
    if (!select_ && !pad.house_checked) {
        pad.house_checked = true;
        if (now_ >= 0 && (pts - now_ > NOT_HOUSE_NS || now_ - pts > NOT_HOUSE_NS)) {
            DemuxEvent e;
            e.kind = DemuxEvent::Kind::not_house_time;
            e.pid = pad.pid;
            e.offset_ms = (pts - now_) / 1000000;  // toward 0
            out.push_back(std::move(e));
        }
    }
    const int64_t frame = pad.frame();
    const bool clean = pad.have_last && pad.clean && !u.discont;
    if (!pad.sparse && pad.have_last && pad.have_horizon && frame > 0) {
        // The jump rule (S5): audio past two frames, video a hole of 1 s or more (B-89).
        const int64_t hole = pts - pad.horizon;
        if (pad.video ? hole >= VIDEO_HOLE_NS : hole > JUMP_FRAMES * frame)
            gap(pad, pad.horizon, pts, "jump", out);
    }
    // Spacing in decode order: a video pad's DTS, so reordered B-frame PTS do not widen its
    // frame; a jump's own spacing joins (a cadence rise is learned, B-21), a gap's or a loss's not.
    const int64_t t = pad.video ? dts : pts;
    if (!pad.sparse && clean && t - pad.last_t > 0 && t - pad.last_t <= SPACING_MAX_NS)
        pad.learn(t - pad.last_t);
    unit(pad, u, pts, dts, dur, !pad.emitted || pad.discont || u.discont, pts_u, dts_u, out);
    pad.emitted = true;
    pad.discont = false;
    pad.have_last = pad.clean = true;
    pad.last_t = t;
    // Its end: the 302M duration, else one learned frame (none on a sparse pad), else its start.
    const int64_t end = pts + (dur >= 0 ? dur : pad.sparse ? 0 : std::max<int64_t>(frame, 0));
    if (!pad.have_horizon || end > pad.horizon) {
        pad.have_horizon = true;
        pad.horizon = end;
    }
    if (!select_ && !pad.sparse) advance(end, out);
}

void DemuxCore::marker(const uint8_t* d, size_t n, int64_t end_ns, std::vector<DemuxEvent>& out) {
    for (size_t i = 0; i + PKT <= n; i += PKT) {
        const uint8_t* p = d + i;
        if (p[0] != SYNC_BYTE) continue;
        Pad* pad = pad_of(ts_pid(p));
        if (!pad) continue;
        const int64_t len = read_gap_length(p);
        if (len < 0) continue;                  // not a marker packet
        // The producer marks a PID right before its first PES after the hole, so the PES still
        // open (unbounded, ended only by that PUSI) is whole: out before the gap.
        std::vector<PesUnit> units;
        pes_.close(pad->pid, units);
        for (PesUnit& u : units) on_unit(*pad, u, out);
        k_.markers++;
        if (end_ns < 0) {
            k_.markers_dropped++;
            continue;
        }
        // B-21: never before what the pad emitted, and dropped when nothing remains.
        int64_t start = len >= end_ns ? 0 : end_ns - len;
        if (pad->have_horizon && start < pad->horizon) start = pad->horizon;
        if (start >= end_ns) {
            k_.markers_dropped++;
            continue;
        }
        gap(*pad, start, end_ns, "marker", out);
        pad->clean = false;                     // an outage's or an edit's spacing is no frame
    }
}

void DemuxCore::drain(std::vector<DemuxEvent>& out) {
    std::vector<PesUnit> units;
    pes_.flush(units);
    for (PesUnit& u : units) {
        Pad* pad = pad_of(u.pid);
        if (pad) on_unit(*pad, u, out);
    }
}

void DemuxCore::flush() {
    walker_.reset();
    cc_lost_before_ += cc_.lost();
    cc_ = CcTracker();
    pes_.reset();
    auto reset = [](Pad& p) {
        p.forget_stream();
        p.have_horizon = p.emitted = p.discont = false;
        p.horizon = 0;
    };
    if (select_)
        reset(one_);
    else
        for (Pad& p : pads_) reset(p);
    pcr_uw_.reset();
    have_pt_ = false;
    pt_ = 0;
}

DemuxCore::Counters DemuxCore::counters() const {
    Counters c = k_;
    c.desync_bytes = walker_.desync_bytes();
    c.cc_lost = cc_lost_before_ + cc_.lost();
    c.pes_oversize = pes_.oversize();
    c.pes_dropped_cc = pes_.dropped_cc();
    c.psi_unsupported_sections = psi_.unsupported_sections();
    c.dts_discarded = dts_discarded_before_;
    if (select_)
        c.dts_discarded += one_.uw.dts_discarded();
    else
        for (const Pad& p : pads_) c.dts_discarded += p.uw.dts_discarded();
    c.generation = have_program_ ? program_gen_ : -1;
    return c;
}

// --- .demux.jsonl ------------------------------------------------------------------------

namespace {

// A string as python's json.dumps writes it (ensure_ascii), each byte one latin-1 character.
std::string pyjson(const std::string& s) {
    std::string o = "\"";
    for (const unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            case '\b': o += "\\b"; break;
            case '\f': o += "\\f"; break;
            default:
                if (c >= 0x20 && c < 0x7F) {
                    o += (char)c;
                } else {
                    char b[8];
                    std::snprintf(b, sizeof b, "\\u%04x", c);
                    o += b;
                }
        }
    }
    return o + "\"";
}

std::string ns_or_null(int64_t v) { return v < 0 ? std::string("null") : std::to_string(v); }

std::string crc_hex(const std::vector<uint8_t>& b) {
    char h[16];
    std::snprintf(h, sizeof h, "%08x", crc32_zlib(b.data(), b.size()));
    return h;
}

}  // namespace

std::string demux_jsonl(const DemuxEvent& e) {
    using K = DemuxEvent::Kind;
    const std::string pid = std::to_string(e.pid);
    switch (e.kind) {
        case K::section:
            return "{\"section\":{\"table\":" + pyjson(e.reason) + ",\"pid\":" + pid + ",\"version\":" +
                   std::to_string(e.version) + ",\"len\":" + std::to_string(e.bytes.size()) + ",\"crc32\":\"" +
                   crc_hex(e.bytes) + "\"}}";
        case K::plan: {
            std::string l = "{\"plan\":{\"gen\":" + std::to_string(e.generation) + ",\"program\":" +
                            std::to_string(e.program) + ",\"pcrPid\":" + std::to_string(e.pcr_pid) +
                            ",\"pads\":[";
            for (size_t k = 0; k < e.pads.size(); k++) {
                const DemuxPad& p = e.pads[k];
                l += std::string(k ? "," : "") + "{\"pad\":" + pyjson(p.name) + ",\"pid\":" +
                     std::to_string(p.pid) + ",\"type\":" + std::to_string(p.stream_type) + ",\"caps\":" +
                     pyjson(p.es.caps) +
                     ",\"sparse\":" + (p.es.sparse ? "true" : "false") + ",\"lang\":" + pyjson(p.es.lang) +
                     ",\"post\":" + pyjson(au_post_name(p.es.post)) + "}";
            }
            return l + "]}}";
        }
        case K::gone:
            return "{\"gone\":{\"gen\":" + std::to_string(e.generation) + "}}";
        case K::unit:
            return "{\"unit\":{\"pad\":" + pyjson(e.pad) + ",\"pts\":" + ns_or_null(e.pts_ns) + ",\"dts\":" +
                   ns_or_null(e.dts_ns) + ",\"dur\":" + ns_or_null(e.dur_ns) + ",\"len\":" +
                   std::to_string(e.bytes.size()) + ",\"crc32\":\"" + crc_hex(e.bytes) + "\",\"discont\":" +
                   (e.discont ? "true" : "false") + "}}";
        case K::gap:
            return "{\"gap\":{\"pad\":" + pyjson(e.pad) + ",\"pts\":" + std::to_string(e.pts_ns) + ",\"dur\":" +
                   std::to_string(e.dur_ns) + ",\"reason\":" + pyjson(e.reason) + "}}";
        case K::unknown:
            return "{\"unknown\":{\"pid\":" + pid + ",\"type\":" + std::to_string(e.stream_type) + ",\"reg\":" +
                   pyjson(reg_text(e.reg)) + ",\"gen\":" + std::to_string(e.generation) + "}}";
        case K::not_house_time:
            return "{\"nothouse\":{\"pid\":" + pid + ",\"offsetMs\":" + std::to_string(e.offset_ms) + "}}";
        default:
            return "{\"nostream\":{}}";
    }
}

std::string demux_jsonl(const DemuxCore::Counters& c) {
    auto u = [](uint64_t v) { return std::to_string(v); };
    return "{\"counters\":{\"pes\":" + u(c.pes) + ",\"gaps\":" + u(c.gaps) + ",\"markers\":" + u(c.markers) +
           ",\"markersDropped\":" + u(c.markers_dropped) + ",\"pesNoPts\":" + u(c.pes_no_pts) +
           ",\"desyncBytes\":" + u(c.desync_bytes) + ",\"ccLost\":" + u(c.cc_lost) + ",\"pesOversize\":" +
           u(c.pes_oversize) + ",\"pesDroppedCc\":" + u(c.pes_dropped_cc) + ",\"psiUnsupported\":" +
           u(c.psi_unsupported_sections) + ",\"dtsDiscarded\":" + u(c.dts_discarded) + ",\"unknownStreams\":" +
           u(c.unknown_streams) + ",\"generation\":" + std::to_string(c.generation) + "}}";
}

int64_t first_pes_house_ns(const uint8_t* d, size_t n) {
    for (size_t off = 0; off + PKT <= n; off += PKT) {
        const uint8_t* p = d + off;
        if (p[0] != SYNC_BYTE || !ts_pusi(p) || !ts_has_payload(p)) continue;
        const int at = payload_offset(p);
        if (at >= PKT) continue;
        PesHeader h;
        if (parse_pes_header(p + at, PKT - at, &h) && h.pts >= 0)
            return pts90k_to_ns_ceil(((h.pts - MUX_CLOCK_BASE_90K) % PTS_WRAP + PTS_WRAP) % PTS_WRAP);
    }
    return -1;
}

}  // namespace mrts
