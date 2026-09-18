// Bus egress stamper lifecycle (time-sync contract, ADR-0005) — the native
// port of `gst_bus_stamper.py` + `gst_stamp_native.py` + `gst_stamp_events.py`,
// with ONE backend: the `mrtsstamp` element. The python probe fallback does
// not exist here; a box without the plugin runs the contract unstamped and
// says so loudly (warning event + log) instead of silently.
//
// Elements are spliced in once, before PLAYING, at the head of every
// `busout_*` egress and arrive inactive; `arm` (a tee's first consumer edge)
// sets `active`, `release` (its last edge gone) clears it. Every event and log
// line keeps the python runner's field names and wording so the engine and a
// burn-in reading the journal cannot tell which runner stamped.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <string>

namespace mr::stamper {

constexpr const char* ELEMENT_PREFIX = "mrstamp_";

/** Record the contract flag and splice the elements (contract on). `repair`
 *  is the payload's `latchRepair` (nullptr = keep the module default),
 *  `condition_step_ms` 0 = the element's default. */
void enable(GstElement* pipe, bool on, JsonNode* repair, gint64 condition_step_ms);

/** Arm the stamper on `tee_name`'s egress (idempotent; no-op off-contract). */
void arm(GstElement* tee, const std::string& tee_name);

/** Disarm `tee_name`'s stamper — its last consumer edge is gone. */
void release(const std::string& tee_name);

/** Disarm everything and forget the flag (pipeline stop). */
void clear();

/** The `mrtsstamp` spliced in front of `tee_name`, or nullptr. Borrowed. */
GstElement* element_for(const std::string& tee_name);

/** Bytes that passed a spliced element since it was inserted (armed or not). */
gint64 bytes_total(GstElement* el);

/** True for the element's bus message names (`mrtsstamp-*`). */
bool is_stamper_message(const char* structure_name);

/** Translate one element bus message into the engine event + log line the
 *  python probe emits for the same moment. */
void handle_message(const char* src_name, const char* kind, const GstStructure* s);

}  // namespace mr::stamper
