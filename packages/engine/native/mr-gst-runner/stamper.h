// Bus egress stamper lifecycle — the twin of `gst_bus_stamper.py` + `gst_stamp_native.py` +
// `gst_stamp_events.py`. One backend, the `mrtsstamp` element, stamping by identity
// (PES - 1 h, plan ch. 6 WI-P2-3); without its plugin the egress runs unstamped and the module
// carries the rule-6 alarm (`warning`, kind `timing_plugin`).
//
// Elements are spliced in once, before PLAYING, at the head of every `busout_*` egress and
// arrive inactive; `arm` (a tee's first consumer edge) sets `active`, `release` (its last edge
// gone) clears it. Log lines keep the python runner's wording, so the journal cannot tell
// which runner stamped.
#pragma once

#include <gst/gst.h>

#include <string>

namespace mr::stamper {

constexpr const char* ELEMENT_PREFIX = "mrstamp_";

/** Enable stamping for `pipe`: when it has a `busout_*` tee, load the plugin (once per process)
 *  and splice the elements. */
void enable(GstElement* pipe);

/** The plugin was tried and could not be loaded: a start reporting `timingPlugin` must not
 *  clear the alarm then. */
bool missing();

/** Arm the stamper on `tee_name`'s egress (idempotent; no-op before `enable`). */
void arm(GstElement* tee, const std::string& tee_name);

/** Disarm `tee_name`'s stamper — its last consumer edge is gone. */
void release(const std::string& tee_name);

/** Disarm everything and forget the pipeline (pipeline stop). */
void clear();

/** Bus-egress lateness taps are `lat_<tee>`, `lat_busout_<port>` (busHelpers.latOutName). */
constexpr const char* EGRESS_TAP_PREFIX = "lat_busout_";

/** Whether egress tap `tap`'s `mrlateness` window goes to the engine: only while its tee is
 *  armed, since an unarmed egress carries the mux's own PTS, and not the first window after each
 *  arm, which holds samples from before it (B-26). */
bool take_egress_window(const std::string& tap);

/** The `mrtsstamp` spliced in front of `tee_name`, or nullptr. Borrowed. */
GstElement* element_for(const std::string& tee_name);

/** Bytes that passed a spliced element since it was inserted (armed or not). */
gint64 bytes_total(GstElement* el);

/** True for the element's bus message names (`mrtsstamp-*`). */
bool is_stamper_message(const char* structure_name);

/** One element bus message as the python runner reports it: the identity log line, or the
 *  segment / map warning. */
void handle_message(const char* src_name, const char* kind, const GstStructure* s);

}  // namespace mr::stamper
