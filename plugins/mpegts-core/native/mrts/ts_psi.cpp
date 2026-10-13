#include "ts_psi.h"

#include <algorithm>
#include <cstring>

namespace mrts {

namespace {

struct CrcTable {
    uint32_t t[256];
    CrcTable() {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t crc = i << 24;
            for (int k = 0; k < 8; k++)
                crc = (crc & 0x80000000u) ? (crc << 1) ^ 0x04C11DB7u : (crc << 1);
            t[i] = crc;
        }
    }
};
const CrcTable kCrc;

// section_syntax_indicator=1, reserved '0', reserved '11', 12-bit length.
void section_length_field(int total_after_length, uint8_t* hi, uint8_t* lo) {
    int val = 0xB000 | (total_after_length & 0x0FFF);
    *hi = (val >> 8) & 0xFF;
    *lo = val & 0xFF;
}

// body = table bytes WITHOUT CRC; append CRC and wrap in one TS packet.
bool wrap_section(int pid, const uint8_t* body, int blen, int cc, uint8_t out[PKT]) {
    if (1 + blen + 4 > PKT - 4) return false;   // pointer + section + CRC
    uint32_t crc = crc32_mpeg(body, blen);
    out[0] = SYNC_BYTE;
    out[1] = 0x40 | ((pid >> 8) & 0x1F);        // PUSI = 1
    out[2] = pid & 0xFF;
    out[3] = 0x10 | (cc & 0x0F);                // payload only
    out[4] = 0x00;                              // pointer_field
    std::memcpy(out + 5, body, blen);
    out[5 + blen] = crc >> 24;
    out[6 + blen] = crc >> 16;
    out[7 + blen] = crc >> 8;
    out[8 + blen] = crc & 0xFF;
    std::memset(out + 9 + blen, 0xFF, PKT - 9 - blen);
    return true;
}

// The PMT section up to its CRC (ISO 13818-1 2.4.4.8), section_length set. One
// body for build_pmt and build_pmt_section, so the two cannot drift apart.
std::vector<uint8_t> pmt_body(int program_number, int pcr_pid,
                              const std::vector<uint8_t>& program_info,
                              const std::vector<PmtStream>& streams, int version) {
    std::vector<uint8_t> body = {TABLE_PMT, 0x00, 0x00,
                                 (uint8_t)((program_number >> 8) & 0xFF),
                                 (uint8_t)(program_number & 0xFF),
                                 (uint8_t)(0xC1 | ((version & 0x1F) << 1)),
                                 0x00, 0x00,
                                 (uint8_t)(0xE0 | ((pcr_pid >> 8) & 0x1F)),
                                 (uint8_t)(pcr_pid & 0xFF),
                                 (uint8_t)(0xF0 | ((program_info.size() >> 8) & 0x0F)),
                                 (uint8_t)(program_info.size() & 0xFF)};
    body.insert(body.end(), program_info.begin(), program_info.end());
    for (const auto& s : streams) {
        body.push_back(s.stream_type & 0xFF);
        body.push_back(0xE0 | ((s.pid >> 8) & 0x1F));
        body.push_back(s.pid & 0xFF);
        body.push_back(0xF0 | ((s.es_info.size() >> 8) & 0x0F));
        body.push_back(s.es_info.size() & 0xFF);
        body.insert(body.end(), s.es_info.begin(), s.es_info.end());
    }
    section_length_field((int)(body.size() - 3) + 4, &body[1], &body[2]);
    return body;
}

// The section starting in `pkt` when its header (table_id .. last_section_number)
// is in this packet, else null.
const uint8_t* section_head(const uint8_t* pkt) {
    if (!ts_pusi(pkt) || !ts_has_payload(pkt)) return nullptr;
    int off = payload_offset(pkt);
    if (off >= PKT) return nullptr;
    int start = off + 1 + pkt[off];              // pointer_field -> section start
    if (start + 8 > PKT) return nullptr;         // need table_id .. last_section
    return pkt + start;
}

// A current `table_id` section past the first, of program `ext` when ext >= 0:
// what unsupported_sections() counts.
bool later_section(const uint8_t* pkt, int table_id, int ext) {
    const uint8_t* s = section_head(pkt);
    return s && s[0] == table_id && (s[1] & 0x80) && (s[5] & 0x01) && s[6] != 0 &&
           (ext < 0 || ((s[3] << 8) | s[4]) == ext);
}

// What feed() has always compared, so its callers see no version- or
// program_info-only change.
bool same_stream_map(const Pmt& a, const Pmt& b) {
    return a.program_number == b.program_number && a.pcr_pid == b.pcr_pid &&
           a.streams == b.streams;
}

}  // namespace

uint32_t crc32_mpeg(const uint8_t* data, size_t n) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++)
        crc = (crc << 8) ^ kCrc.t[((crc >> 24) ^ data[i]) & 0xFF];
    return crc;
}

// Stream ids whose PES packets carry no optional header, hence never a PTS
// (ISO 13818-1 §2.4.3.7).
static bool pes_no_header_id(uint8_t sid) {
    switch (sid) {
        case 0xBC: case 0xBE: case 0xBF: case 0xF0:
        case 0xF1: case 0xF2: case 0xF8: case 0xFF:
            return true;
        default:
            return false;
    }
}

int64_t read_pes_pts(const uint8_t* pkt) {
    if (!ts_pusi(pkt) || !ts_has_payload(pkt)) return -1;
    int off = payload_offset(pkt);
    if (off + 14 > PKT) return -1;
    const uint8_t* p = pkt + off;
    if (p[0] != 0x00 || p[1] != 0x00 || p[2] != 0x01) return -1;
    if (pes_no_header_id(p[3])) return -1;
    if ((p[6] & 0xC0) != 0x80) return -1;       // '10' marker of the optional header
    if (!(p[7] & 0x80)) return -1;              // PTS absent
    return ((int64_t)((p[9] >> 1) & 0x07) << 30) | ((int64_t)p[10] << 22) |
           ((int64_t)(p[11] >> 1) << 15) | ((int64_t)p[12] << 7) | (p[13] >> 1);
}

void null_packet(int cc, uint8_t out[PKT]) {
    out[0] = SYNC_BYTE;
    out[1] = (PID_NULL >> 8) & 0x1F;
    out[2] = PID_NULL & 0xFF;
    out[3] = 0x10 | (cc & 0x0F);
    std::memset(out + 4, 0xFF, PKT - 4);
}

bool build_pat(int ts_id, const std::vector<std::pair<int, int>>& programs,
               int cc, int version, uint8_t out[PKT]) {
    std::vector<uint8_t> body = {TABLE_PAT, 0x00, 0x00,
                                 (uint8_t)((ts_id >> 8) & 0xFF), (uint8_t)(ts_id & 0xFF),
                                 (uint8_t)(0xC1 | ((version & 0x1F) << 1)),
                                 0x00, 0x00};   // section/last_section_number
    for (const auto& [prog, pmt_pid] : programs) {
        body.push_back((prog >> 8) & 0xFF);
        body.push_back(prog & 0xFF);
        body.push_back(0xE0 | ((pmt_pid >> 8) & 0x1F));
        body.push_back(pmt_pid & 0xFF);
    }
    section_length_field((int)(body.size() - 3) + 4, &body[1], &body[2]);
    return wrap_section(PID_PAT, body.data(), (int)body.size(), cc, out);
}

bool build_pmt(int pmt_pid, int program_number, int pcr_pid,
               const std::vector<PmtStream>& streams, int cc, int version,
               uint8_t out[PKT]) {
    std::vector<uint8_t> body = pmt_body(program_number, pcr_pid, {}, streams, version);
    return wrap_section(pmt_pid, body.data(), (int)body.size(), cc, out);
}

std::vector<uint8_t> build_pmt_section(int program_number, int pcr_pid,
                                       const std::vector<uint8_t>& program_info,
                                       const std::vector<PmtStream>& streams,
                                       int version) {
    std::vector<uint8_t> sec = pmt_body(program_number, pcr_pid, program_info, streams,
                                        version);
    if (sec.size() + 4 > 1024) return {};       // section_length <= 1021
    uint32_t crc = crc32_mpeg(sec.data(), sec.size());
    for (int sh = 24; sh >= 0; sh -= 8) sec.push_back((uint8_t)(crc >> sh));
    return sec;
}

void packetise_section(int pid, const std::vector<uint8_t>& section, uint8_t& cc,
                       std::vector<uint8_t>& out) {
    for (size_t i = 0; i < section.size();) {
        const size_t at = out.size();
        out.resize(at + PKT, 0xFF);             // the last packet's tail stays stuffing
        uint8_t* p = out.data() + at;
        p[0] = SYNC_BYTE;
        p[1] = (i == 0 ? 0x40 : 0x00) | ((pid >> 8) & 0x1F);
        p[2] = pid & 0xFF;
        p[3] = 0x10 | (cc & 0x0F);              // payload only
        int k = 4;
        if (i == 0) p[k++] = 0x00;              // pointer_field: the section starts here
        size_t n = std::min(section.size() - i, (size_t)(PKT - k));
        std::memcpy(p + k, section.data() + i, n);
        i += n;
        cc = (cc + 1) & 0x0F;
    }
}

bool first_section(const std::deque<TsPacket>& packets, int pid,
                   std::vector<uint8_t>& section) {
    std::vector<uint8_t> buf;
    int want = -1;
    bool collecting = false;
    for (const auto& pp : packets) {
        const uint8_t* p = pp.b;
        if (ts_pid(p) != pid || !ts_has_payload(p)) continue;
        int off = payload_offset(p);
        if (off >= PKT) continue;
        const uint8_t* body = p + off;
        int blen = PKT - off;
        if (ts_pusi(p)) {
            int skip = 1 + body[0];             // pointer_field to section start
            // `want` deliberately NOT reset (python parity): a new section
            // start reuses a pending length from an interrupted predecessor.
            buf.assign(body + std::min(skip, blen), body + blen);
            collecting = true;
        } else if (collecting) {
            buf.insert(buf.end(), body, body + blen);
        }
        if (collecting && want < 0 && buf.size() >= 3)
            want = 3 + (((buf[1] & 0x0F) << 8) | buf[2]);
        if (collecting && want > 0 && (int)buf.size() >= want) {
            section.assign(buf.begin(), buf.begin() + want);
            return true;
        }
    }
    return false;
}

std::vector<std::pair<int, int>> parse_pat(const std::deque<TsPacket>& packets) {
    std::vector<std::pair<int, int>> out;
    std::vector<uint8_t> sec;
    if (!first_section(packets, PID_PAT, sec) || sec[0] != TABLE_PAT) return out;
    int section_length = ((sec[1] & 0x0F) << 8) | sec[2];
    int end = 3 + section_length - 4;           // exclude CRC
    for (int i = 8; i + 4 <= end && i + 4 <= (int)sec.size(); i += 4) {
        int prog = (sec[i] << 8) | sec[i + 1];
        int pid = ((sec[i + 2] & 0x1F) << 8) | sec[i + 3];
        if (prog != 0) out.push_back({prog, pid});
    }
    return out;
}

bool section_signature(const uint8_t* pkt, SectionSig* out) {
    const uint8_t* s = section_head(pkt);
    if (!s) return false;
    const int start = (int)(s - pkt);
    if (!(s[1] & 0x80)) return false;            // no section_syntax: no version/CRC
    if (!(s[5] & 0x01)) return false;            // current_next_indicator = 0
    if (s[6] != 0) return false;                 // only section 0 is ever parsed
    int section_length = ((s[1] & 0x0F) << 8) | s[2];
    if (section_length < 9) return false;        // 5 header bytes + 4 CRC minimum
    SectionSig sig;
    sig.table_id = s[0];
    sig.table_id_ext = (s[3] << 8) | s[4];
    sig.version = (s[5] >> 1) & 0x1F;
    int total = 3 + section_length;               // whole section, CRC included
    if (start + total <= PKT) {
        const uint8_t* c = s + total - 4;
        sig.crc = ((uint32_t)c[0] << 24) | ((uint32_t)c[1] << 16) |
                  ((uint32_t)c[2] << 8) | c[3];
        sig.has_crc = true;
    }
    *out = sig;
    return true;
}

std::optional<Pmt> parse_pmt(const std::deque<TsPacket>& packets, int pmt_pid) {
    std::vector<uint8_t> sec;
    if (!first_section(packets, pmt_pid, sec) || sec[0] != TABLE_PMT) return std::nullopt;
    if (sec.size() < 12) return std::nullopt;
    Pmt r;
    int section_length = ((sec[1] & 0x0F) << 8) | sec[2];
    int end = 3 + section_length - 4;
    r.program_number = (sec[3] << 8) | sec[4];
    r.version = (sec[5] >> 1) & 0x1F;
    r.pcr_pid = ((sec[8] & 0x1F) << 8) | sec[9];
    int program_info_length = ((sec[10] & 0x0F) << 8) | sec[11];
    // Stops at the CRC; es_info below may run into it (python parity).
    int pi_end = std::min(12 + program_info_length, end);
    if (pi_end > 12) r.program_info.assign(sec.begin() + 12, sec.begin() + pi_end);
    int i = 12 + program_info_length;
    while (i + 5 <= end && i + 5 <= (int)sec.size()) {
        PmtStream s;
        s.stream_type = sec[i];
        s.pid = ((sec[i + 1] & 0x1F) << 8) | sec[i + 2];
        int es_info_len = ((sec[i + 3] & 0x0F) << 8) | sec[i + 4];
        size_t es_end = std::min((size_t)(i + 5 + es_info_len), sec.size());
        s.es_info.assign(sec.begin() + i + 5, sec.begin() + es_end);
        r.streams.push_back(std::move(s));
        i += 5 + es_info_len;
    }
    return r;
}

uint32_t registration_format(const std::vector<uint8_t>& es_info) {
    uint32_t fmt = 0;
    for_each_descriptor(es_info.data(), (int)es_info.size(), [&](const Descriptor& d) {
        if (d.tag != 0x05) return true;
        if (d.len >= 4)
            fmt = ((uint32_t)d.data[0] << 24) | ((uint32_t)d.data[1] << 16) |
                  ((uint32_t)d.data[2] << 8) | d.data[3];
        return false;                           // the first one decides
    });
    return fmt;
}

bool has_descriptor(const std::vector<uint8_t>& es_info, uint8_t tag) {
    bool found = false;
    for_each_descriptor(es_info.data(), (int)es_info.size(), [&](const Descriptor& d) {
        found = d.tag == tag;
        return !found;
    });
    return found;
}

void PsiDiscovery::select_program(int program_number) {
    if (program_number < 0) program_number = -1;
    if (program_number == select_) return;
    select_ = program_number;
    // The PMT state is the old program's; with pmt_pid_ < 0 the next feed
    // re-reads the retained PAT for the new one.
    pmt_pid_ = -1;
    program_ = -1;
    pmt_pkts_.clear();
    pmt_sig_ = pmt_new_sig_ = SectionSig();
    pmt_resync_ = false;
    pmt_.reset();
}

bool PsiDiscovery::feed(const std::vector<TsPacket>& packets) {
    for (const auto& p : packets) {
        int pid = ts_pid(p.b);
        SectionSig sig;
        if (pid == PID_PAT) {
            if (section_signature(p.b, &sig) && sig.table_id == TABLE_PAT &&
                !(sig == pat_sig_)) {
                // Reassembly returns the OLDEST retained section, so a
                // superseded table stays visible until the buffer evicts it —
                // drop it and let this section be the one that is parsed.
                pat_pkts_.clear();
                pat_new_sig_ = sig;
                pat_resync_ = true;
            }
            if (later_section(p.b, TABLE_PAT, -1)) unsupported_++;
            pat_pkts_.push_back(p);
            if ((int)pat_pkts_.size() > max_) pat_pkts_.pop_front();
        } else if (pmt_pid_ >= 0 && pid == pmt_pid_) {
            // Only our own program's sections count: a PMT PID shared by two
            // programs would otherwise flap the discovered table on every
            // carousel repeat.
            if (section_signature(p.b, &sig) && sig.table_id == TABLE_PMT &&
                !(sig == pmt_sig_) && (program_ < 0 || sig.table_id_ext == program_)) {
                pmt_pkts_.clear();
                pmt_new_sig_ = sig;
                pmt_resync_ = true;
            }
            if (later_section(p.b, TABLE_PMT, program_)) unsupported_++;
            pmt_pkts_.push_back(p);
            if ((int)pmt_pkts_.size() > max_) pmt_pkts_.pop_front();
        }
    }
    n_++;
    if (pmt_pid_ < 0 || pat_resync_) {
        auto pat = parse_pat(pat_pkts_);
        if (select_ >= 0)
            pat.erase(std::remove_if(pat.begin(), pat.end(),
                                     [&](const std::pair<int, int>& e) {
                                         return e.first != select_;
                                     }),
                      pat.end());
        if (!pat.empty()) {
            if (pat_resync_) {
                pat_sig_ = pat_new_sig_;
                pat_resync_ = false;
            }
            if (pat.front().second != pmt_pid_) {
                // A new PAT may also move the program to a different PMT PID;
                // the buffered packets belong to the old one.
                pmt_pid_ = pat.front().second;
                pmt_pkts_.clear();
                pmt_sig_ = SectionSig();
                pmt_resync_ = false;
            }
            program_ = pat.front().first;
        }
    }
    bool changed = false;
    if (pmt_pid_ >= 0 && (!pmt_ || pmt_resync_ || n_ % 500 == 0)) {
        auto pmt = parse_pmt(pmt_pkts_, pmt_pid_);
        if (pmt && pmt_resync_) {
            pmt_sig_ = pmt_new_sig_;   // decided on it; do not re-trigger on it
            pmt_resync_ = false;
        }
        if (pmt && (!pmt_ || !(*pmt == *pmt_))) {
            changed = !pmt_ || !same_stream_map(*pmt, *pmt_);
            pmt_ = std::move(pmt);
            generation_++;
        }
    }
    return changed;
}

}  // namespace mrts
