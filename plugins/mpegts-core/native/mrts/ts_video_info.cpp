#include "ts_video_info.h"

#include <cmath>
#include <cstdio>
#include <cstring>

#include "ts_psi.h"

namespace mrts {

std::string format_video_info(const VideoInfo& info) {
    if (!info.width) return "";
    const char* scan = (info.interlaced && *info.interlaced) ? "i" : "p";
    char rate[24] = "";
    if (info.fps && *info.fps) {
        double shown = (info.interlaced && *info.interlaced) ? *info.fps * 2 : *info.fps;
        if (std::fabs(shown - std::round(shown)) < 0.01)
            std::snprintf(rate, sizeof rate, "%.0f", shown);
        else
            std::snprintf(rate, sizeof rate, "%.2f", shown);
    }
    char out[64];
    // "×" (U+00D7) matches the python display string byte-for-byte.
    std::snprintf(out, sizeof out, "%d\xC3\x97%d%s%s",
                  *info.width, info.height ? *info.height : 0, scan, rate);
    return out;
}

std::optional<VideoInfo> VideoInfoProbe::feed(const uint8_t* pkt) {
    if (!collecting_ && !ts_pusi(pkt)) return std::nullopt;
    if (pkt[3] & 0xC0) {                        // TS-level scrambling
        if (scrambled_reported_) return std::nullopt;
        scrambled_reported_ = true;
        VideoInfo v;
        v.codec = h265 ? "h265" : "h264";
        v.scrambled = true;
        return v;
    }
    if (!ts_has_payload(pkt)) return std::nullopt;
    int off = payload_offset(pkt);
    if (off >= PKT) return std::nullopt;
    if (ts_pusi(pkt)) {
        // New PES payload unit: drop any unfinished window, skip the PES
        // header, start collecting.
        collecting_ = false;
        buf_.clear();
        const uint8_t* p = pkt + off;
        int n = PKT - off;
        if (n < 9 || p[0] != 0 || p[1] != 0 || p[2] != 1) return std::nullopt;
        if (!(0xE0 <= p[3] && p[3] <= 0xEF)) return std::nullopt;   // not video
        int skip = 9 + p[8];                    // 9-byte header + extension length
        if (skip >= n) return std::nullopt;     // header spans packets - wait
        buf_.assign(p + skip, p + n);
        collecting_ = true;
    } else {
        buf_.insert(buf_.end(), pkt + off, pkt + PKT);
    }
    if (buf_.size() < 16) return std::nullopt;
    auto info = scan_window();
    if (info || (int)buf_.size() >= MAX_COLLECT) {
        collecting_ = false;                    // done with this window either way
        buf_.clear();
    }
    return info;
}

std::optional<VideoInfo> VideoInfoProbe::scan_window() {
    const int want = h265 ? 33 : 7;
    const uint8_t* buf = buf_.data();
    int n = (int)buf_.size();
    int i = 0;
    while (i + 4 < n) {
        if (buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1) {
            int hdr = buf[i + 3];
            int typ = h265 ? (hdr >> 1) & 0x3F : hdr & 0x1F;
            if (typ == want) {
                int start = i + 3;
                int end = n;
                for (int j = start + 1; j + 3 <= n; j++) {   // next start code bounds
                    if (buf[j] == 0 && buf[j + 1] == 0 && buf[j + 2] <= 1) {
                        end = j;
                        break;
                    }
                }
                if ((int)sps_.size() == end - start &&
                    std::memcmp(sps_.data(), buf + start, end - start) == 0)
                    return std::nullopt;        // unchanged - nothing to report
                int hdr_len = h265 ? 2 : 1;
                if (end - start < hdr_len) return std::nullopt;   // too short to parse
                auto rbsp = strip_ep(buf + start + hdr_len, (size_t)(end - start - hdr_len));
                auto parsed = h265 ? parse_h265_sps(rbsp) : parse_h264_sps(rbsp);
                if (parsed) {
                    sps_.assign(buf + start, buf + end);
                    VideoInfo v;
                    v.codec = parsed->codec;
                    v.width = parsed->width;
                    v.height = parsed->height;
                    v.interlaced = parsed->interlaced;
                    v.fps = parsed->fps;
                    return v;
                }
                return std::nullopt;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    return std::nullopt;
}

}  // namespace mrts
