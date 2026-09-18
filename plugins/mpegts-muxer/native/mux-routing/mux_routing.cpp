// mux_routing — media-agnostic routing of demuxed pads into the muxer
// (ADR-0017), the native form of `py/mux_routing.py`. Same config, same
// events, same log lines; that file's docstring is the specification and its
// suite the reference. Loaded by mr-gst-runner through mr_hook.h (ADR-0020).
#include <gst/gst.h>
#define GST_USE_UNSTABLE_API   // gst/mpegts is "unstable API" (it has not changed since 1.x)
#include <gst/mpegts/mpegts.h>
#include <json-glib/json-glib.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#include "mr_hook.h"

namespace {

constexpr int SPARSE_GAP_MS = 500;
constexpr int SPARSE_GAP_LEAD_MS = 2 * SPARSE_GAP_MS;

// Class order when one input carries several streams: the first class present
// takes the input's PID (python `_PRIORITY`, TS `MUX_ROUTE_PRIORITY`).
const char* const PRIORITY[] = {"video", "audio", "klv", "subtitle"};
// Output PIDs an extra class may never spill onto.
const int RESERVED_PIDS[] = {0x1000, 0x1F0};
constexpr int MAX_ES_PID = 0x1FFE;

// Caps-name → parser between tsdemux and mpegtsmux (see the python table).
struct ParserEntry {
    const char* caps;
    const char* parser;   // "" = parser-free, nullptr = by mpegversion
};
const ParserEntry PARSER_FOR_CAPS[] = {
    {"video/x-h264", "h264parse config-interval=-1"},
    {"video/x-h265", "h265parse config-interval=-1"},
    {"video/x-av1", "av1parse"},
    {"audio/x-ac3", "ac3parse"},
    {"audio/x-eac3", "ac3parse"},
    {"audio/mpeg", nullptr},
    {"audio/x-opus", ""},
    {"meta/x-klv", ""},
    {"application/x-teletext", ""},
    {"subpicture/x-dvb", ""},
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

std::string json_escape(const std::string& s) {
    std::string out;
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) out += fmt("\\u%04x", c);
                else out += (char)c;
        }
    }
    return out;
}

// --- state ---------------------------------------------------------------------

struct Sparse {
    GstPad* pad = nullptr;   // owned ref (request pad)
    std::string rule_id, media;
    GstElement* pipe = nullptr;
    int restamped = 0, gaps = 0, gap_refused = 0;
    guint timer = 0;
};

struct PcrPin {
    std::string media, pad;
};

struct Input {
    GstElement* pipe = nullptr;
    std::string demux, rule_id, link_to;
    JsonObject* routes = nullptr;     // owned ref
    std::set<int> ignore;
    bool has_pcr = false;
    int pcr_program = 1;
    std::map<std::string, std::string> linked;   // class → demux pad already routed
    // Generic input (pid >= 0): its PID, the classes its PMT carries, and
    // the output PID each routed class got (sticky for the run).
    int pid = -1;
    std::set<std::string> classes;
    std::map<std::string, int> assigned;
};

struct State {
    const MrHookCtx* ctx = nullptr;
    std::map<std::string, PcrPin> pcr;            // linkTo → pin
    std::vector<std::shared_ptr<Sparse>> sparse;
    std::vector<std::pair<GstElement*, gulong>> handlers;
    std::set<std::string> warned;
    std::vector<std::shared_ptr<Input>> inputs;
    std::map<std::string, std::shared_ptr<Input>> by_demux;
    std::set<int> taken;                          // output PIDs no spill may take
    std::mutex mu;                                // PMT + pad-added run on demux threads
    GstBus* bus = nullptr;                        // owned ref while watching PMTs
    gulong bus_handler = 0;
};

std::unique_ptr<State> g_state;

void emit_json(const std::string& json) {
    if (g_state && g_state->ctx && g_state->ctx->emit_event) g_state->ctx->emit_event(g_state->ctx->user, json.c_str());
}

void emit_msg(const char* event, const std::string& message) {
    emit_json("{\"event\":\"" + std::string(event) + "\",\"message\":\"" + json_escape(message) + "\"}");
}

void log_line(const std::string& msg) {
    if (g_state && g_state->ctx && g_state->ctx->log) g_state->ctx->log(g_state->ctx->user, ("[mux_routing] " + msg).c_str());
}

// --- pure helpers (twins of the python ones) -------------------------------------

std::string route_media_for_caps(const std::string& caps_name) {
    if (caps_name.rfind("video/", 0) == 0) return "video";
    if (caps_name.rfind("audio/", 0) == 0) return "audio";
    if (caps_name == "meta/x-klv") return "klv";
    if (caps_name.rfind("subpicture/", 0) == 0 || caps_name == "application/x-teletext") return "subtitle";
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

/** Parser element string; "" for parser-free; false (unknown) → *out untouched. */
bool parser_for_caps_name(const std::string& caps_name, int mpegversion, std::string* out) {
    if (caps_name == "audio/mpeg") {
        if (mpegversion == 2 || mpegversion == 4) { *out = "aacparse"; return true; }
        if (mpegversion == 1) { *out = "mpegaudioparse"; return true; }
        return false;
    }
    for (const ParserEntry& e : PARSER_FOR_CAPS)
        if (caps_name == e.caps && e.parser) { *out = e.parser; return true; }
    return false;
}

// --- plumbing ----------------------------------------------------------------------

std::string caps_name_of(GstCaps* caps) {
    if (!caps || gst_caps_get_size(caps) == 0) return "";
    const gchar* n = gst_structure_get_name(gst_caps_get_structure(caps, 0));
    return n ? n : "";
}

std::string parser_prefix(GstPad* pad, GstCaps* caps, const std::string& rule_id, const std::string& mode) {
    std::string caps_name = caps_name_of(caps);
    if (mode == "none") {
        auto it = AU_ALIGNED_CAPS.find(caps_name);
        if (it != AU_ALIGNED_CAPS.end()) {
            emit_msg("warning", fmt("mux_routing: parser bypass on %s (%s) — declaring %s", GST_PAD_NAME(pad),
                                    rule_id.c_str(), it->second.c_str()));
            return "capssetter caps=\"" + it->second + "\" ! ";
        }
    }
    int mpegversion = 0;
    if (caps_name == "audio/mpeg" && caps && gst_caps_get_size(caps) > 0)
        gst_structure_get_int(gst_caps_get_structure(caps, 0), "mpegversion", &mpegversion);
    std::string parser;
    if (!parser_for_caps_name(caps_name, mpegversion, &parser)) {
        std::string key = rule_id + "::" + caps_name;
        if (g_state->warned.insert(key).second)
            emit_msg("warning", fmt("mux_routing: no parser registered for caps '%s' on %s — linking passthrough; "
                                    "mpegtsmux may refuse if the codec needs framing",
                                    caps_name.empty() ? "unknown" : caps_name.c_str(), rule_id.c_str()));
        return "";
    }
    return parser.empty() ? "" : parser + " ! ";
}

void sink_unrouted(GstElement* pipe, GstPad* pad, const std::string& rule_id, const std::string& why) {
    std::string key = rule_id + "::" + why;
    if (g_state->warned.insert(key).second)
        emit_msg("warning", fmt("mux_routing: %s not routed on %s — %s; sinking it", GST_PAD_NAME(pad), rule_id.c_str(),
                                why.c_str()));
    GstElement* fs = gst_element_factory_make("fakesink", nullptr);
    if (!fs) return;
    g_object_set(fs, "sync", FALSE, "async", FALSE, nullptr);
    gst_bin_add(GST_BIN(pipe), fs);
    gst_element_sync_state_with_parent(fs);
    GstPad* sink = gst_element_get_static_pad(fs, "sink");
    if (gst_pad_link(pad, sink) != GST_PAD_LINK_OK)
        emit_msg("warning", fmt("mux_routing: could not sink unrouted pad %s (link failed)", GST_PAD_NAME(pad)));
    gst_object_unref(sink);
}

/** Point `prog-map`'s `PCR_<program>` of `target_name` at the request pad
 *  about to be linked, video preferred (see the python docstring). */
void pin_pcr_before_link(GstElement* pipe, const std::string& target_name, int program, const std::string& media,
                         const std::string& pad_name, const std::string& rule_id) {
    auto st = g_state->pcr.find(target_name);
    if (st != g_state->pcr.end() && (st->second.media == "video" || media != "video")) return;
    GstElement* target = gst_bin_get_by_name(GST_BIN(pipe), target_name.c_str());
    if (!target) return;
    if (!g_object_class_find_property(G_OBJECT_GET_CLASS(target), "prog-map")) {
        gst_object_unref(target);
        return;
    }
    GstStructure* cur = nullptr;
    g_object_get(target, "prog-map", &cur, nullptr);
    GstStructure* s = cur ? cur : gst_structure_new_empty("program_map");
    gst_structure_set(s, ("PCR_" + std::to_string(program)).c_str(), G_TYPE_STRING, pad_name.c_str(), nullptr);
    g_object_set(target, "prog-map", s, nullptr);
    gst_structure_free(s);
    gst_object_unref(target);
    g_state->pcr[target_name] = {media, pad_name};
    log_line(fmt("PCR_%d of %s → %s (%s, %s)", program, target_name.c_str(), pad_name.c_str(), media.c_str(),
                 rule_id.c_str()));
}

/** The mux's current position in `pad`'s stream time, or -1. */
gint64 sparse_position(GstElement* pipe, GstPad* pad) {
    GstClock* clock = gst_element_get_clock(pipe);
    if (!clock) return -1;
    gint64 rt = (gint64)gst_clock_get_time(clock) - (gint64)gst_element_get_base_time(pipe);
    gst_object_unref(clock);
    if (rt < 0) rt = 0;
    GstEvent* ev = gst_pad_get_sticky_event(pad, GST_EVENT_SEGMENT, 0);
    if (ev) {
        const GstSegment* seg = nullptr;
        gst_event_parse_segment(ev, &seg);
        if (seg) {
            guint64 pos = gst_segment_position_from_running_time(seg, GST_FORMAT_TIME, (guint64)rt);
            gst_event_unref(ev);
            if (pos != GST_CLOCK_TIME_NONE) return (gint64)pos;
        } else {
            gst_event_unref(ev);
        }
    }
    return rt;
}

GstPadProbeReturn sparse_probe_cb(GstPad* pad, GstPadProbeInfo* info, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<Sparse>*>(user);
    Sparse& st = **holder;
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf) return GST_PAD_PROBE_OK;
    gint64 pos = sparse_position(st.pipe, pad);
    if (pos >= 0) {
        if (st.restamped == 0) {
            std::string had = GST_CLOCK_TIME_IS_VALID(GST_BUFFER_PTS(buf))
                                  ? fmt("%.0f ms", (double)GST_BUFFER_PTS(buf) / 1e6)
                                  : "no PTS";
            log_line(fmt("sparse %s route on %s restamped to the mux position (first buffer carried %s, now %.0f ms)",
                         st.media.c_str(), st.rule_id.c_str(), had.c_str(), (double)pos / 1e6));
        }
        buf = gst_buffer_make_writable(buf);
        GST_PAD_PROBE_INFO_DATA(info) = buf;
        GST_BUFFER_PTS(buf) = (GstClockTime)pos;
        GST_BUFFER_DTS(buf) = GST_CLOCK_TIME_NONE;
        st.restamped++;
    }
    return GST_PAD_PROBE_OK;
}

void delete_sparse_holder(gpointer p) { delete static_cast<std::shared_ptr<Sparse>*>(p); }

gboolean sparse_tick_cb(gpointer user) {
    auto* holder = static_cast<std::shared_ptr<Sparse>*>(user);
    Sparse& st = **holder;
    if (!g_state || !st.timer) return G_SOURCE_REMOVE;
    gint64 pos = sparse_position(st.pipe, st.pad);
    if (pos < 0) return G_SOURCE_CONTINUE;
    gboolean ok = gst_pad_send_event(st.pad, gst_event_new_gap((GstClockTime)(pos + (gint64)SPARSE_GAP_LEAD_MS * 1000000), 0));
    if (ok) st.gaps++;
    else st.gap_refused++;
    return G_SOURCE_CONTINUE;
}

void arm_sparse_pad(GstElement* pipe, GstPad* req_pad, const std::string& rule_id, const std::string& media) {
    auto st = std::make_shared<Sparse>();
    st->pad = GST_PAD(gst_object_ref(req_pad));
    st->rule_id = rule_id;
    st->media = media;
    st->pipe = pipe;
    gst_pad_add_probe(req_pad, GST_PAD_PROBE_TYPE_BUFFER, sparse_probe_cb, new std::shared_ptr<Sparse>(st),
                      delete_sparse_holder);
    st->timer = g_timeout_add_full(G_PRIORITY_DEFAULT, SPARSE_GAP_MS, sparse_tick_cb, new std::shared_ptr<Sparse>(st),
                                   delete_sparse_holder);
    g_state->sparse.push_back(st);
}

// --- one PID per input ------------------------------------------------------------

// Route class of one PMT stream from its stream_type and descriptor loop —
// python `pmt_stream_media` (its docstring is the specification).
std::string pmt_stream_media(int stream_type, const GPtrArray* descriptors) {
    static const std::set<int> VIDEO = {0x01, 0x02, 0x10, 0x1B, 0x24, 0x42, 0xEA};
    static const std::set<int> AUDIO = {0x03, 0x04, 0x0F, 0x11, 0x1C, 0x81, 0x87, 0x8A};
    if (VIDEO.count(stream_type)) return "video";
    if (AUDIO.count(stream_type)) return "audio";
    if (stream_type == 0x15) return "klv";
    if (stream_type == 0x06 && descriptors) {
        for (guint i = 0; i < descriptors->len; i++) {
            auto* d = static_cast<const GstMpegtsDescriptor*>(g_ptr_array_index(descriptors, i));
            if (!d) continue;
            const int tag = d->tag;
            if (tag == 0x56 || tag == 0x59) return "subtitle";
            if (tag == 0x05 && d->length >= 4 && d->data) {
                if (std::memcmp(d->data + 2, "KLVA", 4) == 0) return "klv";
                if (std::memcmp(d->data + 2, "Opus", 4) == 0) return "audio";
            }
            if (tag == 0x6A || tag == 0x7A || tag == 0x7B || tag == 0x7C) return "audio";
            if (tag == 0x7F && d->tag_extension == 0x80) return "audio";
        }
    }
    return "data";
}

// Output PID for the `media` pad of generic input `in` — python
// `plan_output_pid`: the input's own PID for its primary class (first in
// PRIORITY among the PMT's classes plus `media`, restricted to classes with a
// route), handed out once; every other class the next free PID above it.
// Caller holds g_state->mu.
int plan_output_pid(const Input& in, const std::string& media) {
    auto done = in.assigned.find(media);
    if (done != in.assigned.end()) return done->second;
    std::string primary = media;
    for (const char* c : PRIORITY) {
        const bool present = in.classes.count(c) || media == c;
        const bool routable = in.routes && json_object_has_member(in.routes, c);
        if (present && routable) {
            primary = c;
            break;
        }
    }
    bool pid_used = false;
    for (const auto& [_, p] : in.assigned)
        if (p == in.pid) pid_used = true;
    if (primary == media && !pid_used) return in.pid;
    int out = in.pid + 1;
    auto reserved = [](int p) {
        for (int r : RESERVED_PIDS)
            if (r == p) return true;
        return false;
    };
    while (g_state->taken.count(out) || reserved(out)) out++;
    if (out > MAX_ES_PID) return -1;
    return out;
}

// Add `sink_<pid>=(int)program` to `target_name`'s prog-map for a PID the
// builder could not list (a multi-stream input's spill). Same mechanism as
// the PCR pin: mpegtsmux reads prog-map per pad at stream creation.
void ensure_prog_map(GstElement* pipe, const std::string& target_name, int program, const std::string& pad_name) {
    GstElement* target = gst_bin_get_by_name(GST_BIN(pipe), target_name.c_str());
    if (!target) return;
    if (!g_object_class_find_property(G_OBJECT_GET_CLASS(target), "prog-map")) {
        gst_object_unref(target);
        return;
    }
    GstStructure* cur = nullptr;
    g_object_get(target, "prog-map", &cur, nullptr);
    if (cur && gst_structure_has_field(cur, pad_name.c_str())) {
        gst_structure_free(cur);
        gst_object_unref(target);
        return;
    }
    GstStructure* s = cur ? cur : gst_structure_new_empty("program_map");
    gst_structure_set(s, pad_name.c_str(), G_TYPE_INT, program, nullptr);
    g_object_set(target, "prog-map", s, nullptr);
    gst_structure_free(s);
    gst_object_unref(target);
}

// tsdemux posts every PSI section it parses as an element message; with sync
// emission it arrives on the demuxer's streaming thread BEFORE that thread
// adds any pad, so plan_output_pid always knows the class set first. (The
// python form degrades to pad order when its GstMpegts binding is missing;
// this form links libgstmpegts at load, so there is no such path here.)
void on_sync_message(GstBus*, GstMessage* msg, gpointer) {
    if (!g_state || GST_MESSAGE_TYPE(msg) != GST_MESSAGE_ELEMENT) return;
    GstObject* src = GST_MESSAGE_SRC(msg);
    if (!src) return;
    std::shared_ptr<Input> in;
    {
        std::lock_guard<std::mutex> lock(g_state->mu);
        auto it = g_state->by_demux.find(GST_OBJECT_NAME(src));
        if (it == g_state->by_demux.end()) return;
        in = it->second;
    }
    GstMpegtsSection* sec = gst_message_parse_mpegts_section(msg);
    if (!sec) return;
    if (sec->section_type == GST_MPEGTS_SECTION_PMT) {
        const GstMpegtsPMT* pmt = gst_mpegts_section_get_pmt(sec);
        if (pmt && pmt->streams) {
            std::set<std::string> classes;
            for (guint i = 0; i < pmt->streams->len; i++) {
                auto* st = static_cast<const GstMpegtsPMTStream*>(g_ptr_array_index(pmt->streams, i));
                if (st) classes.insert(pmt_stream_media(st->stream_type, st->descriptors));
            }
            std::string listed;
            for (const auto& c : classes) listed += (listed.empty() ? "" : ", ") + c;
            {
                std::lock_guard<std::mutex> lock(g_state->mu);
                in->classes = classes;
            }
            log_line(fmt("%s PMT: [%s] (pid %d)", in->demux.c_str(), listed.c_str(), in->pid));
        }
    }
    gst_mpegts_section_unref(sec);
}

bool link_pad(Input& in, GstPad* pad, const std::string& media, const std::string& branch_str,
              const std::string& pad_name, gint64 pad_offset_ns, bool has_offset, int pid, int out_pid, bool sparse) {
    GstElement* pipe = in.pipe;
    const std::string& rule_id = in.rule_id;
    GError* err = nullptr;
    GstElement* bin = gst_parse_bin_from_description(branch_str.c_str(), TRUE, &err);
    if (!bin || err) {
        emit_msg("error", std::string("mux_routing: branch parse failed: ") + (err && err->message ? err->message : "?"));
        g_clear_error(&err);
        if (bin) gst_object_unref(bin);
        return false;
    }
    std::string rule_path = rule_id;
    for (size_t p = rule_path.find("::"); p != std::string::npos; p = rule_path.find("::")) rule_path.replace(p, 2, "_");
    gst_element_set_name(bin, ("branch_" + rule_path + "_" + media).c_str());
    // add → link both ends → sync state.
    gst_bin_add(GST_BIN(pipe), bin);
    GstPad* sink_pad = gst_element_get_static_pad(bin, "sink");
    if (!sink_pad) {
        emit_msg("error", "mux_routing: branch has no sink pad (" + rule_id + ")");
        return false;
    }
    GstPadLinkReturn ret = gst_pad_link(pad, sink_pad);
    gst_object_unref(sink_pad);
    if (ret != GST_PAD_LINK_OK) {
        emit_msg("error", fmt("mux_routing: pad link failed (%d) on %s", (int)ret, rule_id.c_str()));
        return false;
    }
    if (!in.link_to.empty()) {
        GstElement* target = gst_bin_get_by_name(GST_BIN(pipe), in.link_to.c_str());
        if (!target) {
            emit_msg("error", "mux_routing: linkTo target not found: " + in.link_to);
            return false;
        }
        GstPad* src_pad = gst_element_get_static_pad(bin, "src");
        GstPad* req_pad = gst_element_request_pad_simple(target, pad_name.c_str());
        if (!src_pad || !req_pad) {
            emit_msg("error", fmt("mux_routing: could not request %s on %s (%s)", pad_name.c_str(), in.link_to.c_str(),
                                  rule_id.c_str()));
            if (src_pad) gst_object_unref(src_pad);
            if (req_pad) gst_object_unref(req_pad);
            gst_object_unref(target);
            return false;
        }
        // Offset BEFORE linking: the sticky segment propagates at link time.
        if (has_offset && pad_offset_ns) gst_pad_set_offset(req_pad, pad_offset_ns);
        GstPadLinkReturn outer = gst_pad_link(src_pad, req_pad);
        gst_object_unref(src_pad);
        if (outer != GST_PAD_LINK_OK) {
            emit_msg("error", fmt("mux_routing: could not link branch to %s (%d) (%s)", in.link_to.c_str(), (int)outer,
                                  rule_id.c_str()));
            gst_object_unref(req_pad);
            gst_object_unref(target);
            return false;
        }
        if (sparse) arm_sparse_pad(pipe, req_pad, rule_id, media);
        gst_object_unref(req_pad);
        gst_object_unref(target);
    }
    gst_element_sync_state_with_parent(bin);
    std::string ev = "{\"event\":\"pad_linked\",\"rule\":\"" + json_escape(rule_id) + "\",\"padName\":\"" +
                     json_escape(GST_PAD_NAME(pad)) + "\",\"media\":\"" + media + "\",\"pid\":" +
                     (pid >= 0 ? std::to_string(pid) : "null") + ",\"outPid\":" +
                     (out_pid >= 0 ? std::to_string(out_pid) : "null");
    if (has_offset && pad_offset_ns && !in.link_to.empty()) ev += ",\"padOffsetNs\":" + std::to_string(pad_offset_ns);
    ev += "}";
    emit_json(ev);
    return true;
}

void on_pad_added(GstElement*, GstPad* pad, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<Input>*>(user);
    Input& in = **holder;
    if (!g_state) return;
    GstCaps* caps = gst_pad_get_current_caps(pad);
    if (!caps) caps = gst_pad_query_caps(pad, nullptr);
    std::string caps_name = caps_name_of(caps);
    int pid = pid_from_pad_name(GST_PAD_NAME(pad));
    if (pid >= 0 && in.ignore.count(pid)) {
        sink_unrouted(in.pipe, pad, in.rule_id, fmt("pid 0x%x is excluded", pid));
        if (caps) gst_caps_unref(caps);
        return;
    }
    std::string media = route_media_for_caps(caps_name);
    JsonObject* route = nullptr;
    if (in.routes && json_object_has_member(in.routes, media.c_str())) {
        JsonNode* n = json_object_get_member(in.routes, media.c_str());
        if (JSON_NODE_HOLDS_OBJECT(n)) route = json_node_get_object(n);
    }
    const gchar* fixed_pad_name = route && json_object_has_member(route, "padName") &&
                                          !JSON_NODE_HOLDS_NULL(json_object_get_member(route, "padName"))
                                      ? json_object_get_string_member(route, "padName")
                                      : nullptr;
    if (!route || (in.pid < 0 && (!fixed_pad_name || !*fixed_pad_name))) {
        sink_unrouted(in.pipe, pad, in.rule_id,
                      fmt("no route for %s (%s)", media.c_str(), caps_name.empty() ? "unknown caps" : caps_name.c_str()));
        if (caps) gst_caps_unref(caps);
        return;
    }
    auto already = in.linked.find(media);
    if (already != in.linked.end()) {
        sink_unrouted(in.pipe, pad, in.rule_id,
                      fmt("second %s stream (already routed %s)", media.c_str(), already->second.c_str()));
        if (caps) gst_caps_unref(caps);
        return;
    }
    in.linked[media] = GST_PAD_NAME(pad);
    // Generic input: the pad name comes from the input's PID and the PMT.
    std::string pad_name = fixed_pad_name ? fixed_pad_name : "";
    int out_pid = -1;
    if (in.pid >= 0) {
        std::lock_guard<std::mutex> lock(g_state->mu);
        out_pid = plan_output_pid(in, media);
        if (out_pid < 0) {
            emit_msg("error", fmt("mux_routing: no free output PID above %d for %s on %s", in.pid, media.c_str(),
                                  in.rule_id.c_str()));
            // Sink it (python does the same): an unlinked pad is the tsdemux
            // NOT_LINKED restart loop this hook exists to prevent.
            in.linked.erase(media);
            sink_unrouted(in.pipe, pad, in.rule_id, "no free output PID");
            if (caps) gst_caps_unref(caps);
            return;
        }
        in.assigned[media] = out_pid;
        g_state->taken.insert(out_pid);
        pad_name = "sink_" + std::to_string(out_pid);
        if (out_pid != in.pid) {
            std::string owner = "a higher class";
            for (const auto& [c, p] : in.assigned)
                if (p == in.pid) owner = c;
            log_line(fmt("%s: %s spills to output PID %d (input PID %d belongs to %s)", in.rule_id.c_str(),
                         media.c_str(), out_pid, in.pid, owner.c_str()));
        }
    }
    std::string parser_mode = "auto";
    if (json_object_has_member(route, "parser") && !JSON_NODE_HOLDS_NULL(json_object_get_member(route, "parser")))
        parser_mode = json_object_get_string_member(route, "parser");
    std::string branch = "queue";
    if (json_object_has_member(route, "branch") && !JSON_NODE_HOLDS_NULL(json_object_get_member(route, "branch"))) {
        const gchar* b = json_object_get_string_member(route, "branch");
        if (b && *b) branch = b;
    }
    branch = parser_prefix(pad, caps, in.rule_id, parser_mode) + branch;
    gchar* caps_str = caps ? gst_caps_to_string(caps) : nullptr;
    if (caps) gst_caps_unref(caps);
    if (!in.link_to.empty() && in.pid >= 0) ensure_prog_map(in.pipe, in.link_to, in.pcr_program, pad_name);
    if (!in.link_to.empty() && in.has_pcr && (media == "video" || media == "audio"))
        pin_pcr_before_link(in.pipe, in.link_to, in.pcr_program, media, pad_name, in.rule_id);
    bool has_offset = json_object_has_member(route, "padOffsetNs") &&
                      !JSON_NODE_HOLDS_NULL(json_object_get_member(route, "padOffsetNs"));
    gint64 offset = has_offset ? json_object_get_int_member(route, "padOffsetNs") : 0;
    bool sparse = json_object_has_member(route, "sparse") && !JSON_NODE_HOLDS_NULL(json_object_get_member(route, "sparse")) &&
                  json_object_get_boolean_member(route, "sparse");
    bool ok = link_pad(in, pad, media, branch, pad_name, offset, has_offset, pid, out_pid, sparse);
    if (ok && g_state && g_state->ctx && g_state->ctx->emit_plugin_event) {
        std::string payload = "{\"demux\":\"" + json_escape(in.demux) + "\",\"media\":\"" + media + "\",\"srcPid\":" +
                              (pid >= 0 ? std::to_string(pid) : "null") + ",\"outPid\":" +
                              (out_pid >= 0 ? std::to_string(out_pid) : "null") + ",\"caps\":\"" +
                              json_escape(caps_str ? caps_str : "") + "\"}";
        g_state->ctx->emit_plugin_event(g_state->ctx->user, "mux:routed", payload.c_str());
    }
    g_free(caps_str);
}

void delete_input_holder(gpointer p, GClosure*) { delete static_cast<std::shared_ptr<Input>*>(p); }

void install_input(GstElement* pipe, JsonObject* entry) {
    const gchar* demux = json_object_has_member(entry, "demux") ? json_object_get_string_member(entry, "demux") : nullptr;
    std::string demux_name = demux ? demux : "";
    GstElement* src = demux_name.empty() ? nullptr : gst_bin_get_by_name(GST_BIN(pipe), demux_name.c_str());
    if (!src) {
        emit_msg("error", "mux_routing: demuxer not found: " + demux_name);
        return;
    }
    auto in = std::make_shared<Input>();
    in->pipe = pipe;
    in->demux = demux_name;
    in->rule_id = demux_name + "::any";
    if (json_object_has_member(entry, "routes") && JSON_NODE_HOLDS_OBJECT(json_object_get_member(entry, "routes")))
        in->routes = json_object_ref(json_object_get_object_member(entry, "routes"));
    if (json_object_has_member(entry, "linkTo") && !JSON_NODE_HOLDS_NULL(json_object_get_member(entry, "linkTo"))) {
        const gchar* lt = json_object_get_string_member(entry, "linkTo");
        if (lt) in->link_to = lt;
    }
    if (json_object_has_member(entry, "ignorePids") && JSON_NODE_HOLDS_ARRAY(json_object_get_member(entry, "ignorePids"))) {
        JsonArray* a = json_object_get_array_member(entry, "ignorePids");
        for (guint i = 0; i < json_array_get_length(a); i++) in->ignore.insert((int)json_array_get_int_element(a, i));
    }
    if (json_object_has_member(entry, "pcr") && JSON_NODE_HOLDS_OBJECT(json_object_get_member(entry, "pcr"))) {
        JsonObject* pcr = json_object_get_object_member(entry, "pcr");
        in->has_pcr = true;
        in->pcr_program = json_object_has_member(pcr, "program") ? (int)json_object_get_int_member(pcr, "program") : 1;
        if (!in->link_to.empty()) g_state->pcr.erase(in->link_to);
    }
    if (json_object_has_member(entry, "pid") && !JSON_NODE_HOLDS_NULL(json_object_get_member(entry, "pid")))
        in->pid = (int)json_object_get_int_member(entry, "pid");
    gulong id = g_signal_connect_data(src, "pad-added", G_CALLBACK(on_pad_added), new std::shared_ptr<Input>(in),
                                      delete_input_holder, (GConnectFlags)0);
    g_state->handlers.push_back({src, id});   // src ref kept until clear
    g_state->inputs.push_back(in);
    g_state->by_demux[demux_name] = in;
}

}  // namespace

extern "C" {

int mr_hook_abi(void) { return MR_HOOK_ABI; }

int mr_hook_install(GstElement* pipeline, const char* config_json, const MrHookCtx* ctx) {
    mr_hook_clear();
    g_state = std::make_unique<State>();
    g_state->ctx = ctx;
    if (!pipeline || !GST_IS_BIN(pipeline)) return 1;
    JsonParser* parser = json_parser_new();
    if (config_json && json_parser_load_from_data(parser, config_json, -1, nullptr)) {
        JsonNode* root = json_parser_get_root(parser);
        if (root && JSON_NODE_HOLDS_OBJECT(root)) {
            JsonObject* cfg = json_node_get_object(root);
            if (json_object_has_member(cfg, "inputs") && JSON_NODE_HOLDS_ARRAY(json_object_get_member(cfg, "inputs"))) {
                JsonArray* inputs = json_object_get_array_member(cfg, "inputs");
                // Every input's own PID is off limits to every other input's spill.
                for (int r : RESERVED_PIDS) g_state->taken.insert(r);
                for (guint i = 0; i < json_array_get_length(inputs); i++) {
                    JsonNode* n = json_array_get_element(inputs, i);
                    if (!JSON_NODE_HOLDS_OBJECT(n)) continue;
                    JsonObject* e = json_node_get_object(n);
                    if (json_object_has_member(e, "pid") && !JSON_NODE_HOLDS_NULL(json_object_get_member(e, "pid")))
                        g_state->taken.insert((int)json_object_get_int_member(e, "pid"));
                }
                for (guint i = 0; i < json_array_get_length(inputs); i++) {
                    JsonNode* n = json_array_get_element(inputs, i);
                    if (JSON_NODE_HOLDS_OBJECT(n)) install_input(pipeline, json_node_get_object(n));
                }
            }
        }
    }
    g_object_unref(parser);
    bool any_generic = false;
    for (const auto& in : g_state->inputs)
        if (in->pid >= 0) any_generic = true;
    if (any_generic) {
        gst_mpegts_initialize();
        GstBus* bus = gst_element_get_bus(pipeline);
        if (bus) {
            gst_bus_enable_sync_message_emission(bus);
            g_state->bus = bus;
            g_state->bus_handler = g_signal_connect(bus, "sync-message::element", G_CALLBACK(on_sync_message), nullptr);
        }
    }
    return 0;
}

void mr_hook_clear(void) {
    if (!g_state) return;
    for (auto& st : g_state->sparse) {
        if (st->timer) {
            g_source_remove(st->timer);
            st->timer = 0;
        }
        if (st->pad) gst_object_unref(st->pad);
        st->pad = nullptr;
    }
    for (auto& [el, id] : g_state->handlers) {
        g_signal_handler_disconnect(el, id);
        gst_object_unref(el);
    }
    if (g_state->bus) {
        g_signal_handler_disconnect(g_state->bus, g_state->bus_handler);
        gst_bus_disable_sync_message_emission(g_state->bus);
        gst_object_unref(g_state->bus);
        g_state->bus = nullptr;
    }
    for (auto& in : g_state->inputs)
        if (in->routes) json_object_unref(in->routes);
    g_state.reset();
}

}  // extern "C"
