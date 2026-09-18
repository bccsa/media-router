#include "pad_link.h"

#include <cstdarg>
#include <cstdio>
#include <map>
#include <memory>
#include <set>
#include <vector>

#include "ipc.h"
#include "json_util.h"
#include "runner.h"

namespace mr::padlink {

namespace {

// Caps-name → parser between `tsdemux` and a downstream muxer/decoder.
// config-interval=-1 re-emits parameter sets before every IDR (see the python).
const std::map<std::string, std::string> PARSER_FOR_CAPS_NAME = {
    {"video/x-h264", "h264parse config-interval=-1"},
    {"video/x-h265", "h265parse config-interval=-1"},
    {"video/x-av1", "av1parse"},
    {"audio/x-ac3", "ac3parse"},
    {"audio/x-eac3", "ac3parse"},
    {"audio/x-opus", ""},   // tsdemux already emits muxer-ready caps
};
const std::map<std::string, std::string> AU_ALIGNED_CAPS = {
    {"video/x-h264", "video/x-h264,stream-format=byte-stream,alignment=au"},
    {"video/x-h265", "video/x-h265,stream-format=byte-stream,alignment=au"},
};

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, f);
    std::vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

void emit_msg(const char* event, const std::string& message) {
    JsonObject* ev = ipc::event(event);
    json_object_set_string_member(ev, "message", message.c_str());
    ipc::emit(ev);
}

struct Rule {
    GstElement* pipe = nullptr;
    GstElement* src = nullptr;       // owned ref
    gulong handler = 0;
    std::string from, media, link_to, rule_id, parser_mode;
    std::vector<std::string> branches;
    std::vector<std::string> requested_pad_names;
    std::vector<int> match_pids;
    bool has_offset = false;
    gint64 pad_offset_ns = 0;
    int count = 0;
};

struct Discovery {
    std::string source_name;
    GstElement* el = nullptr;        // owned ref
    gulong handler = 0;
};

std::vector<std::shared_ptr<Rule>> g_rules;
std::vector<std::shared_ptr<Discovery>> g_discovery;
std::set<std::string> g_unknown_codec_warned;

GstCaps* pad_caps(GstPad* pad) {
    GstCaps* caps = gst_pad_get_current_caps(pad);
    if (!caps) caps = gst_pad_query_caps(pad, nullptr);
    return caps;
}

std::string caps_name_of(GstCaps* caps) {
    if (!caps || gst_caps_get_size(caps) == 0) return "";
    const gchar* n = gst_structure_get_name(gst_caps_get_structure(caps, 0));
    return n ? n : "";
}

/** 'video' / 'audio' / "" for a pad based on its current caps. */
std::string pad_caps_media(GstPad* pad) {
    GstCaps* caps = pad_caps(pad);
    std::string name = caps_name_of(caps);
    if (caps) gst_caps_unref(caps);
    if (name.rfind("video/", 0) == 0) return "video";
    if (name.rfind("audio/", 0) == 0) return "audio";
    return "";
}

std::string stream_media_from_caps_name(const std::string& n) {
    if (n.rfind("video/", 0) == 0) return "video";
    if (n.rfind("audio/", 0) == 0) return "audio";
    if (n == "meta/x-klv") return "metadata";
    if (n.rfind("subpicture/", 0) == 0 || n == "application/x-teletext") return "subtitle";
    return "data";
}

int pid_from_pad_name(const gchar* name) {
    if (!name) return -1;
    std::string s = name;
    size_t us = s.rfind('_');
    std::string tail = us == std::string::npos ? s : s.substr(us + 1);
    if (tail.empty()) return -1;
    char* end = nullptr;
    long v = std::strtol(tail.c_str(), &end, 16);
    return (end && *end == 0) ? (int)v : -1;
}

/** `'aacparse ! '` / "" for a pad, warning once per unknown codec. `"none"`
 *  replaces a VIDEO parser with an `alignment=au` capssetter. */
std::string parser_prefix_for_pad(GstPad* pad, const std::string& rule_id, const std::string& mode) {
    GstCaps* caps = pad_caps(pad);
    std::string caps_name = caps_name_of(caps);
    if (mode == "none") {
        auto it = AU_ALIGNED_CAPS.find(caps_name);
        if (it != AU_ALIGNED_CAPS.end()) {
            if (caps) gst_caps_unref(caps);
            emit_msg("warning", fmt("linkOnPadAdded: parser bypass on %s (%s) — declaring %s", GST_PAD_NAME(pad),
                                    rule_id.c_str(), it->second.c_str()));
            return "capssetter caps=\"" + it->second + "\" ! ";
        }
    }
    std::string parser;
    bool known = parser_for_caps(caps, &parser);
    if (caps) gst_caps_unref(caps);
    if (!known) {
        std::string key = rule_id + "::" + (caps_name.empty() ? "unknown" : caps_name);
        if (g_unknown_codec_warned.insert(key).second)
            emit_msg("warning", fmt("linkOnPadAdded: no parser registered for caps '%s' on rule %s — linking "
                                    "passthrough; mpegtsmux may refuse if codec needs framing",
                                    caps_name.empty() ? "unknown" : caps_name.c_str(), rule_id.c_str()));
        return "";
    }
    return parser.empty() ? "" : parser + " ! ";
}

std::string rule_path(const std::string& rule_id) {
    std::string p = rule_id;
    for (size_t at = p.find("::"); at != std::string::npos; at = p.find("::")) p.replace(at, 2, "_");
    return p;
}

void emit_pad_linked(const Rule& r, GstPad* pad, int index) {
    JsonObject* ev = ipc::event("pad_linked");
    json_object_set_string_member(ev, "rule", r.rule_id.c_str());
    json_object_set_int_member(ev, "index", index);
    json_object_set_string_member(ev, "padName", GST_PAD_NAME(pad));
    if (r.has_offset && r.pad_offset_ns && !r.link_to.empty()) json_object_set_int_member(ev, "padOffsetNs", r.pad_offset_ns);
    ipc::emit(ev);
}

/** Fan one demux pad out to several branches through a `tee` (a PID listed
 *  more than once in `matchPids`). `linkTo` is unsupported on this path. */
void link_via_tee(Rule& r, GstPad* pad, const std::vector<int>& indices) {
    if (!r.link_to.empty()) {
        emit_msg("error", "linkOnPadAdded: duplicate-PID fan-out with linkTo is unsupported (" + r.rule_id + ")");
        return;
    }
    std::string prefix = parser_prefix_for_pad(pad, r.rule_id, r.parser_mode);
    if (prefix.size() >= 3) prefix.erase(prefix.size() - 3);   // " ! "
    GError* err = nullptr;
    GstElement* head = nullptr;
    if (!prefix.empty()) {
        head = gst_parse_bin_from_description(prefix.c_str(), TRUE, &err);
        if (!head || err) {
            emit_msg("error", std::string("linkOnPadAdded: tee fan-out parse failed: ") + (err && err->message ? err->message : "?"));
            g_clear_error(&err);
            if (head) gst_object_unref(head);
            return;
        }
    }
    GstElement* tee = gst_element_factory_make("tee", nullptr);
    gst_bin_add(GST_BIN(r.pipe), tee);
    gst_element_sync_state_with_parent(tee);
    GstPad* tee_sink = gst_element_get_static_pad(tee, "sink");
    bool ok;
    if (head) {
        gst_bin_add(GST_BIN(r.pipe), head);
        gst_element_sync_state_with_parent(head);
        GstPad* hs = gst_element_get_static_pad(head, "sink");
        GstPad* hsrc = gst_element_get_static_pad(head, "src");
        ok = gst_pad_link(pad, hs) == GST_PAD_LINK_OK && gst_pad_link(hsrc, tee_sink) == GST_PAD_LINK_OK;
        gst_object_unref(hs);
        gst_object_unref(hsrc);
        if (!ok) emit_msg("error", "linkOnPadAdded: tee fan-out parser link failed (" + r.rule_id + ")");
    } else {
        ok = gst_pad_link(pad, tee_sink) == GST_PAD_LINK_OK;
        if (!ok) emit_msg("error", "linkOnPadAdded: tee fan-out link failed (" + r.rule_id + ")");
    }
    gst_object_unref(tee_sink);
    if (!ok) return;
    for (int index : indices) {
        if (index < 0 || (size_t)index >= r.branches.size()) continue;
        GstElement* leaf = gst_parse_bin_from_description(r.branches[(size_t)index].c_str(), TRUE, &err);
        if (!leaf || err) {
            emit_msg("error", std::string("linkOnPadAdded: tee fan-out parse failed: ") + (err && err->message ? err->message : "?"));
            g_clear_error(&err);
            if (leaf) gst_object_unref(leaf);
            return;
        }
        gst_element_set_name(leaf, fmt("branch_%s_%d", rule_path(r.rule_id).c_str(), index).c_str());
        gst_bin_add(GST_BIN(r.pipe), leaf);
        gst_element_sync_state_with_parent(leaf);
        GstPad* tee_src = gst_element_request_pad_simple(tee, "src_%u");
        GstPad* leaf_sink = gst_element_get_static_pad(leaf, "sink");
        GstPadLinkReturn lr = tee_src && leaf_sink ? gst_pad_link(tee_src, leaf_sink) : GST_PAD_LINK_REFUSED;
        if (leaf_sink) gst_object_unref(leaf_sink);
        if (tee_src) gst_object_unref(tee_src);
        if (lr != GST_PAD_LINK_OK) {
            emit_msg("error", fmt("linkOnPadAdded: tee branch link failed (%s, %d, %d)", r.rule_id.c_str(), index, (int)lr));
            continue;
        }
        emit_pad_linked(r, pad, index);
    }
}

void on_pad_added(GstElement*, GstPad* pad, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<Rule>*>(user);
    Rule& r = **holder;
    if (!r.media.empty() && pad_caps_media(pad) != r.media) return;
    int index;
    if (!r.match_pids.empty()) {
        int pad_pid = pid_from_pad_name(GST_PAD_NAME(pad));
        std::vector<int> indices;
        for (size_t i = 0; i < r.match_pids.size(); i++)
            if (pad_pid >= 0 && r.match_pids[i] == pad_pid) indices.push_back((int)i);
        if (indices.empty()) return;   // a PID not wired to an output — never misrouted
        if (indices.size() > 1) {
            link_via_tee(r, pad, indices);
            return;
        }
        index = indices[0];
    } else {
        index = r.count;
    }
    if ((size_t)index >= r.branches.size()) return;
    r.count = index + 1;
    std::string branch_str = parser_prefix_for_pad(pad, r.rule_id, r.parser_mode) + r.branches[(size_t)index];
    GError* err = nullptr;
    GstElement* bin = gst_parse_bin_from_description(branch_str.c_str(), TRUE, &err);
    if (!bin || err) {
        emit_msg("error", std::string("linkOnPadAdded: branch parse failed: ") + (err && err->message ? err->message : "?"));
        g_clear_error(&err);
        if (bin) gst_object_unref(bin);
        return;
    }
    gst_element_set_name(bin, fmt("branch_%s_%d", rule_path(r.rule_id).c_str(), index).c_str());
    // add → link (both ends) → sync state.
    gst_bin_add(GST_BIN(r.pipe), bin);
    GstPad* sink_pad = gst_element_get_static_pad(bin, "sink");
    if (!sink_pad) {
        emit_msg("error", "linkOnPadAdded: branch has no sink pad (" + r.rule_id + ")");
        return;
    }
    GstPadLinkReturn lr = gst_pad_link(pad, sink_pad);
    gst_object_unref(sink_pad);
    if (lr != GST_PAD_LINK_OK) {
        emit_msg("error", fmt("linkOnPadAdded: pad link failed (%d) for rule %s", (int)lr, r.rule_id.c_str()));
        return;
    }
    if (!r.link_to.empty()) {
        GstElement* target = gst_bin_get_by_name(GST_BIN(r.pipe), r.link_to.c_str());
        if (!target) {
            emit_msg("error", "linkOnPadAdded: linkTo target not found: " + r.link_to);
            return;
        }
        GstPad* src_pad = gst_element_get_static_pad(bin, "src");
        if (!src_pad) {
            emit_msg("error", fmt("linkOnPadAdded: branch has no src pad to link to %s (%s)", r.link_to.c_str(), r.rule_id.c_str()));
            gst_object_unref(target);
            return;
        }
        std::string pad_name = (size_t)index < r.requested_pad_names.size() ? r.requested_pad_names[(size_t)index] : "sink_%d";
        GstPad* req = gst_element_request_pad_simple(target, pad_name.c_str());
        if (!req) {
            emit_msg("error", fmt("linkOnPadAdded: could not request sink pad on %s (%s)", r.link_to.c_str(), r.rule_id.c_str()));
            gst_object_unref(src_pad);
            gst_object_unref(target);
            return;
        }
        if (r.has_offset && r.pad_offset_ns) gst_pad_set_offset(req, r.pad_offset_ns);
        GstPadLinkReturn outer = gst_pad_link(src_pad, req);
        gst_object_unref(src_pad);
        gst_object_unref(req);
        gst_object_unref(target);
        if (outer != GST_PAD_LINK_OK) {
            emit_msg("error", fmt("linkOnPadAdded: could not link branch src to %s (%d) (%s)", r.link_to.c_str(), (int)outer,
                                  r.rule_id.c_str()));
            return;
        }
    }
    gst_element_sync_state_with_parent(bin);
    emit_pad_linked(r, pad, index);
}

void on_discovery_pad(GstElement*, GstPad* pad, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<Discovery>*>(user);
    Discovery& d = **holder;
    GstCaps* caps = pad_caps(pad);
    std::string caps_name = caps_name_of(caps);
    gchar* caps_str = caps ? gst_caps_to_string(caps) : nullptr;
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "from", d.source_name.c_str());
    int pid = pid_from_pad_name(GST_PAD_NAME(pad));
    if (pid >= 0) json_object_set_int_member(o, "pid", pid);
    else json_object_set_null_member(o, "pid");
    json_object_set_string_member(o, "media", stream_media_from_caps_name(caps_name).c_str());
    json_object_set_string_member(o, "caps", caps_str ? caps_str : "");
    json_object_set_string_member(o, "padName", GST_PAD_NAME(pad));
    JsonNode* n = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(n, o);
    runner().emit_plugin_event("stream:discovered", n);
    g_free(caps_str);
    if (caps) gst_caps_unref(caps);
}

template <typename T>
void delete_holder(gpointer p, GClosure*) { delete static_cast<std::shared_ptr<T>*>(p); }

}  // namespace

bool parser_for_caps(GstCaps* caps, std::string* out) {
    if (!caps || gst_caps_get_size(caps) == 0) return false;
    const GstStructure* s = gst_caps_get_structure(caps, 0);
    std::string name = gst_structure_get_name(s) ? gst_structure_get_name(s) : "";
    if (name == "audio/mpeg") {
        gint v = 0;
        if (gst_structure_get_int(s, "mpegversion", &v)) {
            if (v == 2 || v == 4) { *out = "aacparse"; return true; }
            if (v == 1) { *out = "mpegaudioparse"; return true; }
        }
        return false;
    }
    auto it = PARSER_FOR_CAPS_NAME.find(name);
    if (it == PARSER_FOR_CAPS_NAME.end()) return false;
    *out = it->second;
    return true;
}

void install(GstElement* pipe, JsonArray* rules) {
    clear();
    if (!rules || !GST_IS_BIN(pipe)) return;
    std::set<std::string> sources;
    guint n = json_array_get_length(rules);
    for (guint i = 0; i < n; i++) {
        JsonNode* node = json_array_get_element(rules, i);
        if (!JSON_NODE_HOLDS_OBJECT(node)) continue;
        JsonObject* rule = json_node_get_object(node);
        auto r = std::make_shared<Rule>();
        r->pipe = pipe;
        r->from = json_get_string(rule, "from");
        r->src = r->from.empty() ? nullptr : gst_bin_get_by_name(GST_BIN(pipe), r->from.c_str());
        if (!r->src) {
            emit_msg("error", "linkOnPadAdded: source element not found: " + r->from);
            continue;
        }
        if (JsonArray* b = json_get_array(rule, "branches")) {
            for (guint k = 0; k < json_array_get_length(b); k++) {
                JsonNode* bn = json_array_get_element(b, k);
                r->branches.push_back(JSON_NODE_HOLDS_VALUE(bn) && json_node_get_string(bn) ? json_node_get_string(bn) : "");
            }
        }
        if (r->branches.empty()) {
            gst_object_unref(r->src);
            continue;
        }
        r->media = json_get_string(rule, "media");
        r->rule_id = r->from + "::" + r->media;
        r->link_to = json_get_string(rule, "linkTo");
        if (JsonArray* names = json_get_array(rule, "requestedPadNames"))
            for (guint k = 0; k < json_array_get_length(names); k++) {
                JsonNode* nn = json_array_get_element(names, k);
                r->requested_pad_names.push_back(JSON_NODE_HOLDS_VALUE(nn) && json_node_get_string(nn) ? json_node_get_string(nn) : "");
            }
        if (JsonArray* pids = json_get_array(rule, "matchPids"))
            for (guint k = 0; k < json_array_get_length(pids); k++) r->match_pids.push_back((int)json_array_get_int_element(pids, k));
        r->has_offset = json_has(rule, "padOffsetNs");
        r->pad_offset_ns = json_get_int(rule, "padOffsetNs", 0);
        r->parser_mode = json_get_string(rule, "parser", "auto");
        if (r->parser_mode.empty()) r->parser_mode = "auto";
        r->handler = g_signal_connect_data(r->src, "pad-added", G_CALLBACK(on_pad_added), new std::shared_ptr<Rule>(r),
                                           delete_holder<Rule>, (GConnectFlags)0);
        g_rules.push_back(r);
        sources.insert(r->from);
    }
    // Stream discovery: every pad the demux exposes, once per element.
    for (const std::string& name : sources) {
        GstElement* el = gst_bin_get_by_name(GST_BIN(pipe), name.c_str());
        if (!el) continue;
        auto d = std::make_shared<Discovery>();
        d->source_name = name;
        d->el = el;
        d->handler = g_signal_connect_data(el, "pad-added", G_CALLBACK(on_discovery_pad), new std::shared_ptr<Discovery>(d),
                                           delete_holder<Discovery>, (GConnectFlags)0);
        g_discovery.push_back(d);
    }
}

void clear() {
    for (auto& r : g_rules) {
        if (r->handler) g_signal_handler_disconnect(r->src, r->handler);
        gst_object_unref(r->src);
    }
    g_rules.clear();
    for (auto& d : g_discovery) {
        if (d->handler) g_signal_handler_disconnect(d->el, d->handler);
        gst_object_unref(d->el);
    }
    g_discovery.clear();
    g_unknown_codec_warned.clear();
}

}  // namespace mr::padlink
