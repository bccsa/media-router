// Raw-TS ingest for a non-GStreamer bus producer: listens on a unix socket,
// buffers the byte stream into 128×188-byte chunks (188-aligned like the UDP
// path), flushes a partial tail after 20 ms of silence, and DISCARDS any
// sub-packet remainder when a producer dies (splicing it before the next
// incarnation's aligned bytes would desync every buffer boundary).
// Parity: the ingest half of unixfd-fanout.py.
#pragma once
#include <poll.h>

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace mrbus {

class Ingest {
  public:
    using OnChunk = std::function<void(const uint8_t*, size_t)>;
    using Emit = std::function<void(const std::string& json_line)>;

    Ingest(std::string path, OnChunk on_chunk, Emit emit);
    ~Ingest();

    bool start();                 // bind + listen; false on error (emits it)
    void cleanup();               // close everything + unlink the socket path

    void prepare_poll(std::vector<pollfd>& fds) const;
    bool handle_poll(const pollfd& p);
    // Emit a 188-aligned partial tail after FLUSH_INTERVAL_MS of silence.
    void maybe_flush_partial(int64_t now_ns);

  private:
    void accept_conn();
    void read_conn();
    void close_conn();
    void flush_partial();

    std::string path_;
    OnChunk on_chunk_;
    Emit emit_;
    int listener_ = -1;
    int conn_ = -1;
    std::vector<uint8_t> pending_;
    int64_t last_ingest_ns_ = 0;
};

}  // namespace mrbus
