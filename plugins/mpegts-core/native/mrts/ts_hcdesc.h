// The house-time descriptor (plan ch. 9 part 4.3, B-219): a registration
// descriptor 'MRHT' in a PMT's program_info loop, written by the egress writer
// and read by a Trust ingest. Encode, decode, find and strip; the text forms.
#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace mrts {

// One program's declaration. On the wire with ptp_valid = 0, ptp_domain is
// 0xFF and gm_identity all ones whatever these hold; decode returns the wire.
struct HouseTimeDecl {
    uint8_t version = 1;              // hc_version: decode's; encode writes hcdesc::VERSION
    bool house_time_tai = false;      // b7: PTS/DTS are H mod 2^33, PCR H(emission) - D_e
    bool disciplined = false;         // b6: the sender's daemon synchronised and disciplining
    bool traceable = false;           // b5: E latched while synchronised, kernel TAI offset set
    bool ptp_valid = false;           // b4: ptp_domain and gm_identity are meaningful
    uint8_t sync_source = 0;          // hcdesc::SYNC_*
    uint8_t tai_utc_offset_s = 0;     // the sender's kernel TAI - UTC; 0 = unset
    uint8_t ptp_domain = 0xFF;
    uint8_t clock_error_class = 0xFF; // error <= 2^class us; 0xFF unknown
    uint64_t gm_identity = ~0ull;     // EUI-64 clockIdentity of PARENT_DATA_SET
    uint16_t epoch_seq = 0;           // HouseEpoch.seq mod 65536
    uint32_t d_e_90k = 0;             // the egress delay D_e in 90 kHz ticks
    uint64_t timeline_id = 0;         // the sender's timeline (S27); 0 = none
    bool operator==(const HouseTimeDecl& o) const;
};

namespace hcdesc {

constexpr uint8_t TAG = 0x05;                   // registration_descriptor
constexpr uint32_t FORMAT = 0x4D524854;         // 'MRHT' (OQ-37, unregistered)
constexpr uint8_t VERSION = 1;
constexpr int LENGTH = 32;                      // descriptor_length written
constexpr int MIN_LENGTH = 24;                  // the shortest a decoder takes
constexpr int BYTES = 2 + LENGTH;               // the whole descriptor, 34
constexpr uint8_t SYNC_NONE = 0, SYNC_NTP = 1, SYNC_SNTP = 2, SYNC_PTP = 3;
constexpr uint8_t ERROR_CLASS_UNKNOWN = 0xFF;
constexpr uint8_t ERROR_CLASS_MAX = 31;

// The whole descriptor, tag to timeline_id; hc_version is VERSION and the
// reserved flag bits b3-b0 are 1.
void encode(const HouseTimeDecl& decl, uint8_t out[BYTES]);
// `data` = a descriptor from its tag, `len` bytes available. Takes an MRHT of
// descriptor_length >= 24 and hc_version >= 1, reads the fields it knows and
// ignores trailing bytes; a 24-byte one has timeline_id 0.
bool decode(const uint8_t* data, int len, HouseTimeDecl* out);
// The first MRHT of the loop that decodes, past any other registration (S4).
bool find_in(const std::vector<uint8_t>& program_info, HouseTimeDecl* out);
// The loop without any MRHT; every other byte kept, in order.
std::vector<uint8_t> strip_from(const std::vector<uint8_t>& program_info);

// ceil(log2(max(1, err_us))) saturating at 31; negative or NaN = 0xFF unknown.
uint8_t error_class(double err_us);
// 2^class us; -1 for unknown.
double error_bound_us(uint8_t cls);

// A clockIdentity as pmc prints it (2ccf67.fffe.76e669) or as eight bytes
// split by ':' or '-' (RFC 7273's form), either case. false = none of them.
bool parse_gm(const std::string& text, uint64_t* out);
// RFC 7273's form, upper case: 2C-CF-67-FF-FE-76-E6-69.
std::string gm_text(uint64_t gm);

// timeline_id's one text form: 16 lower-case hex digits, no prefix.
std::string timeline_text(uint64_t id);
bool parse_timeline_text(const std::string& text, uint64_t* out);

}  // namespace hcdesc

// The element's `house-clock` value (p5-9) plus timeline_id (p5-20; 0 until then): the
// local clock the egress declares and Trust checks against.
struct ClockDecl {
    int64_t e_ns = 0;
    int64_t seq = 0;
    bool known = false, traceable = false, disciplined = false;
    uint8_t source = hcdesc::SYNC_NONE;
    int64_t tai_offset_s = 0;
    int ptp_domain = -1;                      // -1: none
    std::optional<uint64_t> gm;               // EUI-64; none = unknown
    std::optional<int64_t> error_us;          // none = unknown
    uint64_t timeline_id = 0;
};

}  // namespace mrts
