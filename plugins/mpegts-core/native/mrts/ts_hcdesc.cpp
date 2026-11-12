#include "ts_hcdesc.h"

#include <cmath>
#include <cstdio>

namespace mrts {

bool HouseTimeDecl::operator==(const HouseTimeDecl& o) const {
    return version == o.version && house_time_tai == o.house_time_tai &&
           disciplined == o.disciplined && traceable == o.traceable &&
           ptp_valid == o.ptp_valid && sync_source == o.sync_source &&
           tai_utc_offset_s == o.tai_utc_offset_s && ptp_domain == o.ptp_domain &&
           clock_error_class == o.clock_error_class && gm_identity == o.gm_identity &&
           epoch_seq == o.epoch_seq && d_e_90k == o.d_e_90k && timeline_id == o.timeline_id;
}

namespace hcdesc {
namespace {

void put_be(uint8_t* p, uint64_t v, int n) {
    for (int i = n - 1; i >= 0; i--, v >>= 8) p[i] = (uint8_t)v;
}

uint64_t get_be(const uint8_t* p, int n) {
    uint64_t v = 0;
    for (int i = 0; i < n; i++) v = (v << 8) | p[i];
    return v;
}

// A loop entry at `p` with `len` payload bytes is an MRHT registration.
bool is_mrht(const uint8_t* p, int len) {
    return p[0] == TAG && len >= 4 && get_be(p + 2, 4) == FORMAT;
}

int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

}  // namespace

void encode(const HouseTimeDecl& d, uint8_t out[BYTES]) {
    out[0] = TAG;
    out[1] = LENGTH;
    put_be(out + 2, FORMAT, 4);
    out[6] = VERSION;                     // what this encoder writes, whatever d.version holds
    out[7] = (uint8_t)((d.house_time_tai ? 0x80 : 0) | (d.disciplined ? 0x40 : 0) |
                       (d.traceable ? 0x20 : 0) | (d.ptp_valid ? 0x10 : 0) | 0x0F);
    out[8] = d.sync_source;
    out[9] = d.tai_utc_offset_s;
    out[10] = d.ptp_valid ? d.ptp_domain : 0xFF;
    put_be(out + 11, d.ptp_valid ? d.gm_identity : ~0ull, 8);
    out[19] = d.clock_error_class;
    put_be(out + 20, d.epoch_seq, 2);
    put_be(out + 22, d.d_e_90k, 4);
    put_be(out + 26, d.timeline_id, 8);
}

bool decode(const uint8_t* data, int len, HouseTimeDecl* out) {
    if (len < 2) return false;
    const int dl = data[1];
    if (dl < MIN_LENGTH || 2 + dl > len || !is_mrht(data, dl) || data[6] < 1) return false;
    HouseTimeDecl d;
    d.version = data[6];
    d.house_time_tai = data[7] & 0x80;
    d.disciplined = data[7] & 0x40;
    d.traceable = data[7] & 0x20;
    d.ptp_valid = data[7] & 0x10;
    d.sync_source = data[8];
    d.tai_utc_offset_s = data[9];
    d.ptp_domain = data[10];
    d.gm_identity = get_be(data + 11, 8);
    d.clock_error_class = data[19];
    d.epoch_seq = (uint16_t)get_be(data + 20, 2);
    d.d_e_90k = (uint32_t)get_be(data + 22, 4);
    d.timeline_id = dl >= LENGTH ? get_be(data + 26, 8) : 0;
    *out = d;
    return true;
}

bool find_in(const std::vector<uint8_t>& pi, HouseTimeDecl* out) {
    const int n = (int)pi.size();
    for (int i = 0; i + 2 <= n && i + 2 + pi[i + 1] <= n; i += 2 + pi[i + 1])
        if (decode(pi.data() + i, n - i, out)) return true;
    return false;
}

std::vector<uint8_t> strip_from(const std::vector<uint8_t>& pi) {
    std::vector<uint8_t> r;
    const int n = (int)pi.size();
    int i = 0;
    for (; i + 2 <= n && i + 2 + pi[i + 1] <= n; i += 2 + pi[i + 1])
        if (!is_mrht(pi.data() + i, pi[i + 1]))
            r.insert(r.end(), pi.begin() + i, pi.begin() + i + 2 + pi[i + 1]);
    r.insert(r.end(), pi.begin() + i, pi.end());   // an overrunning tail, verbatim
    return r;
}

uint8_t error_class(double err_us) {
    if (!(err_us >= 0)) return ERROR_CLASS_UNKNOWN;
    uint8_t c = 0;
    while (c < ERROR_CLASS_MAX && std::ldexp(1.0, c) < err_us) c++;
    return c;
}

double error_bound_us(uint8_t cls) {
    return cls == ERROR_CLASS_UNKNOWN ? -1.0 : std::ldexp(1.0, cls);
}

bool parse_gm(const std::string& s, uint64_t* out) {
    // pmc: 6.4.6 hex digits; RFC 7273 and colon forms: eight pairs, one separator.
    const bool pmc = s.size() == 18 && s[6] == '.' && s[11] == '.';
    const bool pairs = s.size() == 23 && (s[2] == ':' || s[2] == '-');
    if (!pmc && !pairs) return false;
    uint64_t v = 0;
    for (size_t i = 0; i < s.size(); i++) {
        const bool sep = pmc ? (i == 6 || i == 11) : (i % 3 == 2);
        if (sep) {
            if (s[i] != s[pmc ? 6 : 2]) return false;
            continue;
        }
        const int h = hex_digit(s[i]);
        if (h < 0) return false;
        v = (v << 4) | (uint64_t)h;
    }
    *out = v;
    return true;
}

std::string gm_text(uint64_t gm) {
    char b[24];
    int k = 0;
    for (int i = 7; i >= 0; i--)
        k += std::snprintf(b + k, sizeof b - k, i ? "%02X-" : "%02X", (unsigned)((gm >> (8 * i)) & 0xFF));
    return std::string(b, k);
}

std::string timeline_text(uint64_t id) {
    char b[17];
    std::snprintf(b, sizeof b, "%016llx", (unsigned long long)id);
    return b;
}

bool parse_timeline_text(const std::string& s, uint64_t* out) {
    if (s.size() != 16) return false;
    uint64_t v = 0;
    for (char c : s) {
        const int h = (c >= 'A' && c <= 'F') ? -1 : hex_digit(c);   // lower case only
        if (h < 0) return false;
        v = (v << 4) | (uint64_t)h;
    }
    *out = v;
    return true;
}

}  // namespace hcdesc
}  // namespace mrts
