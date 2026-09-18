// C++ twin of `py/subtitle_klv.py` (itself the twin of engine/subtitleCue.ts):
// the KLV-wrapped WebVTT cue carrier, byte-identical on the wire. Header-only,
// no GStreamer — used by the native subtitle bridge.
//
//     HH:MM:SS.mmm --> HH:MM:SS.mmm\n
//     <text line>\n [...]
//
// Times are RELATIVE TO THE CARRYING PES, in ms (ADR-0016 as amended
// 2026-09-16). Empty text = CLEAR cue.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>

namespace subtitle_klv {

inline const std::string& key() {
    static const std::string k("\x06\x0e\x2b\x34\x02\x05\x01\x01\x0e\x0e\x4d\x52\x53\x55\x42\x31", 16);
    return k;
}
constexpr size_t MAX_VALUE_BYTES = 4096;

inline std::string format_vtt_time(double ms) {
    long long total = std::llround(ms);
    if (total < 0) total = 0;
    long long h = total / 3600000, rem = total % 3600000;
    long long m = rem / 60000;
    rem %= 60000;
    long long s = rem / 1000, f = rem % 1000;
    char buf[32];
    std::snprintf(buf, sizeof buf, "%02lld:%02lld:%02lld.%03lld", h, m, s, f);
    return buf;
}

/** `HH:MM:SS.mmm` → ms, or -1. Hours may have any number of digits >= 2. */
inline long long parse_vtt_time(const std::string& in) {
    size_t a = in.find_first_not_of(" \t"), b = in.find_last_not_of(" \t");
    if (a == std::string::npos) return -1;
    std::string t = in.substr(a, b - a + 1);
    size_t c1 = t.find(':');
    if (c1 == std::string::npos) return -1;
    size_t c2 = t.find(':', c1 + 1);
    if (c2 == std::string::npos || t.find(':', c2 + 1) != std::string::npos) return -1;
    std::string hh = t.substr(0, c1), mm = t.substr(c1 + 1, c2 - c1 - 1), rest = t.substr(c2 + 1);
    auto digits = [](const std::string& s) {
        if (s.empty()) return false;
        for (char ch : s) if (ch < '0' || ch > '9') return false;
        return true;
    };
    if (hh.size() < 2 || !digits(hh) || mm.size() != 2 || !digits(mm)) return -1;
    if (rest.size() != 6 || rest[2] != '.' || !digits(rest.substr(0, 2)) || !digits(rest.substr(3))) return -1;
    long long m = std::stoll(mm), s = std::stoll(rest.substr(0, 2));
    if (m > 59 || s > 59) return -1;
    return std::stoll(hh) * 3600000 + m * 60000 + s * 1000 + std::stoll(rest.substr(3));
}

inline std::string format_cue_block(double start_ms, double end_ms, const std::string& text) {
    std::string timing = format_vtt_time(start_ms) + " --> " + format_vtt_time(std::max(start_ms, end_ms)) + "\n";
    std::string body;
    for (size_t i = 0; i < text.size(); i++) {
        if (text[i] == '\r') {
            body += '\n';
            if (i + 1 < text.size() && text[i + 1] == '\n') i++;
        } else {
            body += text[i];
        }
    }
    while (!body.empty() && body.back() == '\n') body.pop_back();
    return body.empty() ? timing : timing + body + "\n";
}

struct Cue {
    long long start_ms = 0, end_ms = 0;
    std::string text;
};

/** → false when the block is not a cue. */
inline bool parse_cue_block(const std::string& block, Cue* out) {
    size_t nl = block.find('\n');
    std::string timing = nl == std::string::npos ? block : block.substr(0, nl);
    size_t arrow = timing.find("-->");
    if (arrow == std::string::npos) return false;
    long long start = parse_vtt_time(timing.substr(0, arrow)), end = parse_vtt_time(timing.substr(arrow + 3));
    if (start < 0 || end < 0 || end < start) return false;
    std::string text = nl == std::string::npos ? "" : block.substr(nl + 1);
    while (!text.empty() && text.back() == '\n') text.pop_back();
    out->start_ms = start;
    out->end_ms = end;
    out->text = text;
    return true;
}

inline std::string ber_length(size_t n) {
    if (n < 0x80) return std::string(1, (char)n);
    std::string out;
    while (n > 0) {
        out.insert(out.begin(), (char)(n & 0xFF));
        n >>= 8;
    }
    return std::string(1, (char)(0x80 | out.size())) + out;
}

/** KLV bytes for a cue, or "" when the block exceeds MAX_VALUE_BYTES. */
inline std::string encode_cue(double start_ms, double end_ms, const std::string& text) {
    std::string value = format_cue_block(start_ms, end_ms, text);
    if (value.size() > MAX_VALUE_BYTES) return "";
    return key() + ber_length(value.size()) + value;
}

inline bool is_subtitle_klv(const std::string& data) {
    return data.size() >= key().size() && data.compare(0, key().size(), key()) == 0;
}

/** KLV bytes → cue; false on anything that is not one. Never throws. */
inline bool decode_cue(const std::string& data, Cue* out) {
    if (!is_subtitle_klv(data)) return false;
    size_t i = key().size();
    if (i >= data.size()) return false;
    size_t length = (unsigned char)data[i++];
    if (length & 0x80) {
        size_t n = length & 0x7F;
        if (n == 0 || n > 4 || i + n > data.size()) return false;
        length = 0;
        for (size_t k = 0; k < n; k++) length = (length << 8) | (unsigned char)data[i + k];
        i += n;
    }
    if (length > MAX_VALUE_BYTES || i + length > data.size()) return false;
    return parse_cue_block(data.substr(i, length), out);
}

}  // namespace subtitle_klv
