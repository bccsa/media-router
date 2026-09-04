/* mrrist — shared librist context handling for mrristsink / mrristsrc.
 * See gstmrrist.cpp for the design notes. */
#pragma once
#include <gst/gst.h>
#include <librist/librist.h>

GST_DEBUG_CATEGORY_EXTERN(mrrist_debug);
#define GST_CAT_DEFAULT mrrist_debug

#define MRRIST_TS_CAPS "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
#define MRRIST_STATS_STRUCTURE "mrrist-stats"
#define MRRIST_DEFAULT_CHUNK 1316   /* 7 x 188: the classic TS-over-datagram unit */

struct MrRistCommon {
    /* properties */
    gchar *urls;              /* whitespace/comma separated rist:// URLs */
    gint profile;             /* enum rist_profile */
    gint buffer_ms;
    gint session_timeout_ms;
    gchar *secret;
    gint aes_type;
    gint stats_interval_ms;
    /* runtime */
    struct rist_ctx *ctx;
    struct rist_logging_settings logging;
};

/* Shared property ids (both elements install them with identical semantics). */
enum {
    PROP_0,
    PROP_URLS,
    PROP_PROFILE,
    PROP_BUFFER,
    PROP_SESSION_TIMEOUT,
    PROP_SECRET,
    PROP_AES_TYPE,
    PROP_STATS_INTERVAL,
    PROP_PACKETS,
    /* sink only */
    PROP_NPD,
    PROP_CHUNK,
    /* src only */
    PROP_FIFO_SIZE,
    PROP_READ_BATCH,
    PROP_READ_TIMEOUT,
};

void mrrist_common_init(MrRistCommon *c);
void mrrist_common_clear(MrRistCommon *c);
/* Create the context (sender or receiver), add every URL as a peer, arm the
 * stats callback. Does NOT call rist_start. FALSE => an element error was posted. */
gboolean mrrist_common_open(GstElement *el, MrRistCommon *c, gboolean sender);
void mrrist_common_close(MrRistCommon *c);
void mrrist_common_install_props(GObjectClass *k);
/* TRUE when the property id was one of the shared ones. */
gboolean mrrist_common_set_prop(MrRistCommon *c, guint id, const GValue *v);
gboolean mrrist_common_get_prop(const MrRistCommon *c, guint id, GValue *v);

GType gst_mrristsink_get_type(void);
GType gst_mrristsrc_get_type(void);
#define GST_TYPE_MRRISTSINK (gst_mrristsink_get_type())
#define GST_TYPE_MRRISTSRC (gst_mrristsrc_get_type())
