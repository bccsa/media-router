/* The element protocol of libgstmrtshouse.so (plan ch. 3 part 4.5 rule 4). A runner refuses a
 * plugin whose ABI is below its own MRTSHOUSE_MIN_ABI, so bump this with any change a runner or
 * the engine relies on: element names, properties, messages, the gap marker. Plain C, no
 * includes, so anything can read it. */
#pragma once

/* Overridable only so WI-S0-8's tests can build a stale stub (-DMRTSHOUSE_ABI=0). */
#ifndef MRTSHOUSE_ABI
#define MRTSHOUSE_ABI 1
#endif

/* The plugin's GstPluginDesc version, shown by gst-inspect and in the runners' load line. */
#define MRTSHOUSE_VERSION "1.0.0"
