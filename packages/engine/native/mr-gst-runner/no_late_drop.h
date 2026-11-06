// The no-late-drop hook (WI-P4-5, B-170; house-clock P11): no element drops a buffer for being
// late, including those a bin plugs (a decodebin3 rung, an overlay bin). Always on. Twin:
// gst-pipeline-runner.py `_install_no_late_drop`.
#pragma once

#include <gst/gst.h>

#include <string>

namespace mr::no_late_drop {

/** Turn off what drops a late buffer on `el`: a GstBaseSink's `qos` and `max-lateness`, a
 *  decoder's or a GstBaseTransform's `qos`. What it changed ("vc qos→false"), or "". */
std::string apply(GstElement* el);

/** Before PLAYING: apply to every element of `pipe` (one log line), and to each one added later
 *  (one line each that changed). */
void install(GstElement* pipe);

}  // namespace mr::no_late_drop
