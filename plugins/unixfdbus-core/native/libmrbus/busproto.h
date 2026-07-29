// GstUnixFd wire protocol constants and payload layouts.
//
// This is the protocol spoken by GStreamer's unixfdsink/unixfdsrc
// (gst-plugins-bad gst/unixfd/gstunixfd.[ch]) — layouts are ABI-frozen
// upstream. The repo's executable reference is
// packages/engine/src/child-process/unixfd-fanout.py; the conformance suite
// (unixfdFanout.test.ts) runs this implementation and the python one against
// the same clients.
//
// Transport: AF_UNIX SOCK_STREAM. Every message: 8-byte Header (native LE).
// NEW_BUFFER's memfd rides SCM_RIGHTS on the sendmsg that carries the
// header's first byte; the payload bytes follow on the stream.
#pragma once
#include <cstdint>

namespace mrbus {

static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__,
              "GstUnixFd wire layouts are little-endian");

enum : uint32_t {
    CMD_NEW_BUFFER = 0,
    CMD_RELEASE_BUFFER = 1,
    CMD_CAPS = 2,
};

#pragma pack(push, 1)
struct Header {
    uint32_t type;
    uint32_t size;   // payload bytes following the header
};
struct NewBufferPayload {
    uint64_t id;
    uint64_t pts;              // absolute CLOCK_MONOTONIC ns
    uint64_t dts, duration, offset, offset_end;   // CLOCK_TIME_NONE here
    uint32_t flags;
    uint8_t memory_type;       // MEMORY_TYPE_DEFAULT
    uint8_t n_memory;
    uint16_t n_meta;
};
struct MemoryPayload {
    uint64_t size;
    uint64_t offset;
};
#pragma pack(pop)
static_assert(sizeof(Header) == 8, "wire ABI");
static_assert(sizeof(NewBufferPayload) == 56, "wire ABI");
static_assert(sizeof(MemoryPayload) == 16, "wire ABI");

constexpr uint64_t CLOCK_TIME_NONE = 0xFFFFFFFFFFFFFFFFull;
constexpr uint8_t MEMORY_TYPE_DEFAULT = 0;

// Fan-out discipline (parity with unixfd-fanout.py / the gst busedge
// branches' `queue leaky=2 max-size-time=500ms`):
constexpr int TS_PKT = 188;
constexpr int BUFFER_BYTES = 128 * TS_PKT;              // ingest chunking
constexpr int64_t QUEUE_BUDGET_NS = 500'000'000;        // per-client send budget
constexpr int FLUSH_INTERVAL_MS = 20;                   // partial-buffer flush
constexpr int64_t STATS_INTERVAL_NS = 2'000'000'000;

}  // namespace mrbus
