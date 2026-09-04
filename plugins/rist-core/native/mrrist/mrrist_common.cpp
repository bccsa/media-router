/* mrrist — shared librist context: URL/peer setup, log + stats callbacks,
 * common properties. Design notes live in gstmrrist.cpp. */
#include "mrrist_common.h"
#include <dlfcn.h>
#include <unistd.h>
#include <string>
#include <vector>
#include <cstring>

GST_DEBUG_CATEGORY(mrrist_debug);

/* ------------------------------------------------------------------------- */
/* Shared librist context handling                                            */
/* ------------------------------------------------------------------------- */


void mrrist_common_init(MrRistCommon *c) {
    memset(c, 0, sizeof(*c));
    c->profile = RIST_PROFILE_MAIN;
    c->buffer_ms = 1000;
    c->stats_interval_ms = 1000;
}

void mrrist_common_clear(MrRistCommon *c) {
    g_free(c->urls); c->urls = nullptr;
    g_free(c->secret); c->secret = nullptr;
}

static std::vector<std::string> mrrist_split_urls(const gchar *urls) {
    std::vector<std::string> out;
    if (!urls) return out;
    std::string cur;
    for (const gchar *p = urls; ; ++p) {
        if (*p == '\0' || *p == ' ' || *p == ',' || *p == '\n' || *p == '\t') {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
            if (*p == '\0') break;
        } else {
            cur.push_back(*p);
        }
    }
    return out;
}

/* Fold the element-level knobs into a rist:// URL as query params (urlparam.h),
 * the same way librist.py::augment_url did: params already present win. */
static std::string mrrist_augment_url(const std::string &url, const MrRistCommon *c) {
    std::string extra;
    /* Whole-param match: a bare substring test would let librist's
     * `reorder-buffer=` suppress `buffer=`. */
    auto has = [&](const char *key) {
        std::string k(key);
        return url.find("?" + k + "=") != std::string::npos || url.find("&" + k + "=") != std::string::npos;
    };
    auto add = [&](const std::string &kv) { extra += (extra.empty() ? "" : "&") + kv; };
    if (c->buffer_ms > 0 && !has("buffer")) add("buffer=" + std::to_string(c->buffer_ms));
    if (c->session_timeout_ms > 0 && !has("session-timeout"))
        add("session-timeout=" + std::to_string(c->session_timeout_ms));
    if (c->secret && *c->secret && !has("secret")) {
        add(std::string("secret=") + c->secret);
        if (c->aes_type > 0 && !has("aes-type")) add("aes-type=" + std::to_string(c->aes_type));
    }
    if (extra.empty()) return url;
    return url + (url.find('?') == std::string::npos ? "?" : "&") + extra;
}

static int mrrist_log_cb(void *arg, enum rist_log_level level, const char *msg) {
    GstElement *el = GST_ELEMENT(arg);
    if (!msg) return 0;
    std::string line(msg);
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (level <= RIST_LOG_INFO) {
        /* One write() per line, no buffering: the runner relays stderr line by
         * line. librist logs per EVENT (peer state, loss bursts), never per
         * packet, so this stays at journal rates. */
        std::string out = "[librist] " + line + "\n";
        (void)!write(STDERR_FILENO, out.data(), out.size());
    }
    switch (level) {
    case RIST_LOG_ERROR:
        GST_CAT_ERROR_OBJECT(mrrist_debug, el, "librist: %s", line.c_str());
        GST_ELEMENT_WARNING(el, RESOURCE, FAILED, ("librist: %s", line.c_str()), (nullptr));
        break;
    case RIST_LOG_WARN:
        GST_CAT_WARNING_OBJECT(mrrist_debug, el, "librist: %s", line.c_str());
        break;
    case RIST_LOG_NOTICE:
    case RIST_LOG_INFO:
        GST_CAT_INFO_OBJECT(mrrist_debug, el, "librist: %s", line.c_str());
        break;
    default:
        GST_CAT_DEBUG_OBJECT(mrrist_debug, el, "librist: %s", line.c_str());
        break;
    }
    return 0;
}

/* librist thread. Posting a bus message is thread-safe; the runner forwards
 * the structure verbatim on the `mrrist-stats:<element>` channel. */
static int mrrist_stats_cb(void *arg, const struct rist_stats *st) {
    GstElement *el = GST_ELEMENT(arg);
    if (st) {
        if (st->stats_json) {
            GstStructure *s = gst_structure_new(MRRIST_STATS_STRUCTURE,
                                                "json", G_TYPE_STRING, st->stats_json, nullptr);
            gst_element_post_message(el, gst_message_new_element(GST_OBJECT_CAST(el), s));
        }
        rist_stats_free(st);
    }
    return 0;
}

/* librist quirk (0.2.7 … 0.2.12): rist_stats_callback_set() stores the
 * interval only in the COMMON context, but the sender thread paces its stats
 * from struct rist_sender's own copy, which only the deprecated
 * rist_sender_stats_callback_set() writes. Left at 0 the sender reports on
 * EVERY loop iteration — i.e. per written packet, since a write wakes the
 * loop — building the cJSON report each time and posting a bus message the
 * runner forwards to the module (measured: 17 % of a Pi 4 core on the
 * runner's main thread alone, plus the librist thread's own cost). So a
 * sender also registers this no-op legacy callback purely to set the interval.
 * The legacy callback owns nothing (librist frees the string). Resolved with
 * dlsym: older headers (0.2.7) do not declare it although the library exports it. */
static int mrrist_noop_sender_stats_cb(void *, uint16_t, char *, uint32_t) { return 0; }
typedef int (*sender_stats_callback_set_fn)(struct rist_ctx *, int,
                                             int (*)(void *, uint16_t, char *, uint32_t), void *);

/* Create the context (sender or receiver), add every URL as a peer, arm the
 * stats callback. Does NOT call rist_start: callers apply their own knobs
 * (npd, wake-on-write, fifo size) first. FALSE => an element error was posted. */
gboolean mrrist_common_open(GstElement *el, MrRistCommon *c, gboolean sender) {
    c->logging.log_level = RIST_LOG_INFO;
    c->logging.log_cb = mrrist_log_cb;
    c->logging.log_cb_arg = el;
    c->logging.log_socket = -1;
    c->logging.log_stream = nullptr;

    std::vector<std::string> urls = mrrist_split_urls(c->urls);
    if (urls.empty()) {
        GST_ELEMENT_ERROR(el, RESOURCE, SETTINGS, ("no rist:// URLs configured"), (nullptr));
        return FALSE;
    }
    int rc = sender ? rist_sender_create(&c->ctx, (enum rist_profile)c->profile, 0, &c->logging)
                    : rist_receiver_create(&c->ctx, (enum rist_profile)c->profile, &c->logging);
    if (rc != 0 || !c->ctx) {
        c->ctx = nullptr;
        GST_ELEMENT_ERROR(el, RESOURCE, FAILED, ("rist_%s_create failed (%d)", sender ? "sender" : "receiver", rc), (nullptr));
        return FALSE;
    }
    for (const std::string &u : urls) {
        std::string full = mrrist_augment_url(u, c);
        struct rist_peer_config *cfg = nullptr;
        if (rist_parse_address2(full.c_str(), &cfg) < 0 || !cfg) {
            GST_ELEMENT_ERROR(el, RESOURCE, SETTINGS, ("rist_parse_address2 failed for %s", u.c_str()), (nullptr));
            return FALSE;
        }
        struct rist_peer *peer = nullptr;
        int prc = rist_peer_create(c->ctx, &peer, cfg);
        rist_peer_config_free2(&cfg);
        if (prc != 0) {
            GST_ELEMENT_ERROR(el, RESOURCE, OPEN_READ_WRITE, ("rist_peer_create failed for %s", u.c_str()), (nullptr));
            return FALSE;
        }
        GST_INFO_OBJECT(el, "peer added: %s", u.c_str());
    }
    if (c->stats_interval_ms > 0) {
        if (rist_stats_callback_set(c->ctx, c->stats_interval_ms, mrrist_stats_cb, el) != 0)
            GST_WARNING_OBJECT(el, "rist_stats_callback_set failed — no stats");
        if (sender) {
            auto fn = (sender_stats_callback_set_fn)dlsym(RTLD_DEFAULT, "rist_sender_stats_callback_set");
            if (fn) fn(c->ctx, c->stats_interval_ms, mrrist_noop_sender_stats_cb, nullptr);
            else GST_WARNING_OBJECT(el, "rist_sender_stats_callback_set missing — sender stats may flood");
        }
    }
    GST_INFO_OBJECT(el, "librist %s, %s, %u peer(s), profile %d", librist_version(),
                    sender ? "sender" : "receiver", (unsigned)urls.size(), c->profile);
    return TRUE;
}

void mrrist_common_close(MrRistCommon *c) {
    if (c->ctx) {
        /* Joins librist's threads: no log/stats callback fires afterwards. */
        rist_destroy(c->ctx);
        c->ctx = nullptr;
    }
}


void mrrist_common_install_props(GObjectClass *k) {
    auto rw = (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS);
    g_object_class_install_property(k, PROP_URLS, g_param_spec_string("urls", "URLs",
        "rist:// peer URLs, whitespace or comma separated (per-link params in the URL)", nullptr, rw));
    g_object_class_install_property(k, PROP_PROFILE, g_param_spec_int("profile", "Profile",
        "RIST profile: 0 simple, 1 main, 2 advanced", 0, 2, RIST_PROFILE_MAIN, rw));
    g_object_class_install_property(k, PROP_BUFFER, g_param_spec_int("buffer", "Buffer",
        "Recovery buffer in ms, folded into each URL as buffer=", 0, G_MAXINT, 1000, rw));
    g_object_class_install_property(k, PROP_SESSION_TIMEOUT, g_param_spec_int("session-timeout", "Session timeout",
        "Flow session timeout in ms (0 = librist default), folded in as session-timeout=", 0, G_MAXINT, 0, rw));
    g_object_class_install_property(k, PROP_SECRET, g_param_spec_string("secret", "Secret",
        "Pre-shared encryption passphrase (empty = no encryption)", nullptr, rw));
    g_object_class_install_property(k, PROP_AES_TYPE, g_param_spec_int("aes-type", "AES type",
        "AES key size for secret: 128 or 256 (0 = librist default)", 0, 256, 0, rw));
    g_object_class_install_property(k, PROP_STATS_INTERVAL, g_param_spec_int("stats-interval", "Stats interval",
        "librist stats interval in ms → `mrrist-stats` bus messages (0 disables)", 0, G_MAXINT, 1000, rw));
    g_object_class_install_property(k, PROP_PACKETS, g_param_spec_uint64("packets", "Packets",
        "RIST payloads written (sink) or read (src) since start", 0, G_MAXUINT64, 0,
        (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));
}

/* TRUE when the property was one of the shared ones. */
gboolean mrrist_common_set_prop(MrRistCommon *c, guint id, const GValue *v) {
    switch (id) {
    case PROP_URLS: g_free(c->urls); c->urls = g_value_dup_string(v); return TRUE;
    case PROP_PROFILE: c->profile = g_value_get_int(v); return TRUE;
    case PROP_BUFFER: c->buffer_ms = g_value_get_int(v); return TRUE;
    case PROP_SESSION_TIMEOUT: c->session_timeout_ms = g_value_get_int(v); return TRUE;
    case PROP_SECRET: g_free(c->secret); c->secret = g_value_dup_string(v); return TRUE;
    case PROP_AES_TYPE: c->aes_type = g_value_get_int(v); return TRUE;
    case PROP_STATS_INTERVAL: c->stats_interval_ms = g_value_get_int(v); return TRUE;
    default: return FALSE;
    }
}

gboolean mrrist_common_get_prop(const MrRistCommon *c, guint id, GValue *v) {
    switch (id) {
    case PROP_URLS: g_value_set_string(v, c->urls); return TRUE;
    case PROP_PROFILE: g_value_set_int(v, c->profile); return TRUE;
    case PROP_BUFFER: g_value_set_int(v, c->buffer_ms); return TRUE;
    case PROP_SESSION_TIMEOUT: g_value_set_int(v, c->session_timeout_ms); return TRUE;
    case PROP_SECRET: g_value_set_string(v, c->secret); return TRUE;
    case PROP_AES_TYPE: g_value_set_int(v, c->aes_type); return TRUE;
    case PROP_STATS_INTERVAL: g_value_set_int(v, c->stats_interval_ms); return TRUE;
    default: return FALSE;
    }
}
