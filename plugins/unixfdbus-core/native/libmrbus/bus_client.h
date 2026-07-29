// GstUnixFd bus CLIENT — the consumer side of a producer edge socket
// (the native equivalent of gst `unixfdsrc`, which it can replace because
// the wire protocol is symmetric: CAPS first, then NEW_BUFFER messages whose
// memfd rides SCM_RIGHTS on the header's first byte).
//
// Contract differences from unixfdsrc, on purpose:
//  - Owns its own indefinite connect retry (unixfdsrc has none — the engine
//    gates pipeline starts via busSocketGate; a native consumer subsumes it).
//  - ALWAYS sends RELEASE_BUFFER promptly after copying a buffer out — the
//    stock gst unixfdsink tracks outstanding buffers, so releases are
//    correctness, not courtesy.
//  - Surfaces silence (no buffer for a configurable window) as a stall flag;
//    the owner maps transitions to input_stalled / input_resumed events.
//
// Loop-agnostic: the owner runs poll(2), calls prepare_poll()/handle_poll(),
// and ticks maybe_reconnect()/stalled().
#pragma once
#include <poll.h>

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace mrbus {

class BusClient {
  public:
    using OnBuffer = std::function<void(const uint8_t* data, size_t len)>;

    BusClient(std::string path, OnBuffer on_buffer, int64_t stall_ns);
    ~BusClient();

    // Re-point at a new edge socket (make-before-break is the OWNER's job:
    // construct a second BusClient, wait for connected(), then swap).
    const std::string& path() const { return path_; }

    bool connected() const { return sock_ >= 0; }
    // True while no buffer has arrived for the stall window (also while
    // disconnected — a dead producer is silent too). Meaningless before the
    // first-ever buffer unless the connection is up.
    bool stalled(int64_t now_ns) const;
    int64_t last_buffer_ns() const { return last_buffer_ns_; }
    long long buffers_received() const { return buffers_; }
    long long bytes_received() const { return bytes_; }

    // Attempt/retry the connection (cheap no-op while connected or before
    // the retry backoff elapses).
    void maybe_reconnect(int64_t now_ns);

    void prepare_poll(std::vector<pollfd>& fds) const;
    bool handle_poll(const pollfd& p);

  private:
    void disconnect();
    bool read_input();               // false = connection lost
    bool dispatch_message();
    void queue_release(uint64_t id);
    bool flush_out();                // false = connection lost

    std::string path_;
    OnBuffer on_buffer_;
    int64_t stall_ns_;
    int sock_ = -1;
    int64_t next_connect_ns_ = 0;
    int64_t last_buffer_ns_ = 0;
    long long buffers_ = 0;
    long long bytes_ = 0;

    // Receive state machine: header (8 bytes, fds ride here) then payload.
    std::vector<uint8_t> in_;        // accumulated header+payload bytes
    size_t need_ = 8;                // total bytes wanted before dispatch
    bool have_header_ = false;
    std::vector<int> fds_;           // SCM_RIGHTS collected while reading
    std::vector<uint8_t> payload_buf_;   // pread target (reused)
    std::vector<uint8_t> out_;       // pending RELEASE_BUFFER bytes
};

}  // namespace mrbus
