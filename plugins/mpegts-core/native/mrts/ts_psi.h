// C++ port of ts_psi.py — MPEG-TS PSI parse/build + packet header helpers.
// What the Python has mirrors it byte-for-byte (locked by the golden parity
// test; see ts_psi.py for the protocol commentary). Descriptors, program
// selection and multi-packet sections (WI-S0-5) are C++ only.
#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <type_traits>
#include <utility>
#include <vector>

// PKT, SYNC_BYTE and the packet header helpers moved to ts_packet.h, PCR_HZ and
// PCR_MODULO to ts_house.h, read_pcr and build_pcr_packet to ts_pcr.h, the PES
// header parse to ts_pes.h; included here so every caller compiles unchanged.
#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pcr.h"
#include "ts_pes.h"

namespace mrts {

constexpr int PID_PAT = 0x0000;
constexpr int PID_NULL = 0x1FFF;
constexpr int TABLE_PAT = 0x00;
constexpr int TABLE_PMT = 0x02;

constexpr int STREAM_TYPE_MPEG2_VIDEO = 0x02;
constexpr int STREAM_TYPE_PRIVATE_PES = 0x06;
constexpr int STREAM_TYPE_AAC = 0x0F;
constexpr int STREAM_TYPE_KLV = 0x15;
constexpr int STREAM_TYPE_AVC = 0x1B;
constexpr int STREAM_TYPE_HEVC = 0x24;

// One retained 188-byte packet (PSI reassembly buffers hold copies).
struct TsPacket {
    uint8_t b[PKT];
};

// CRC-32/MPEG-2: poly 0x04C11DB7, init 0xFFFFFFFF, no reflection/xorout.
uint32_t crc32_mpeg(const uint8_t* data, size_t n);

// 33-bit 90 kHz PTS of the PES header starting in this packet, or -1. Forwards to
// parse_pes_header until its last caller moves (Phase 3); ts_psi_test pins it to
// the body it replaced.
inline int64_t read_pes_pts(const uint8_t* pkt) {
    if (!ts_pusi(pkt) || !ts_has_payload(pkt)) return -1;
    const int off = payload_offset(pkt);
    if (off >= PKT) return -1;
    PesHeader h;
    return parse_pes_header(pkt + off, PKT - off, &h) ? h.pts : -1;
}

void null_packet(int cc, uint8_t out[PKT]);

struct PmtStream {
    int pid = 0;
    int stream_type = 0;
    std::vector<uint8_t> es_info;   // raw descriptor loop, carried verbatim
    bool operator==(const PmtStream& o) const {
        return pid == o.pid && stream_type == o.stream_type && es_info == o.es_info;
    }
};

// One descriptor of a loop (ISO 13818-1 2.6); `data` is its payload, after the
// tag and length bytes.
struct Descriptor {
    uint8_t tag;
    const uint8_t* data;
    int len;
};

// Calls f(const Descriptor&) per descriptor of an n-byte loop, in order. The loop
// is wire input, so the walk stops at a descriptor that overruns it; an f that
// returns bool stops it by returning false.
template <class F>
void for_each_descriptor(const uint8_t* loop, int n, F&& f) {
    for (int i = 0; i + 2 <= n;) {
        const int len = loop[i + 1];
        if (i + 2 + len > n) return;
        const Descriptor d{loop[i], loop + i + 2, len};
        if constexpr (std::is_same_v<std::invoke_result_t<F&, const Descriptor&>, bool>) {
            if (!f(d)) return;
        } else {
            f(d);
        }
        i += 2 + len;
    }
}

// format_identifier of the loop's first registration descriptor (0x05) as a
// big-endian uint32 ('Opus' = 0x4F707573); 0 when there is none or it is shorter
// than 4 bytes, tsdemux's rule (mpegtsbase.c get_registration_from_descriptors).
uint32_t registration_format(const std::vector<uint8_t>& es_info);
bool has_descriptor(const std::vector<uint8_t>& es_info, uint8_t tag);

// Single-packet section builders. false = section too large for one packet.
bool build_pat(int ts_id, const std::vector<std::pair<int, int>>& programs,
               int cc, int version, uint8_t out[PKT]);
bool build_pmt(int pmt_pid, int program_number, int pcr_pid,
               const std::vector<PmtStream>& streams, int cc, int version,
               uint8_t out[PKT]);

// A PMT section of any size (e.g. carrying the Phase 5 descriptor), CRC
// included; with no program_info it is build_pmt's section. Empty past the
// 1024-byte section limit (ISO 13818-1 2.4.4.9).
std::vector<uint8_t> build_pmt_section(int program_number, int pcr_pid,
                                       const std::vector<uint8_t>& program_info,
                                       const std::vector<PmtStream>& streams,
                                       int version);

// Appends `section` to `out` as packets on `pid`: PUSI and pointer_field 0 in
// the first, none in the rest, 0xFF stuffing after the section. Stamps cc on
// each packet and leaves it at the PID's next CC.
void packetise_section(int pid, const std::vector<uint8_t>& section, uint8_t& cc,
                       std::vector<uint8_t>& out);

// Reassemble the first complete PSI section carried on `pid` whose section_number
// is 0; a later section is skipped, as the parsers here understand section 0 only.
bool first_section(const std::deque<TsPacket>& packets, int pid,
                   std::vector<uint8_t>& section);

// {program_number, pmt_pid} in section order (program 0 = NIT, excluded).
std::vector<std::pair<int, int>> parse_pat(const std::deque<TsPacket>& packets);

// A section's own change signals, read from the packet that starts it — the
// cheap "did this table change?" test that avoids a full reassembly + parse.
struct SectionSig {
    int table_id = -1;
    int table_id_ext = -1;      // program_number for a PMT, ts_id for a PAT
    int version = -1;           // version_number (5 bits)
    uint32_t crc = 0;           // section CRC32; only valid when has_crc
    bool has_crc = false;       // false = the section's tail is in a later packet
    bool operator==(const SectionSig& o) const {
        return table_id == o.table_id && table_id_ext == o.table_id_ext &&
               version == o.version && has_crc == o.has_crc &&
               (!has_crc || crc == o.crc);
    }
};

// Signature of the section starting in `pkt`. false = nothing usable here: no
// PUSI/payload, pointer_field past the packet, a short or non-syntax section,
// current_next_indicator=0 (that section describes the *next* table, not the
// one in force), or section_number != 0 (first_section, hence every parser
// here, only ever sees section 0). A section spanning several packets
// signatures on version alone — its CRC tail is not in this packet.
bool section_signature(const uint8_t* pkt, SectionSig* out);

struct Pmt {
    int program_number = 0;
    int pcr_pid = -1;
    std::vector<PmtStream> streams;     // section order; es_info verbatim
    int version = -1;                   // version_number; -1 until parsed
    std::vector<uint8_t> program_info;  // program descriptor loop, verbatim
    bool operator==(const Pmt& o) const {
        return program_number == o.program_number && pcr_pid == o.pcr_pid &&
               streams == o.streams && version == o.version &&
               program_info == o.program_info;
    }
};
std::optional<Pmt> parse_pmt(const std::deque<TsPacket>& packets, int pmt_pid);

// Incremental PAT -> PMT discovery over sparse PSI (see PsiDiscovery in
// ts_psi.py: persistent per-PID buffers, section-signature change detection,
// periodic PMT re-parse as the backstop).
class PsiDiscovery {
  public:
    explicit PsiDiscovery(int max_psi_pkts = 128) : max_(max_psi_pkts) {}
    // Absorb one feed's PSI packets (empty is fine — the call count drives the
    // periodic re-parse). True when the PMT first parses or its program, PCR
    // PID or ES list changes; a version- or program_info-only change is not.
    bool feed(const std::vector<TsPacket>& packets);
    // Follow this program of the PAT; -1 (the default) = the PAT's first. Until
    // a PAT lists it nothing is discovered; a new choice drops the PMT state.
    void select_program(int program_number);
    int pmt_pid() const { return pmt_pid_; }
    int program() const { return program_; }   // the PAT's program on pmt_pid(); -1 until then
    const std::optional<Pmt>& pmt() const { return pmt_; }
    // Bumps on every PMT change, any field: the first parse, the changes feed()
    // reports, and version- or program_info-only ones.
    int generation() const { return generation_; }
    // Current PAT / own-PMT section starts with section_number != 0, every
    // repeat: the parsers here understand section 0 only (R1, now visible).
    uint64_t unsupported_sections() const { return unsupported_; }

  private:
    int max_;
    std::deque<TsPacket> pat_pkts_, pmt_pkts_;
    long long n_ = 0;
    int pmt_pid_ = -1;
    int program_ = -1;                  // program the PAT mapped to pmt_pid_
    bool pmt_shared_ = false;           // the PAT maps pmt_pid_ to other programs too
    int select_ = -1;                   // select_program's choice
    std::optional<Pmt> pmt_;
    // Signature of the last section handed to the parser; a differing one
    // re-parses at once. `*_new_sig_` is the pending candidate, promoted only
    // once the parse of that section actually completed (a section spanning
    // packets stays pending until its tail arrives).
    SectionSig pat_sig_, pat_new_sig_, pmt_sig_, pmt_new_sig_;
    bool pat_resync_ = false, pmt_resync_ = false;
    int generation_ = 0;
    uint64_t unsupported_ = 0;
};

}  // namespace mrts
