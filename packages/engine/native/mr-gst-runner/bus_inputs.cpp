#include "bus_inputs.h"

#include <set>
#include <string>

#include "ipc.h"
#include "json_util.h"
#include "runner.h"
#include "source_gate.h"

namespace mr::inputs {

namespace {

/** Live branch bins: the start payload's list plus adds, minus removes/drops. */
std::set<std::string> g_live;

/** Free a bin that was never added to a parent (parse result is floating). */
void drop_floating(GstElement* bin) {
    gst_object_ref_sink(bin);
    gst_object_unref(bin);
}

/** `{event, name, id?}` reply of a tracked add/remove. */
void emit_done(const char* event, const std::string& name, const std::string& req_id) {
    JsonObject* ev = ipc::event(event);
    json_object_set_string_member(ev, "name", name.c_str());
    if (!req_id.empty()) json_object_set_string_member(ev, "id", req_id.c_str());
    ipc::emit(ev);
}

/**
 * Stop the branch (the pushing side — NULL ends its thread; no pad probe,
 * one on its own src pad would deadlock the NULL join), unlink it, release
 * the aggregator's request pad (found through the link; `agg` when given
 * must own it), drop the bin.
 */
void remove_bin(GstElement* bin, GstElement* agg_or_null) {
    gate::forget_sources_in(bin);
    gst_element_set_state(bin, GST_STATE_NULL);
    GstPad* src = gst_element_get_static_pad(bin, "src");
    GstPad* agg_pad = src ? gst_pad_get_peer(src) : nullptr;
    if (src && agg_pad) gst_pad_unlink(src, agg_pad);
    if (src) gst_object_unref(src);
    if (agg_pad) {
        GstObject* owner = gst_pad_get_parent(agg_pad);
        if (owner && GST_IS_ELEMENT(owner) && (!agg_or_null || owner == GST_OBJECT(agg_or_null)))
            gst_element_release_request_pad(GST_ELEMENT(owner), agg_pad);
        if (owner) gst_object_unref(owner);
        gst_object_unref(agg_pad);
    }
    GstObject* parent = gst_object_get_parent(GST_OBJECT(bin));
    if (parent && GST_IS_BIN(parent)) gst_bin_remove(GST_BIN(parent), bin);
    if (parent) gst_object_unref(parent);
}

}  // namespace

void declare(JsonArray* names) {
    g_live.clear();
    if (!names) return;
    guint n = json_array_get_length(names);
    for (guint i = 0; i < n; i++) {
        const gchar* s = json_array_get_string_element(names, i);
        if (s && *s) g_live.insert(s);
    }
}

void clear() { g_live.clear(); }

bool is_live_branch(const std::string& name) { return g_live.count(name) > 0; }

std::string live_branch_ancestor(GstObject* obj) {
    if (!obj || g_live.empty()) return "";
    GstObject* cur = GST_OBJECT(gst_object_ref(obj));
    while (cur) {
        const gchar* name = GST_OBJECT_NAME(cur);
        if (name && g_live.count(name)) {
            std::string out = name;
            gst_object_unref(cur);
            return out;
        }
        GstObject* parent = gst_object_get_parent(cur);
        gst_object_unref(cur);
        cur = parent;
    }
    return "";
}

bool drop_branch(const std::string& name) {
    Runner& r = runner();
    g_live.erase(name);
    if (!r.pipeline || !GST_IS_BIN(r.pipeline)) return false;
    GstElement* bin = gst_bin_get_by_name(GST_BIN(r.pipeline), name.c_str());
    if (!bin) return false;
    remove_bin(bin, nullptr);
    gst_object_unref(bin);
    return true;
}

void handle_bus_input_add(JsonObject* data) {
    Runner& r = runner();
    std::string req_id = json_get_string(data, "id");
    std::string element = json_get_string(data, "element");
    std::string name = json_get_string(data, "name");
    std::string desc = json_get_string(data, "description");
    if (!r.pipeline || !GST_IS_BIN(r.pipeline)) {
        ipc::command_error(req_id, "bus_input_add: no pipeline");
        return;
    }
    if (element.empty() || name.empty() || desc.empty()) {
        ipc::command_error(req_id, "bus_input_add: element, name and description required");
        return;
    }
    // Idempotent: already present = the requested state (the producer-PLAYING
    // re-link and the connection re-apply can race for one edge).
    if (GstElement* dup = gst_bin_get_by_name(GST_BIN(r.pipeline), name.c_str())) {
        gst_object_unref(dup);
        g_live.insert(name);
        ipc::log("bus_input_add: " + name + " already present — no-op");
        emit_done("bus_input_add_done", name, req_id);
        return;
    }
    GstElement* agg = gst_bin_get_by_name(GST_BIN(r.pipeline), element.c_str());
    if (!agg) {
        ipc::command_error(req_id, "bus_input_add: element '" + element + "' not found");
        return;
    }

    // ghost_unlinked_pads=FALSE: auto-ghosting would claim the capsfilter's
    // unlinked sink pad behind tsdemux's delayed link. Ghost the tail by hand.
    GError* err = nullptr;
    GstElement* bin = gst_parse_bin_from_description(desc.c_str(), FALSE, &err);
    if (!bin) {
        ipc::command_error(req_id, std::string("bus_input_add: parse failed: ") +
                                       (err && err->message ? err->message : "?"));
        g_clear_error(&err);
        gst_object_unref(agg);
        return;
    }
    g_clear_error(&err);
    gst_element_set_name(bin, name.c_str());
    GstPad* tail = gst_bin_find_unlinked_pad(GST_BIN(bin), GST_PAD_SRC);
    if (!tail) {
        ipc::command_error(req_id, "bus_input_add: branch '" + name + "' has no unlinked src pad");
        drop_floating(bin);
        gst_object_unref(agg);
        return;
    }
    GstPad* ghost = gst_ghost_pad_new("src", tail);
    gst_object_unref(tail);
    gst_pad_set_active(ghost, TRUE);
    gst_element_add_pad(bin, ghost);

    // Same parent bin as the aggregator (a cross-bin link cannot be made).
    GstObject* parent_obj = gst_object_get_parent(GST_OBJECT(agg));
    GstBin* parent = parent_obj && GST_IS_BIN(parent_obj) ? GST_BIN(parent_obj) : GST_BIN(r.pipeline);
    gst_bin_add(parent, bin);  // sinks the floating ref

    GstPad* agg_pad = gst_element_request_pad_simple(agg, "sink_%u");
    if (!agg_pad) {
        gst_bin_remove(parent, bin);
        if (parent_obj) gst_object_unref(parent_obj);
        gst_object_unref(agg);
        ipc::command_error(req_id, "bus_input_add: no request pad on '" + element + "'");
        return;
    }
    GstPadLinkReturn lr = gst_pad_link(ghost, agg_pad);
    if (lr != GST_PAD_LINK_OK) {
        gst_element_release_request_pad(agg, agg_pad);
        gst_object_unref(agg_pad);
        gst_bin_remove(parent, bin);
        if (parent_obj) gst_object_unref(parent_obj);
        gst_object_unref(agg);
        ipc::command_error(req_id, "bus_input_add: link failed (" + std::to_string((int)lr) + ")");
        return;
    }
    gst_object_unref(agg_pad);
    if (parent_obj) gst_object_unref(parent_obj);
    gst_object_unref(agg);

    // Link first, then run: a source-headed branch pushes as soon as it plays.
    gst_element_sync_state_with_parent(bin);
    g_live.insert(name);
    ipc::log("bus_input_add: " + name + " -> " + element);
    emit_done("bus_input_add_done", name, req_id);
}

void handle_bus_input_remove(JsonObject* data) {
    Runner& r = runner();
    std::string req_id = json_get_string(data, "id");
    std::string element = json_get_string(data, "element");
    std::string name = json_get_string(data, "name");
    if (!r.pipeline || !GST_IS_BIN(r.pipeline)) {
        ipc::command_error(req_id, "bus_input_remove: no pipeline");
        return;
    }
    if (element.empty() || name.empty()) {
        ipc::command_error(req_id, "bus_input_remove: element and name required");
        return;
    }
    // Idempotent: already gone (dropped as input_branch_lost) = the requested state.
    GstElement* bin = gst_bin_get_by_name(GST_BIN(r.pipeline), name.c_str());
    if (!bin) {
        g_live.erase(name);
        ipc::log("bus_input_remove: " + name + " already gone — no-op");
        emit_done("bus_input_remove_done", name, req_id);
        return;
    }
    GstElement* agg = gst_bin_get_by_name(GST_BIN(r.pipeline), element.c_str());
    if (!agg) {
        gst_object_unref(bin);
        ipc::command_error(req_id, "bus_input_remove: element '" + element + "' not found");
        return;
    }
    remove_bin(bin, agg);
    g_live.erase(name);
    gst_object_unref(bin);
    gst_object_unref(agg);
    ipc::log("bus_input_remove: " + name + " removed from " + element);
    emit_done("bus_input_remove_done", name, req_id);
}

}  // namespace mr::inputs
