// The video-leg gates and watches — native ports of the runner's keyframe
// gate (`keyframeGate`), render keep-up watch (`renderWatch` + render_lag.py),
// report-only TS video-info probe (`tsProbe`, on mpegts-core's PsiDiscovery /
// VideoInfoProbe) and the mrrist plugin loader (`gst_rist_native.py`).
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <string>

namespace mr::gate_kf {
/** `cfg` = {"decoder": name} or nullptr. False on a hard error (element /
 *  pad missing) — the caller tears the pipeline down. Armed before PLAYING. */
bool start(GstElement* pipe, JsonObject* cfg);
/** Shut an open gate on `decoder` again ("this decoder was just reset"). */
void reclose(const std::string& decoder);
/** The gated decoder's sink pad (borrowed), or nullptr — the EOS drain's
 *  addressable decoder when the pipeline-level EOS cannot travel. */
GstPad* decoder_pad(std::string* name);
void stop();
}  // namespace mr::gate_kf

namespace mr::render {
bool start(GstElement* pipe, JsonObject* cfg);   // cfg = {"sink": name}
void stop();
}  // namespace mr::render

namespace mr::tsprobe {
bool start(GstElement* pipe, JsonObject* cfg);   // cfg = {"appsink": name}
void stop();
}  // namespace mr::tsprobe

namespace mr::rist {
/** Load `libgstmrrist.so` by path once per process (never GST_PLUGIN_PATH).
 *  True when `mrristsink`/`mrristsrc` are registered. */
bool load_plugin();
}  // namespace mr::rist
