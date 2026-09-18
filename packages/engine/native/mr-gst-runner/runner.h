// mr-gst-runner — the pipeline runner's state and lifecycle.
//
// A native port of `gst-pipeline-runner.py` (ADR-0019): one GStreamer
// pipeline per process, driven by the engine over the same JSON protocol,
// emitting the same events. It covers, subsystem by subsystem:
//   parse/PLAYING/EOS-drain, the PLAYING watchdog, the non-live source gate
//   and the input stall watch (runner.cpp, source_gate.cpp); VU, bus-report
//   and plugin-event forwarding, live properties, element stats, throughput
//   (commands.cpp); per-consumer bus fan-out edges with the stall watchdog
//   (bus_edges.cpp); the time-sync contract's house clock and the native
//   `mrtsstamp` egress stamper (stamper.cpp); multi-branch stamp alignment
//   (branch_align.cpp); the backlog shedder (backlog_shed.cpp); pad-link
//   rules and stream discovery (pad_link.cpp); the keyframe gate, render
//   keep-up watch and TS video-info probe, and the mrrist plugin loader
//   (gates.cpp); runner hooks in their native form (hooks.cpp, ADR-0020).
// A start payload naming what it does NOT implement — the legacy python RIST
// drain (`rist`), `preserveSourceTimeline`, `readKlvNames`/`set_klv_payload`,
// `useStdioForData`, the legacy net `clock` without the contract, or a hook
// with no native form — is refused with an `error` event (`unsupported_field`
// in runner.cpp, mirrored by `nativeRunnerIneligibility` in the engine): the
// engine only selects this runner for descriptions inside that set, so the
// refusal is a loud misconfiguration signal, not a fallback.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <atomic>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace mr {

// Same numbers as the python runner — the engine's kill windows are derived
// from them (eosDrainContract.test.ts).
constexpr int VU_HEARTBEAT_MS = 1000;
constexpr int PLAYING_WATCHDOG_MS = 10000;
constexpr int EOS_DRAIN_TIMEOUT_MS = 6000;

struct ThroughputTracker {
    std::atomic<gint64> bytes{0};
    gint64 last_bytes = 0;
    gint64 last_time_us = 0;
    double bps = 0.0;
    /** A spliced `mrtsstamp` whose `bytes-total` replaces the pad probe. */
    GstElement* native = nullptr;
};

struct Runner {
    GstElement* pipeline = nullptr;
    GMainLoop* loop = nullptr;
    bool running = false;
    bool stopping = false;

    guint playing_watchdog_id = 0;
    int playing_timeout_ms = PLAYING_WATCHDOG_MS;

    /** `busReports`: (element, structure) pairs forwarded as plugin events. */
    std::set<std::pair<std::string, std::string>> bus_reports;

    std::vector<int> last_vu;
    gint64 last_vu_ms = 0;

    std::mutex throughput_lock;
    std::map<std::string, ThroughputTracker*> trackers;

    std::mutex stats_lock;
    std::set<std::string> stats_in_flight;

    int decoder_max_threads = 1;
    std::string decoder_thread_type = "auto";

    // --- lifecycle (runner.cpp) ---
    void handle_start(JsonObject* data);
    void handle_stop();
    /** The one fatal-lifecycle exit: report, tear down, leave the main loop.
     *  Takes ownership of `event`. */
    void fail_pipeline(JsonObject* event, bool drain = true, bool errored = false);
    void teardown_pipeline(GstElement* pipe, bool drain = true, bool errored = false);
    void arm_playing_watchdog(int timeout_ms);
    void cancel_playing_watchdog();
    /** Pipeline running time in ms (0 without a pipeline/clock). */
    double now_running_ms();
    void emit_plugin_event(const std::string& channel, JsonNode* payload);

    // --- commands (commands.cpp) ---
    void dispatch(JsonObject* data);
    void handle_set_property(JsonObject* data);
    void handle_get_property(JsonObject* data);
    void handle_get_stats(JsonObject* data);
    void handle_track_throughput(JsonObject* data);
    void handle_get_throughput(JsonObject* data);

    // internals (runner.cpp)
    bool eos_drain(GstElement* pipe, bool errored);
    bool drain_decoder_branch(gint64 deadline_us);
    void on_bus_message(GstMessage* msg);
    void handle_level_message(const GstStructure* s);
    void apply_contract_clock(GstElement* pipe, bool live_capture_clock);
    void install_decoder_thread_hook(GstElement* pipe);
    void set_decoder_threads(GstElement* el);
};

/** The one runner of this process. */
Runner& runner();

/** Factory name of an element ("" when it has none). */
std::string factory_name(GstElement* el);

}  // namespace mr
