#include "no_late_drop.h"

#include <gst/base/gstbasesink.h>
#include <gst/base/gstbasetransform.h>

#include <vector>

#include "ipc.h"

namespace mr::no_late_drop {

namespace {

/** Whether `el` is a `type`: none is before a loaded library registers that type. */
bool is_a(GstElement* el, const char* type) {
    GType t = g_type_from_name(type);
    return t && g_type_is_a(G_OBJECT_TYPE(el), t);
}

bool has_bool(GstElement* el, const char* prop) {
    GParamSpec* ps = g_object_class_find_property(G_OBJECT_GET_CLASS(el), prop);
    return ps && ps->value_type == G_TYPE_BOOLEAN && (ps->flags & G_PARAM_WRITABLE);
}

std::string join(const std::vector<std::string>& parts) {
    std::string s;
    for (const std::string& p : parts) s += (s.empty() ? "" : ", ") + p;
    return s;
}

void deep_added_cb(GstBin*, GstBin*, GstElement* el, gpointer) {
    const std::string changed = apply(el);
    if (!changed.empty()) ipc::log("no-late-drop: " + changed);
}

}  // namespace

std::string apply(GstElement* el) {
    std::vector<std::string> changed;
    if (GST_IS_BASE_SINK(el)) {
        GstBaseSink* sink = GST_BASE_SINK(el);
        if (gst_base_sink_is_qos_enabled(sink)) {
            gst_base_sink_set_qos_enabled(sink, FALSE);
            changed.push_back("qos→false");
        }
        if (gst_base_sink_get_max_lateness(sink) != -1) {
            gst_base_sink_set_max_lateness(sink, -1);
            changed.push_back("max-lateness→-1");
        }
    } else if ((GST_IS_BASE_TRANSFORM(el) || is_a(el, "GstVideoDecoder") || is_a(el, "GstAudioDecoder")) &&
               has_bool(el, "qos")) {
        gboolean qos = FALSE;
        g_object_get(el, "qos", &qos, nullptr);
        if (qos) {
            g_object_set(el, "qos", FALSE, nullptr);
            changed.push_back("qos→false");
        }
    }
    if (changed.empty()) return "";
    return std::string(GST_OBJECT_NAME(el)) + " " + join(changed);
}

void install(GstElement* pipe) {
    std::vector<std::string> changed;
    if (GST_IS_BIN(pipe)) {
        GstIterator* it = gst_bin_iterate_recurse(GST_BIN(pipe));
        GValue item = G_VALUE_INIT;
        for (bool done = false; !done;) {
            switch (gst_iterator_next(it, &item)) {
                case GST_ITERATOR_OK: {
                    const std::string c = apply(GST_ELEMENT(g_value_get_object(&item)));
                    if (!c.empty()) changed.push_back(c);
                    g_value_reset(&item);
                    break;
                }
                case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
                default: done = true; break;
            }
        }
        g_value_unset(&item);
        gst_iterator_free(it);
    }
    ipc::log("no-late-drop: " + (changed.empty() ? std::string("nothing to change") : join(changed)));
    g_signal_connect(pipe, "deep-element-added", G_CALLBACK(deep_added_cb), nullptr);
}

}  // namespace mr::no_late_drop
