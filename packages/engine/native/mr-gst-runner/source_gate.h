// The two non-live heads and what the runner does about them (the native port
// of `gst_source_gate.py`, ADR-0010 rule 3), plus the input stall watch
// (`gst_input_stall_watch.py`).
//
// DATA WAIT — for a pipeline whose PLAYING request came back ASYNC and whose
// head is unixfdsrc/udpsrc, the PLAYING deadline starts when every such
// source has delivered its first buffer. A bus consumer reports
// `waiting_for_data` once after the watchdog period; its socket paths are
// polled so a producer that restarts under it fails out as
// `bus_producer_restarted` instead of waiting on a dead socket forever.
//
// UDP SILENCE — `GstUDPSrcTimeout` is a state (`input_silent` /
// `input_resumed`), never a rebuild, unless the producer declared
// `udpSilenceRestartMs` (multicast re-join).
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <string>

namespace mr::gate {

/** Called right after set_state(PLAYING). True when the PLAYING deadline is
 *  deferred to first data (the caller must NOT arm it now). */
bool start(GstElement* pipe, bool ret_async, int timeout_ms, gint64 udp_restart_ms);

/** Every teardown path: drop both watches. True when a `waiting_for_data`
 *  warning was standing. */
bool stop();

/** PLAYING state-change: the wait is over by definition. */
void on_playing();

/** One `GstUDPSrcTimeout` from `src_name`. */
void on_udp_timeout(const std::string& src_name);

}  // namespace mr::gate

namespace mr::stall {

/** `cfg` = [{"element": "busin_0", "timeoutMs": 5000}, …] (may be nullptr). */
void start(GstElement* pipe, JsonArray* cfg);

/** First PLAYING: start every entry's clock and the shared tick. */
void arm();

void stop();

}  // namespace mr::stall
