// GstUnixFd fan-out SERVER — the native replacement for a gst producer's
// `tee ! queue leaky=2 ! unixfdsink` branches and for unixfd-fanout.py.
//
// One instance serves N consumer EDGE sockets; each accepted client
// (a gst `unixfdsrc` or equivalent) gets CAPS first, then every broadcast
// buffer as one memfd passed via SCM_RIGHTS. Fan-out discipline (parity with
// the gst busedge branches): per-client bounded send queue with a 500 ms time
// budget, drop-oldest, non-blocking sockets — one stalled consumer can never
// block the caller or sibling clients. Drops are counted per edge.
//
// Loop-agnostic: the owner runs poll(2), calls prepare_poll()/handle_poll().
#pragma once
#include <poll.h>

#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace mrbus {

// Probe-then-unlink a pre-existing socket path (a crashed process leaves a
// path that refuses connections; a live listener means a zombie predecessor
// we take over — reported via `emit`).
void unlink_stale(const std::string& path, const char* label,
                  const std::function<void(const std::string&)>& emit);

class FanoutServer {
  public:
    using Emit = std::function<void(const std::string& json_line)>;

    FanoutServer(std::string caps, Emit emit);
    ~FanoutServer();

    // Bind a consumer edge listener. Emits `attached` (idempotent re-attach
    // included) or `error`. Parity: unixfd-fanout.py attach().
    void attach(const std::string& path);
    // Close an edge listener + its clients, unlink the socket, emit
    // `detached`. Unknown path is silently ignored (python parity).
    void detach(const std::string& path);
    void detach_all();

    // Send one buffer to every connected client (one memfd, dup'd per
    // client). No clients = drop and keep flowing (tee with no branches).
    //
    // `pts_ns` is the wire timestamp (absolute CLOCK_MONOTONIC — busproto.h).
    // Negative = stamp send-time `mono_ns()`, which is what a live source does
    // and stays the default, so a caller that passes nothing is byte-identical
    // to before the time-sync contract. Producers running the contract pass a
    // mapped media time instead (mrts::TimelineStamper).
    void broadcast(const uint8_t* data, size_t len, int64_t pts_ns = -1);

    size_t client_count() const { return clients_.size(); }
    size_t edge_count() const { return edges_.size(); }
    bool edge_has_client(const std::string& path) const;
    const std::map<std::string, long long>& drops() const { return drops_; }

    void prepare_poll(std::vector<pollfd>& fds) const;
    // Handle one poll result. Returns true when the fd belonged to us.
    bool handle_poll(const pollfd& p);

  private:
    struct Msg {
        std::vector<uint8_t> data;
        size_t off = 0;          // bytes already sent
        int fd = -1;             // memfd dup to pass; -1 for CAPS
        int64_t t_ns = 0;        // enqueue time (shed budget)
        bool started = false;    // partially sent — must complete, never shed
        bool sheddable = true;   // false for CAPS
    };
    struct Client {
        int sock;
        std::string edge;
        std::deque<Msg> q;
    };

    void accept_client(int listener_fd);
    // Drain client input (RELEASE_BUFFER etc. — unread data would eventually
    // block the client's send side). False = client is gone.
    bool drain_client(Client& c);
    // Flush the queue as far as the socket allows. False = client is dead.
    bool flush_client(Client& c);
    int shed_client(Client& c, int64_t now_ns);
    void drop_client(int sock);

    std::vector<uint8_t> caps_msg_;
    Emit emit_;
    std::map<std::string, int> edges_;      // path -> listener fd
    std::map<int, Client> clients_;         // sock -> client
    std::map<std::string, long long> drops_;
    uint64_t buffer_id_ = 0;
};

}  // namespace mrbus
