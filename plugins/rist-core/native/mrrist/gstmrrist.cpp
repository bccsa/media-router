/* mrrist — RIST as native GStreamer elements: `mrristsink` (bus MPEG-TS →
 * librist sender) and `mrristsrc` (librist receiver → bus MPEG-TS).
 *
 * WHY: the RIST bridge was the last per-buffer python path in the runner
 * (docs/TodoNotes.md). Each 1316-byte packet cost an appsink round trip into
 * python, a copy, and a ctypes call into librist on the way out, and the
 * mirror image on the way in — ~0.2 ms/packet on a Pi 4, i.e. 20-30 % of a
 * core per direction at 12 Mbit/s on top of librist's own work. Same job in C:
 * one map, one rist_sender_data_write per 1316 bytes; one read loop, one
 * buffer per batch. librist itself (threads, recovery, encryption) is
 * unchanged, and the engine module still configures it through the same
 * knobs it used to hand the python binding (rist:// URLs with per-link
 * params, profile, buffer, secret/aes-type, npd, stats interval).
 *
 * STATS: librist's stats callback (its own thread) posts one
 * `mrrist-stats` element message per report with the JSON string librist
 * produced — the same document the CLI printed and the python binding
 * forwarded — so the module's parser is unchanged. Subscribe via
 * `PipelineDescription.busReports` ({element, structure: "mrrist-stats"}).
 *
 * LOGGING: librist lines at INFO and above are written to stderr as
 * `[librist] …` — exactly what the python binding did — so the runner's
 * stderr relay puts peer connect/authenticate, "Lost N packets" and
 * "Dropped N late packets" in the journal where operators have always read
 * them. They also go to this plugin's debug category (GST_DEBUG=mrrist:5),
 * and librist ERROR lines are additionally posted as non-fatal element
 * warnings so they reach the module.
 *
 * BATCH (src): librist's data-out thread releases packets in 5 ms batches;
 * `create` drains whatever is already released (zero-timeout reads, up to
 * `read-batch`) into ONE 188-aligned buffer. No added latency: it never waits
 * for more than the first packet.
 */
#include "mrrist_common.h"

/* GST_PLUGIN_DEFINE reads PACKAGE for GstPluginDesc.source. */
#define PACKAGE "media-router"
#define MRRIST_VERSION "1.0.0"

/* ------------------------------------------------------------------------- */

static gboolean plugin_init(GstPlugin *plugin) {
    GST_DEBUG_CATEGORY_INIT(mrrist_debug, "mrrist", 0, "Media Router RIST elements (librist)");
    /* Rank NONE: the runner loads this plugin explicitly and modules name the
     * elements — they must never be auto-plugged. */
    return gst_element_register(plugin, "mrristsink", GST_RANK_NONE, GST_TYPE_MRRISTSINK) &&
           gst_element_register(plugin, "mrristsrc", GST_RANK_NONE, GST_TYPE_MRRISTSRC);
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrrist,
                  "Media Router RIST sink/source on librist",
                  plugin_init, MRRIST_VERSION, "MIT/X11", "media-router",
                  "https://github.com/bccsa/media-router")

