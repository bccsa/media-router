// C++ port of ts_video_info.py — video parameter detection from an MPEG-TS
// elementary stream. Finds the H.264/H.265 SPS in a video PID's PES payload
// and reports resolution / frame rate / scan type ("1920×1080i50"). The SPS
// field decoding lives in sps_parse.{h,cpp}.
#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "sps_parse.h"

namespace mrts {

// Cap on bytes collected per PES payload start while hunting the SPS.
constexpr int MAX_COLLECT = 1024;

struct VideoInfo {
    const char* codec = "";        // "h264" | "h265"
    std::optional<int> width, height;
    std::optional<bool> interlaced;
    std::optional<double> fps;
    bool scrambled = false;
};

// Display string: 1920×1080i50 / 1280×720p59.94 / 1920×1080i (fps unknown).
// Interlaced shows the FIELD rate. Empty when width is unknown.
std::string format_video_info(const VideoInfo& info);

// Find and parse the SPS on one video PID. feed(pkt) returns an info value
// when video parameters are (re)established, else nullopt. Cheap steady
// state: early-out on every non-PUSI packet once no window is collecting;
// after the first parse, later SPS sightings byte-compare against the cached
// SPS and re-parse only on change.
class VideoInfoProbe {
  public:
    VideoInfoProbe(int pid, bool h265) : pid(pid), h265(h265) {}

    std::optional<VideoInfo> feed(const uint8_t* pkt);

    const int pid;
    const bool h265;

  private:
    std::optional<VideoInfo> scan_window();

    std::vector<uint8_t> buf_;     // collecting window (valid while collecting_)
    bool collecting_ = false;
    std::vector<uint8_t> sps_;     // last raw SPS bytes seen
    bool scrambled_reported_ = false;
};

}  // namespace mrts
