// Port of ts_video_info_test.py — SPS probe + parser tests over synthetic TS.
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

#include "../ts_psi.h"
#include "../ts_video_info.h"
#include "check.h"

using namespace mrts;

namespace {

std::vector<uint8_t> from_hex(const char* hex) {
    std::vector<uint8_t> out;
    for (size_t i = 0; hex[i] && hex[i + 1]; i += 2) {
        auto nib = [](char c) {
            return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10;
        };
        out.push_back((uint8_t)((nib(hex[i]) << 4) | nib(hex[i + 1])));
    }
    return out;
}

// Real SPS captures with ffprobe ground truth (same fixtures as the python
// tests): h264 High 1920x1080 field_order=tt 25 fps; hevc Main 1920x1080p50.
const char* H264_1080I50_HEX =
    "67640028ad843fff9087fff210ffffffffffffffff087fffffffffffffff"
    "2cc501e0113f780a10101014000003000400000300ca50";
const char* H265_1080P50_HEX =
    "42010101600000030090000003000003007ba003c0801107cbb3e491b6af"
    "fc0004000404000003000400000300c820";

// Wrap an annex-B ES chunk in a minimal PES header and split it into 188-byte
// TS packets (PUSI on the first) — python pes_packets parity.
std::vector<TsPacket> pes_packets(int pid, const std::vector<uint8_t>& es,
                                  int cc0 = 0, bool scrambled = false) {
    std::vector<uint8_t> pes = {0, 0, 1, 0xE0, 0, 0, 0x80, 0x00, 0x00};
    pes.insert(pes.end(), es.begin(), es.end());
    std::vector<TsPacket> pkts;
    int cc = cc0;
    bool first = true;
    for (size_t off = 0; off < pes.size(); off += 184) {
        size_t n = std::min<size_t>(184, pes.size() - off);
        TsPacket t;
        std::memset(t.b, 0xFF, PKT);
        t.b[0] = SYNC_BYTE;
        t.b[1] = (first ? 0x40 : 0x00) | ((pid >> 8) & 0x1F);
        t.b[2] = pid & 0xFF;
        t.b[3] = 0x10 | (cc & 0x0F);
        if (scrambled) t.b[3] |= 0x80;
        std::memcpy(t.b + 4, pes.data() + off, n);
        first = false;
        cc = (cc + 1) & 0x0F;
        pkts.push_back(t);
    }
    return pkts;
}

std::vector<uint8_t> annexb(const std::vector<uint8_t>& sps,
                            const std::vector<uint8_t>& extra_nals,
                            int filler, uint8_t fill) {
    std::vector<uint8_t> es = {0, 0, 0, 1};
    es.insert(es.end(), sps.begin(), sps.end());
    es.insert(es.end(), extra_nals.begin(), extra_nals.end());
    es.insert(es.end(), (size_t)filler, fill);
    return es;
}

}  // namespace

int main() {
    auto h264_sps = from_hex(H264_1080I50_HEX);
    auto h265_sps = from_hex(H265_1080P50_HEX);

    // --- H.264 parse: geometry, interlace, fps, display ---
    auto info = parse_h264_sps(strip_ep(h264_sps.data() + 1, h264_sps.size() - 1));
    CHECK("h264 1080i50: geometry", info && info->width == 1920 && info->height == 1080);
    CHECK("h264 1080i50: interlaced", info && info->interlaced);
    CHECK("h264 1080i50: frame rate 25", info && info->fps && *info->fps == 25.0);
    VideoInfo vi{"h264", 1920, 1080, true, 25.0, false};
    CHECK("h264 1080i50: display shows field rate",
          format_video_info(vi) == "1920\xC3\x97"
                                   "1080i50");

    // --- H.265 parse ---
    auto info5 = parse_h265_sps(strip_ep(h265_sps.data() + 2, h265_sps.size() - 2));
    CHECK("h265 1080p50: geometry", info5 && info5->width == 1920 && info5->height == 1080);
    CHECK("h265 1080p50: progressive, fps 50",
          info5 && !info5->interlaced && info5->fps && *info5->fps == 50.0);

    // --- emulation-prevention stripping is load-bearing ---
    std::vector<uint8_t> raw_rbsp(h264_sps.begin() + 1, h264_sps.end());
    auto raw = parse_h264_sps(raw_rbsp);
    CHECK("h264 without strip_ep parses differently (locks the strip in)",
          !raw || !raw->fps || *raw->fps != 25.0);
    const uint8_t noep[] = {0x00, 0x01, 0x02, 0x03};
    CHECK("strip_ep is a no-op without EP sequences",
          strip_ep(noep, 4) == std::vector<uint8_t>({0x00, 0x01, 0x02, 0x03}));
    const uint8_t ep[] = {0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x00};
    CHECK("strip_ep removes 00 00 03",
          strip_ep(ep, 8) == std::vector<uint8_t>({0x00, 0x00, 0x01, 0x00, 0x00, 0x00}));

    // --- malformed input never crashes ---
    CHECK("truncated h264 SPS -> none",
          !parse_h264_sps({h264_sps.begin() + 1, h264_sps.begin() + 6}));
    CHECK("empty -> none", !parse_h264_sps({}) && !parse_h265_sps({}));
    CHECK("format of unknown width -> empty", format_video_info(VideoInfo{}).empty());
    CHECK("format without fps omits rate",
          format_video_info(VideoInfo{"h264", 1920, 1080, true, std::nullopt, false}) ==
              "1920\xC3\x97"
              "1080i");
    CHECK("format fractional rate",
          format_video_info(VideoInfo{"h264", 1280, 720, false, 59.94, false}) ==
              "1280\xC3\x97"
              "720p59.94");

    // --- VideoInfoProbe over synthetic TS packets ---
    const int VIDEO_PID = 0x100;
    auto es264 = annexb(h264_sps, {0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65}, 400, 0xaa);
    VideoInfoProbe probe(VIDEO_PID, false);
    int fired = 0;
    VideoInfo first_info;
    for (const auto& p : pes_packets(VIDEO_PID, es264))
        if (auto r = probe.feed(p.b)) {
            fired++;
            first_info = *r;
        }
    CHECK("probe finds SPS across split packets",
          fired == 1 && first_info.width == 1920 && first_info.interlaced &&
              *first_info.interlaced);

    // Same SPS again -> silent (byte-compare).
    int fired2 = 0;
    for (const auto& p : pes_packets(VIDEO_PID, es264))
        if (probe.feed(p.b)) fired2++;
    CHECK("probe silent on unchanged SPS", fired2 == 0);

    // Non-PUSI packets while idle -> early-out.
    VideoInfoProbe idle_probe(VIDEO_PID, false);
    auto all = pes_packets(VIDEO_PID, es264);
    int idle_fired = 0;
    for (size_t i = 1; i < all.size(); i++)
        if (!ts_pusi(all[i].b) && idle_probe.feed(all[i].b)) idle_fired++;
    CHECK("probe ignores mid-PES packets while idle", idle_fired == 0);

    // A DIFFERENT SPS -> re-fires (mid-stream format change).
    auto modified = h264_sps;
    modified[4] ^= 0x01;
    auto es_mod = annexb(modified, {0, 0, 1, 0x65}, 100, 0xaa);
    int fired3 = 0;
    for (const auto& p : pes_packets(VIDEO_PID, es_mod))
        if (probe.feed(p.b)) fired3++;
    CHECK("probe re-fires on changed SPS", fired3 > 0);

    // Scrambled TS bits -> one scrambled report, then silence.
    VideoInfoProbe sp(VIDEO_PID, false);
    auto spkts = pes_packets(VIDEO_PID, es264, 0, true);
    int scrambled_fired = 0;
    bool scrambled_flag = false;
    for (int round = 0; round < 2; round++)
        for (const auto& p : spkts)
            if (auto r = sp.feed(p.b)) {
                scrambled_fired++;
                scrambled_flag = r->scrambled;
            }
    CHECK("scrambled reported once", scrambled_fired == 1 && scrambled_flag);

    // h265 probe end-to-end.
    auto es265 = annexb(h265_sps, {0, 0, 1, 0x26, 0x01}, 300, 0xbb);
    VideoInfoProbe p5(VIDEO_PID, true);
    int fired5 = 0;
    VideoInfo v5;
    for (const auto& p : pes_packets(VIDEO_PID, es265))
        if (auto r = p5.feed(p.b)) {
            fired5++;
            v5 = *r;
        }
    CHECK("h265 probe end-to-end",
          fired5 == 1 && v5.width == 1920 && v5.fps && *v5.fps == 50.0);

    return test_summary("ts_video_info");
}
