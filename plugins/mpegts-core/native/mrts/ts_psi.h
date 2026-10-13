// C++ port of ts_psi.py — MPEG-TS PSI parse/build + packet header helpers.
// Behavior mirrors the Python module byte-for-byte (locked by the golden
// parity test); see ts_psi.py for the full protocol commentary.
#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <utility>
#include <vector>

// PKT, SYNC_BYTE and the packet header helpers moved to ts_packet.h, PCR_HZ and
// PCR_MODULO to ts_house.h, read_pcr and build_pcr_packet to ts_pcr.h; included
// here so every caller compiles unchanged.
#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pcr.h"

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

// 33-bit 90 kHz PTS of the PES header starting in this packet, or -1.
int64_t read_pes_pts(const uint8_t* pkt);

void null_packet(int cc, uint8_t out[PKT]);

struct PmtStream {
    int pid = 0;
    int stream_type = 0;
    std::vector<uint8_t> es_info;   // raw descriptor loop, carried verbatim
    bool operator==(const PmtStream& o) const {
        return pid == o.pid && stream_type == o.stream_type && es_info == o.es_info;
    }
};

// Single-packet section builders. false = section too large for one packet.
bool build_pat(int ts_id, const std::vector<std::pair<int, int>>& programs,
               int cc, int version, uint8_t out[PKT]);
bool build_pmt(int pmt_pid, int program_number, int pcr_pid,
               const std::vector<PmtStream>& streams, int cc, int version,
               uint8_t out[PKT]);

// Reassemble the first complete PSI section carried on `pid`.
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
    std::vector<PmtStream> streams;   // section order; es_info verbatim
    bool operator==(const Pmt& o) const {
        return program_number == o.program_number && pcr_pid == o.pcr_pid &&
               streams == o.streams;
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
    // periodic re-parse). True when the PMT first parses or changes.
    bool feed(const std::vector<TsPacket>& packets);
    int pmt_pid() const { return pmt_pid_; }
    const std::optional<Pmt>& pmt() const { return pmt_; }

  private:
    int max_;
    std::deque<TsPacket> pat_pkts_, pmt_pkts_;
    long long n_ = 0;
    int pmt_pid_ = -1;
    int program_ = -1;                  // program the PAT mapped to pmt_pid_
    std::optional<Pmt> pmt_;
    // Signature of the last section handed to the parser; a differing one
    // re-parses at once. `*_new_sig_` is the pending candidate, promoted only
    // once the parse of that section actually completed (a section spanning
    // packets stays pending until its tail arrives).
    SectionSig pat_sig_, pat_new_sig_, pmt_sig_, pmt_new_sig_;
    bool pat_resync_ = false, pmt_resync_ = false;
};

}  // namespace mrts
