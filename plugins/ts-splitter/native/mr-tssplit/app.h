// mr-tssplit application wiring: BusClient input → mrts SplitterCore → one
// FanoutServer per output PID, plus the stdin control plane (bus_attach /
// bus_detach / reinput) and runner-shaped stdout events. See main.cpp for
// the process shell (args, signals, poll loop).
#pragma once
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "libmrbus/bus_client.h"
#include "libmrbus/fanout_server.h"
#include "mrts/ts_split.h"
#include "mrts/ts_timeline.h"

namespace mrtssplit {

// False once stdout write fails (engine gone) — the main loop exits then.
bool stdout_alive();

struct Options {
    std::string input_socket;
    std::string caps;
    int ts_id = 1;
    int64_t stall_ns = 2'000'000'000;
    // Output broadcast coalescing window (--flush-ms). Bounds the latency the
    // fan-out adds; the BUFFER_BYTES size cap applies independently. 0 =
    // broadcast every splitter batch immediately (ultra-low-latency mode; the
    // per-buffer fd-pass/mmap cost returns — measured ~0.35 core across
    // producer+consumers at 1080p50).
    int64_t flush_ns = 20'000'000;
    // Time-sync contract (--stamp-timeline): stamp each output buffer with its
    // payload's mapped media time instead of send time. Off = byte-identical.
    bool stamp_timeline = false;
    // pid -> tee name (busout_<port>), from --out 0x100:busout_40001
    std::vector<std::pair<int, std::string>> outputs;
    std::vector<int> stream_types;   // parallel to outputs; -1 = unknown
};

class App {
  public:
    explicit App(Options opts);

    // Control verbs (from stdin JSON lines).
    void bus_attach(const std::string& tee, const std::string& socket_path);
    void bus_detach(const std::string& socket_path);
    void reinput(const std::string& socket_path);
    // Declare a PID discovered after startup, without a respawn: binds its
    // fan-out listener and adds the routing output (gated until an edge
    // attaches). Emits `output_added` / `output_add_failed`.
    void add_output(int pid, const std::string& tee);

    // Poll-loop integration.
    void prepare_poll(std::vector<pollfd>& fds) const;
    void handle_poll(const pollfd& p);
    // Periodic work: reconnects, pending-reinput resolution, stall
    // transitions, stats. Call every loop iteration.
    void tick(int64_t now_ns);

    void shutdown();   // detach all edges (unlinks sockets)

  private:
    struct Output {
        int pid;
        std::string tee;
        std::unique_ptr<mrbus::FanoutServer> server;
        long long batches = 0;
        // Broadcast coalescing (see on_input_buffer): splitter batches are
        // per-INPUT-buffer runs (~7 pkts / ~1.3 KB at typical interleave), and
        // FanoutServer::broadcast pays a memfd + fd-pass per call — with the
        // consumer paying mmap/munmap/close per buffer. Accumulate here and
        // flush at BUFFER_BYTES or opts.flush_ns, whichever first
        // (flush_ns 0 = no coalescing, see Options).
        std::vector<uint8_t> pending;
        int64_t pending_since_ns = 0;
    };

    void on_input_buffer(const uint8_t* data, size_t len);
    // Wire pts for one output buffer: -1 (send time) with the contract off,
    // else the payload's mapped media time.
    int64_t stamp_for(const Output& o, const uint8_t* data, size_t len);
    void flush_output(Output& o);
    void flush_due(int64_t now_ns);
    void refresh_gating();
    void emit_stats(int64_t now_ns);

    Options opts_;
    std::unique_ptr<mrts::SplitterCore> core_;
    // ONE stamper for every output (opts_.stamp_timeline only): the outputs
    // are separate wire streams but must share one anchor + epoch reference,
    // or each branch anchors on its own first buffer and the split re-rolls
    // lipsync — the 2026-07-19 incident this splitter exists to prevent. Each
    // output PID is its own `stream` key, so only the monotone floor is
    // per-branch. Re-latched here rather than forwarded from the input's wire
    // pts: an input buffer's pts is one number for a MUXED stream, so every
    // output would inherit the interleave's leading PID's time (and, with a
    // legacy upstream, its arrival jitter) instead of its own PES.
    std::unique_ptr<mrts::TimelineStamper> stamper_;

    std::vector<Output> outputs_;
    std::map<std::string, size_t> edge_owner_;   // edge socket -> outputs_ index
    std::unique_ptr<mrbus::BusClient> input_;
    // Pending make-before-break input swap.
    std::unique_ptr<mrbus::BusClient> pending_input_;
    int64_t pending_deadline_ns_ = 0;
    bool was_stalled_ = false;
    int64_t last_stats_ns_ = 0;
    long long last_stats_bytes_ = 0;
};

}  // namespace mrtssplit
