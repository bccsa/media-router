#include "pcm_fade.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <type_traits>

namespace mrts {

namespace {

constexpr double PI = 3.14159265358979323846;

// A sample times a gain in [0, 1], rounded to nearest (ties to even) for the integer formats.
template <typename T>
T scaled(T v, double g) {
    if constexpr (std::is_floating_point_v<T>) {
        return (T)((double)v * g);
    } else {
        const long long r = std::llrint((double)v * g);
        return (T)std::clamp<long long>(r, std::numeric_limits<T>::min(),
                                        std::numeric_limits<T>::max());
    }
}

template <typename T>
void fade_out_t(const PcmTail& tail, T* out, size_t n) {
    const size_t ch = (size_t)tail.channels(), last = tail.frames() - 1;
    for (size_t k = 0; k < n; k++) {
        const T* in = reinterpret_cast<const T*>(tail.frame(last - k));
        const double g = fade_window(k, n);
        for (size_t c = 0; c < ch; c++) out[k * ch + c] = scaled(in[c], g);
    }
}

template <typename T>
size_t fade_in_t(int channels, T* data, size_t n, size_t offset, size_t left, size_t total) {
    const size_t ch = (size_t)channels;
    size_t k = offset;
    for (; k < n && left > 0; k++, left--) {
        const double g = 1.0 - fade_window(total - left, total);
        for (size_t c = 0; c < ch; c++) data[k * ch + c] = scaled(data[k * ch + c], g);
    }
    return left;
}

}  // namespace

size_t pcm_sample_bytes(PcmFormat f) {
    switch (f) {
        case PcmFormat::s16: return 2;
        case PcmFormat::s32:
        case PcmFormat::f32: return 4;
        default: return 8;
    }
}

double fade_window(size_t k, size_t n) {
    return 0.5 * (1.0 + std::cos(PI * (double)k / (double)n));
}

void PcmTail::configure(PcmFormat format, int channels, size_t cap_frames) {
    format_ = format;
    channels_ = channels;
    frame_bytes_ = pcm_sample_bytes(format) * (size_t)std::max(channels, 0);
    cap_ = cap_frames;
    size_ = 0;
    buf_.assign(cap_ * frame_bytes_, 0);
}

void PcmTail::push(const void* frames, size_t n) {
    if (!cap_ || !frame_bytes_ || !n) return;
    const uint8_t* src = static_cast<const uint8_t*>(frames);
    if (n >= cap_) {
        std::memcpy(buf_.data(), src + (n - cap_) * frame_bytes_, cap_ * frame_bytes_);
        size_ = cap_;
        return;
    }
    const size_t drop = size_ + n > cap_ ? size_ + n - cap_ : 0;
    if (drop) {
        std::memmove(buf_.data(), buf_.data() + drop * frame_bytes_, (size_ - drop) * frame_bytes_);
        size_ -= drop;
    }
    std::memcpy(buf_.data() + size_ * frame_bytes_, src, n * frame_bytes_);
    size_ += n;
}

void fade_out(const PcmTail& tail, void* out, size_t n) {
    n = std::min(n, tail.frames());
    if (!n) return;
    switch (tail.format()) {
        case PcmFormat::s16: fade_out_t(tail, static_cast<int16_t*>(out), n); break;
        case PcmFormat::s32: fade_out_t(tail, static_cast<int32_t*>(out), n); break;
        case PcmFormat::f32: fade_out_t(tail, static_cast<float*>(out), n); break;
        case PcmFormat::f64: fade_out_t(tail, static_cast<double*>(out), n); break;
    }
}

size_t fade_in(PcmFormat f, int channels, void* data, size_t n, size_t offset, size_t left,
               size_t total) {
    if (!total || left > total) return 0;
    switch (f) {
        case PcmFormat::s16:
            return fade_in_t(channels, static_cast<int16_t*>(data), n, offset, left, total);
        case PcmFormat::s32:
            return fade_in_t(channels, static_cast<int32_t*>(data), n, offset, left, total);
        case PcmFormat::f32:
            return fade_in_t(channels, static_cast<float*>(data), n, offset, left, total);
        default:
            return fade_in_t(channels, static_cast<double*>(data), n, offset, left, total);
    }
}

}  // namespace mrts
