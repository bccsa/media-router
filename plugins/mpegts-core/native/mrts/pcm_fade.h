// The edges of a PCM aligner input (B-83): the last few ms of what went out, a fade-out that plays
// them back time-reversed under a half-Hann window, and the fade-in under its complement. Frames
// are interleaved, native-endian. No GStreamer, no GLib: mralignwatch is the GStreamer side.
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

namespace mrts {

// The sample formats an audio aggregator mixes.
enum class PcmFormat { s16, s32, f32, f64 };

size_t pcm_sample_bytes(PcmFormat f);

// w(k) = (1 + cos(pi k / n)) / 2 for frame k of n: 1 at k = 0, zero slope at both ends, 0 at n.
double fade_window(size_t k, size_t n);

// The last `cap` frames pushed, oldest first.
class PcmTail {
  public:
    // Empties it.
    void configure(PcmFormat format, int channels, size_t cap_frames);
    void push(const void* frames, size_t n);
    void reset() { size_ = 0; }
    size_t frames() const { return size_; }
    size_t cap() const { return cap_; }
    PcmFormat format() const { return format_; }
    int channels() const { return channels_; }
    size_t frame_bytes() const { return frame_bytes_; }
    // Frame i, 0 the oldest.
    const uint8_t* frame(size_t i) const { return buf_.data() + i * frame_bytes_; }

  private:
    PcmFormat format_ = PcmFormat::s16;
    int channels_ = 0;
    size_t frame_bytes_ = 0, cap_ = 0, size_ = 0;
    std::vector<uint8_t> buf_;
};

// `n` frames (1 <= n <= tail.frames()) to `out`: frame k is the tail's k-th from the last times
// fade_window(k, n), so it starts at the last sample and reaches 0 with the sound's own spectrum.
void fade_out(const PcmTail& tail, void* out, size_t n);

// The fade-in of `total` frames, `left` of them still to come, laid over frames from `offset` of
// `n` frames of `data` (frame j of the ramp times 1 - fade_window(j, total)). Returns what is left.
size_t fade_in(PcmFormat f, int channels, void* data, size_t n, size_t offset, size_t left,
               size_t total);

}  // namespace mrts
