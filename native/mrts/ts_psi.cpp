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

}  // namespace

uint32_t crc32_mpeg(const uint8_t* data, size_t n) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++)
        crc = (crc << 8) ^ kCrc.t[((crc >> 24) ^ data[i]) & 0xFF];
    return crc;
}

int64_t read_pcr(const uint8_t* pkt) {
    if (!(pkt[3] & 0x20)) return -1;            // no adaptation field
    int af_len = pkt[4];
    if (af_len < 7 || !(pkt[5] & 0x10)) return -1;   // need flags + 6 PCR bytes
    int64_t base = ((int64_t)pkt[6] << 25) | ((int64_t)pkt[7] << 17) |
                   ((int64_t)pkt[8] << 9) | ((int64_t)pkt[9] << 1) | (pkt[10] >> 7);
    int64_t ext = ((pkt[10] & 0x01) << 8) | pkt[11];
    return base * 300 + ext;
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

void build_pcr_packet(int pid, int64_t pcr27, int cc, uint8_t out[PKT]) {
    int64_t base = (pcr27 / 300) & 0x1FFFFFFFFLL;   // 33-bit 90 kHz base
    int ext = (int)(pcr27 % 300);                   // 9-bit 27 MHz remainder
    std::memset(out, 0xFF, PKT);
    out[0] = SYNC_BYTE;
    out[1] = (pid >> 8) & 0x1F;                     // no PUSI
    out[2] = pid & 0xFF;
    out[3] = 0x20 | (cc & 0x0F);                    // adaptation only, no payload
    out[4] = 183;                                   // fills the packet
    out[5] = 0x10;                                  // PCR_flag
    out[6] = (base >> 25) & 0xFF;
    out[7] = (base >> 17) & 0xFF;
    out[8] = (base >> 9) & 0xFF;
    out[9] = (base >> 1) & 0xFF;
    out[10] = ((base & 0x01) << 7) | 0x7E | ((ext >> 8) & 0x01);
    out[11] = ext & 0xFF;
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
    std::vector<uint8_t> body = {TABLE_PMT, 0x00, 0x00,
                                 (uint8_t)((program_number >> 8) & 0xFF),
                                 (uint8_t)(program_number & 0xFF),
                                 (uint8_t)(0xC1 | ((version & 0x1F) << 1)),
                                 0x00, 0x00,
                                 (uint8_t)(0xE0 | ((pcr_pid >> 8) & 0x1F)),
                                 (uint8_t)(pcr_pid & 0xFF),
                                 0xF0, 0x00};   // program_info_length = 0
    for (const auto& s : streams) {
        body.push_back(s.stream_type & 0xFF);
        body.push_back(0xE0 | ((s.pid >> 8) & 0x1F));
        body.push_back(s.pid & 0xFF);
        body.push_back(0xF0 | ((s.es_info.size() >> 8) & 0x0F));
        body.push_back(s.es_info.size() & 0xFF);
        body.insert(body.end(), s.es_info.begin(), s.es_info.end());
    }
    section_length_field((int)(body.size() - 3) + 4, &body[1], &body[2]);
    return wrap_section(pmt_pid, body.data(), (int)body.size(), cc, out);
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

std::optional<Pmt> parse_pmt(const std::deque<TsPacket>& packets, int pmt_pid) {
    std::vector<uint8_t> sec;
    if (!first_section(packets, pmt_pid, sec) || sec[0] != TABLE_PMT) return std::nullopt;
    if (sec.size() < 12) return std::nullopt;
    Pmt r;
    int section_length = ((sec[1] & 0x0F) << 8) | sec[2];
    int end = 3 + section_length - 4;
    r.program_number = (sec[3] << 8) | sec[4];
    r.pcr_pid = ((sec[8] & 0x1F) << 8) | sec[9];
    int program_info_length = ((sec[10] & 0x0F) << 8) | sec[11];
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

bool PsiDiscovery::feed(const std::vector<TsPacket>& packets) {
    for (const auto& p : packets) {
        int pid = ts_pid(p.b);
        if (pid == PID_PAT) {
            pat_pkts_.push_back(p);
            if ((int)pat_pkts_.size() > max_) pat_pkts_.pop_front();
        } else if (pmt_pid_ >= 0 && pid == pmt_pid_) {
            pmt_pkts_.push_back(p);
            if ((int)pmt_pkts_.size() > max_) pmt_pkts_.pop_front();
        }
    }
    n_++;
    if (pmt_pid_ < 0) {
        auto pat = parse_pat(pat_pkts_);
        if (!pat.empty()) pmt_pid_ = pat.front().second;
    }
    bool changed = false;
    if (pmt_pid_ >= 0 && (!pmt_ || n_ % 500 == 0)) {
        auto pmt = parse_pmt(pmt_pkts_, pmt_pid_);
        if (pmt && (!pmt_ || !(*pmt == *pmt_))) {
            pmt_ = std::move(pmt);
            changed = true;
        }
    }
    return changed;
}

}  // namespace mrts
