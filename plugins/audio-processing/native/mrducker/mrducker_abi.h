/* The element protocol of libgstmrducker.so (plan ch. 6 WI-P2-10): the names, properties and
 * message of mrducker and mrptskeep. A runner refuses a plugin below its MRDUCKER_MIN_ABI, so
 * bump this with any change a runner or the engine relies on. Plain C, no includes. */
#pragma once

/* Overridable only for the stale test build (-DMRDUCKER_ABI=0, `make stub`). */
#ifndef MRDUCKER_ABI
#define MRDUCKER_ABI 1
#endif

/* The plugin's GstPluginDesc version, shown by gst-inspect and in the runners' load line. */
#define MRDUCKER_VERSION "1.0.0"
