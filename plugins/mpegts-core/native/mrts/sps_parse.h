// C++ port of sps_parse.py — H.264 / H.265 SPS field parsing (pure bitstream).
// Exp-Golomb-decodes just enough of an SPS RBSP to report resolution, frame
// rate and scan type. All parsers return nullopt on malformed input — wire
// bytes are never trusted. Callers MUST strip_ep() the RBSP first.
#pragma once
#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace mrts {

struct SpsInfo {
    const char* codec = "";        // "h264" | "h265"
    int width = 0;
    int height = 0;
    bool interlaced = false;
    std::optional<double> fps;     // coded FRAME rate (h264: time_scale/2N)
};

// Remove emulation-prevention bytes (00 00 03 -> 00 00). MANDATORY before
// reading SPS fields.
std::vector<uint8_t> strip_ep(const uint8_t* data, size_t n);

// rbsp = stripped SPS with the NAL header byte(s) removed (1 for h264, 2 for h265).
std::optional<SpsInfo> parse_h264_sps(const std::vector<uint8_t>& rbsp);
std::optional<SpsInfo> parse_h265_sps(const std::vector<uint8_t>& rbsp);

}  // namespace mrts
