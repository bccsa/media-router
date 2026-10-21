#include "native_plugins.h"

#include <gst/gst.h>

#include <algorithm>
#include <cctype>
#include <set>

#include "ipc.h"
#include "paths.h"

namespace mr::native_plugins {

namespace {

constexpr size_t NPOS = std::string::npos;

/** One plugin .so of the timing path, resolved as plugins/<plugin>/native/<tool>/<file> then
 *  libexec/<plugin>/<file>. `required`: a miss is the module alarm, not just a log line. */
struct Row {
    const char* plugin;
    const char* tool;
    const char* file;
    bool required;
    int min_abi;
    std::vector<Factory> factories;   // a phase adds its element here, with its stand-in
};

const std::vector<Row>& table() {
    static const std::vector<Row> rows = {
        {"mpegts-core", "mrtshouse", "libgstmrtshouse.so", true, MRTSHOUSE_MIN_ABI,
         {{"mrtsrestamp", "identity"}, {"mrtsdemux", nullptr}, {"mralignwatch", "identity"}}},
    };
    return rows;
}

struct Outcome {
    bool loaded = false;
    std::string version, path;
    int abi = 0;
    std::string detail;   // why it is not loaded: the tried paths, or both ABI numbers
};

std::vector<Outcome> g_outcomes;   // per table row; empty until load()
std::set<std::string> g_stand_ins;

/** The `abi` every element of the plugin carries (WI-S0-7); 0 for a plugin without it. */
int plugin_abi(GstPlugin* plugin) {
    int abi = 0;
    GList* features = gst_registry_get_feature_list_by_plugin(gst_registry_get(),
                                                              gst_plugin_get_name(plugin));
    for (GList* l = features; l; l = l->next) {
        if (!GST_IS_ELEMENT_FACTORY(l->data)) continue;
        GstElement* el = gst_element_factory_create(GST_ELEMENT_FACTORY(l->data), nullptr);
        if (!el) continue;
        gst_object_ref_sink(el);
        GParamSpec* ps = g_object_class_find_property(G_OBJECT_GET_CLASS(el), "abi");
        if (ps && ps->value_type == G_TYPE_INT) g_object_get(el, "abi", &abi, nullptr);
        gst_object_unref(el);
        break;
    }
    gst_plugin_feature_list_free(features);
    return abi;
}

Outcome load_row(const Row& row) {
    Outcome out;
    std::string tried;
    for (const std::string& path : paths::asset_candidates(row.plugin, row.tool, row.file)) {
        if (!tried.empty()) tried += ", ";
        tried += path;
        if (!g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) continue;
        GError* err = nullptr;
        GstPlugin* plugin = gst_plugin_load_file(path.c_str(), &err);
        if (!plugin) {
            tried += std::string(" (") + (err && err->message ? err->message : "failed") + ")";
            g_clear_error(&err);
            continue;
        }
        const int abi = plugin_abi(plugin);
        if (abi < row.min_abi) {
            // Out of the registry, so nothing can instantiate its elements. No later candidate
            // is tried: its types would collide with the ones this file registered.
            gst_registry_remove_plugin(gst_registry_get(), plugin);
            gst_object_unref(plugin);
            out.detail = std::string(row.file) + " abi " + std::to_string(abi) + " < " +
                         std::to_string(row.min_abi) + ": " + path;
            return out;
        }
        out.loaded = true;
        out.version = gst_plugin_get_version(plugin);
        out.abi = abi;
        out.path = path;
        ipc::logf("native plugin %s %s abi %d from %s", gst_plugin_get_name(plugin),
                  out.version.c_str(), abi, path.c_str());
        gst_object_unref(plugin);
        return out;
    }
    out.detail = std::string(row.file) + " not loaded, tried " + tried;
    return out;
}

/** The rule-6 event (`warning` or `error`) with its detail; the engine keys on `kind`. */
void emit_alarm(const char* event, const std::string& detail) {
    const std::string message = std::string(ALARM) + " (" + detail + ")";
    JsonObject* ev = ipc::event(event);
    json_object_set_string_member(ev, "kind", "timing_plugin");
    json_object_set_string_member(ev, "message", message.c_str());
    json_object_set_string_member(ev, "detail", detail.c_str());
    ipc::emit(ev);
}

// --- gst-launch tokens (gst/parse/parse.l, as far as finding elements needs) ---------------

enum class Kind { Element, Assign, Other };

struct Token {
    Kind kind;
    size_t begin, end;
    size_t key_end = 0;   // Assign: key = [begin, key_end), value = [value, end)
    size_t value = 0;
};

bool is_space(char c) { return std::isspace((unsigned char)c) != 0; }
bool is_alnum(char c) { return std::isalnum((unsigned char)c) != 0; }
bool ident_start(char c) { return is_alnum(c) || c == '_'; }
bool ident_char(char c) { return is_alnum(c) || c == '_' || c == '-' || c == '%' || c == ':'; }
bool mime_char(char c) { return is_alnum(c) || c == '-'; }

/** Past the quote closing the one at `i`, or NPOS when it never closes. */
size_t quote_end(const std::string& s, size_t i) {
    for (size_t j = i + 1; j < s.size(); j++) {
        if (s[j] == '\\') j++;
        else if (s[j] == s[i]) return j + 1;
    }
    return NPOS;
}

/** Past a value: a quoted string, else a run of non-space where a backslash escapes one. */
size_t value_end(const std::string& s, size_t i) {
    if (i < s.size() && (s[i] == '"' || s[i] == '\'')) {
        const size_t e = quote_end(s, i);
        if (e != NPOS) return e;
    }
    while (i < s.size() && !is_space(s[i])) i += (s[i] == '\\' && i + 1 < s.size()) ? 2 : 1;
    return i;
}

/** A caps filter (`type/subtype…`) at `i` runs to the next `!` outside quotes; else NPOS. */
size_t caps_end(const std::string& s, size_t i) {
    size_t j = i;
    while (j < s.size() && mime_char(s[j])) j++;
    if (j == i || j + 1 >= s.size() || s[j] != '/' || !mime_char(s[j + 1])) return NPOS;
    while (j < s.size() && s[j] != '!') {
        if (s[j] == '"' || s[j] == '\'') {
            const size_t e = quote_end(s, j);
            j = e == NPOS ? s.size() : e;
        } else {
            j += (s[j] == '\\' && j + 1 < s.size()) ? 2 : 1;
        }
    }
    return j;
}

size_t ident_end(const std::string& s, size_t i) {
    while (i < s.size() && ident_char(s[i])) i++;
    return i;
}

/** The token at `i`, which is not a space. */
Token next_token(const std::string& s, size_t i) {
    const char c = s[i];
    if (c == '!' || c == '(' || c == ')') return {Kind::Other, i, i + 1};
    if (const size_t e = caps_end(s, i); e != NPOS) return {Kind::Other, i, e};
    if (c == '.') return {Kind::Other, i, ident_end(s, i + 1)};   // `.pad`
    if (!ident_start(c)) return {Kind::Other, i, std::max(value_end(s, i), i + 1)};
    const size_t j = ident_end(s, i);
    size_t k = j;
    while (k < s.size() && is_space(s[k])) k++;
    if (k < s.size() && s[k] == '=') {   // `key=value`, spaces allowed around `=`
        size_t v = k + 1;
        while (v < s.size() && is_space(s[v])) v++;
        return {Kind::Assign, i, value_end(s, v), j, v};
    }
    // `name.` or `name.pad` is a reference to an element, not one.
    if (j < s.size() && s[j] == '.') return {Kind::Other, i, ident_end(s, j + 1)};
    return {Kind::Element, i, j};
}

std::vector<Token> tokenize(const std::string& s) {
    std::vector<Token> out;
    for (size_t i = 0; i < s.size();) {
        if (is_space(s[i])) {
            i++;
            continue;
        }
        out.push_back(next_token(s, i));
        i = out.back().end;
    }
    return out;
}

/** A `name=` value as GStreamer reads it: a leading double quote and the last character off,
 *  then backslashes outside quotes dropped (gst_parse_unescape). */
std::string unescape(std::string v) {
    if (v.size() >= 2 && v.front() == '"') v = v.substr(1, v.size() - 2);
    std::string out;
    bool quoted = false;
    for (size_t i = 0; i < v.size(); i++) {
        if (v[i] == '\\' && !quoted) {
            if (++i >= v.size()) break;
        } else if (v[i] == '"' && (!quoted || v[i - 1] != '\\')) {
            quoted = !quoted;
        }
        out += v[i];
    }
    return out;
}

}  // namespace

Rewrite rewrite(const std::string& s, const std::vector<Factory>& table) {
    Rewrite r;
    const std::vector<Token> toks = tokenize(s);
    size_t last = 0;   // s before this is in r.desc already
    for (size_t t = 0; t < toks.size(); t++) {
        if (toks[t].kind != Kind::Element) continue;
        const Factory* f = nullptr;
        for (const Factory& x : table) {
            if (s.compare(toks[t].begin, toks[t].end - toks[t].begin, x.name) == 0) {
                f = &x;
                break;
            }
        }
        if (!f) continue;
        if (!f->stand_in) return Rewrite{"", {}, f->name};
        r.desc.append(s, last, toks[t].begin - last).append(f->stand_in);
        last = toks[t].end;
        // Its properties follow it; `name=` stays (with the space before it), the rest go.
        std::string name;
        bool named = false;   // the first `name=` wins, as in GStreamer
        size_t p = t + 1;
        for (; p < toks.size() && toks[p].kind == Kind::Assign; p++) {
            const Token& a = toks[p];
            if (a.key_end - a.begin == 4 && s.compare(a.begin, 4, "name") == 0) {
                if (!named) name = unescape(s.substr(a.value, a.end - a.value));
                named = true;
                r.desc.append(s, last, a.end - last);
            }
            last = a.end;
        }
        if (!name.empty()) r.names.push_back(name);
        t = p - 1;
    }
    r.desc.append(s, last, NPOS);
    return r;
}

void load() {
    if (!g_outcomes.empty()) return;
    for (const Row& row : table()) {
        g_outcomes.push_back(load_row(row));
        const Outcome& o = g_outcomes.back();
        if (o.loaded) continue;
        if (row.required) emit_alarm("warning", o.detail);
        else ipc::log(o.detail + " — its elements get stand-ins");
    }
}

JsonNode* timing_plugin_json() {
    // Row 0 is libgstmrtshouse.so.
    if (g_outcomes.empty() || !g_outcomes[0].loaded) return json_node_new(JSON_NODE_NULL);
    const Outcome& o = g_outcomes[0];
    JsonObject* obj = json_object_new();
    json_object_set_string_member(obj, "version", o.version.c_str());
    json_object_set_int_member(obj, "abi", o.abi);
    json_object_set_string_member(obj, "path", o.path.c_str());
    JsonNode* node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, obj);
    return node;
}

bool stand_in(std::string* desc) {
    std::vector<Factory> missing;
    for (size_t i = 0; i < g_outcomes.size(); i++)
        if (!g_outcomes[i].loaded)
            missing.insert(missing.end(), table()[i].factories.begin(), table()[i].factories.end());
    if (missing.empty()) return true;
    Rewrite r = rewrite(*desc, missing);
    if (!r.refused.empty()) {
        std::string detail;
        for (size_t i = 0; i < g_outcomes.size(); i++)
            for (const Factory& f : table()[i].factories)
                if (r.refused == f.name) detail = g_outcomes[i].detail;
        emit_alarm("error", detail + "; " + r.refused + " has no stand-in");
        return false;
    }
    if (r.desc != *desc) ipc::log("native TS module not loaded, parsing with stand-ins: " + r.desc);
    g_stand_ins.insert(r.names.begin(), r.names.end());
    *desc = r.desc;
    return true;
}

bool is_stand_in(const std::string& element) { return g_stand_ins.count(element) > 0; }

void refuse_live_add(const std::string& req_id, const std::string& desc,
                     const std::string& message) {
    // Every element of a plugin not loaded, as if none had a stand-in: what the parse missed.
    std::vector<Factory> missing;
    for (size_t i = 0; i < g_outcomes.size(); i++)
        if (!g_outcomes[i].loaded)
            for (const Factory& f : table()[i].factories) missing.push_back({f.name, nullptr});
    std::string detail;
    if (!missing.empty()) {
        const Rewrite r = rewrite(desc, missing);
        for (size_t i = 0; i < g_outcomes.size() && !r.refused.empty(); i++)
            for (const Factory& f : table()[i].factories)
                if (!g_outcomes[i].loaded && r.refused == f.name) detail = g_outcomes[i].detail;
    }
    if (detail.empty()) {
        ipc::command_error(req_id, message);
        return;
    }
    const std::string text = message + "; " + ALARM + " (" + detail + ")";
    JsonObject* ev = ipc::event("command_error");
    json_object_set_string_member(ev, "message", text.c_str());
    if (!req_id.empty()) json_object_set_string_member(ev, "id", req_id.c_str());
    json_object_set_string_member(ev, "kind", "timing_plugin");
    json_object_set_string_member(ev, "detail", detail.c_str());
    ipc::emit(ev);
}

}  // namespace mr::native_plugins
