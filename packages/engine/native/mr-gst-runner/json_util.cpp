#include "json_util.h"

#include <cmath>
#include <cstdio>

namespace mr {

std::string json_object_to_string(JsonObject* obj) {
    JsonGenerator* gen = json_generator_new();
    JsonNode* root = json_node_new(JSON_NODE_OBJECT);
    json_node_set_object(root, obj);  // refs obj
    json_generator_set_root(gen, root);
    gsize len = 0;
    gchar* data = json_generator_to_data(gen, &len);
    std::string out(data ? data : "", len);
    g_free(data);
    json_node_free(root);
    g_object_unref(gen);
    return out;
}

JsonObject* json_parse_object(const std::string& line, std::string* err) {
    JsonParser* parser = json_parser_new();
    GError* gerr = nullptr;
    JsonObject* out = nullptr;
    if (!json_parser_load_from_data(parser, line.c_str(), (gssize)line.size(), &gerr)) {
        if (err) *err = gerr && gerr->message ? gerr->message : "parse error";
        g_clear_error(&gerr);
    } else {
        JsonNode* root = json_parser_get_root(parser);
        if (root && JSON_NODE_HOLDS_OBJECT(root)) {
            out = json_object_ref(json_node_get_object(root));
        } else if (err) {
            *err = "not a JSON object";
        }
    }
    g_object_unref(parser);
    return out;
}

static JsonNode* node_int(gint64 v) {
    JsonNode* n = json_node_new(JSON_NODE_VALUE);
    json_node_set_int(n, v);
    return n;
}

static JsonNode* node_double(double v) {
    JsonNode* n = json_node_new(JSON_NODE_VALUE);
    // JSON has no NaN/Inf; python's json.dumps would emit NaN — serialise as null.
    if (!std::isfinite(v)) {
        json_node_free(n);
        return json_node_new(JSON_NODE_NULL);
    }
    json_node_set_double(n, v);
    return n;
}

static JsonNode* node_string(const char* s) {
    if (!s) return json_node_new(JSON_NODE_NULL);
    JsonNode* n = json_node_new(JSON_NODE_VALUE);
    json_node_set_string(n, s);
    return n;
}

JsonNode* gvalue_to_json(const GValue* v) {
    if (!v || !G_IS_VALUE(v)) return json_node_new(JSON_NODE_NULL);
    GType t = G_VALUE_TYPE(v);
    switch (G_TYPE_FUNDAMENTAL(t)) {
        case G_TYPE_BOOLEAN: {
            JsonNode* n = json_node_new(JSON_NODE_VALUE);
            json_node_set_boolean(n, g_value_get_boolean(v));
            return n;
        }
        case G_TYPE_CHAR: return node_int(g_value_get_schar(v));
        case G_TYPE_UCHAR: return node_int(g_value_get_uchar(v));
        case G_TYPE_INT: return node_int(g_value_get_int(v));
        case G_TYPE_UINT: return node_int(g_value_get_uint(v));
        case G_TYPE_LONG: return node_int(g_value_get_long(v));
        case G_TYPE_ULONG: return node_int((gint64)g_value_get_ulong(v));
        case G_TYPE_INT64: return node_int(g_value_get_int64(v));
        case G_TYPE_UINT64: return node_int((gint64)g_value_get_uint64(v));
        case G_TYPE_FLOAT: return node_double(g_value_get_float(v));
        case G_TYPE_DOUBLE: return node_double(g_value_get_double(v));
        case G_TYPE_STRING: return node_string(g_value_get_string(v));
        case G_TYPE_ENUM: return node_int(g_value_get_enum(v));
        case G_TYPE_FLAGS: return node_int(g_value_get_flags(v));
        default: break;
    }
    if (GST_VALUE_HOLDS_STRUCTURE(v)) return gst_structure_to_json(gst_value_get_structure(v));
    if (G_VALUE_HOLDS(v, G_TYPE_VALUE_ARRAY)) {
        GValueArray* arr = (GValueArray*)g_value_get_boxed(v);
        JsonArray* ja = json_array_new();
        for (guint i = 0; arr && i < arr->n_values; i++)
            json_array_add_element(ja, gvalue_to_json(&arr->values[i]));
        JsonNode* n = json_node_new(JSON_NODE_ARRAY);
        json_node_take_array(n, ja);
        return n;
    }
    if (GST_VALUE_HOLDS_ARRAY(v) || GST_VALUE_HOLDS_LIST(v)) {
        bool is_arr = GST_VALUE_HOLDS_ARRAY(v);
        guint size = is_arr ? gst_value_array_get_size(v) : gst_value_list_get_size(v);
        JsonArray* ja = json_array_new();
        for (guint i = 0; i < size; i++)
            json_array_add_element(
                ja, gvalue_to_json(is_arr ? gst_value_array_get_value(v, i)
                                          : gst_value_list_get_value(v, i)));
        JsonNode* n = json_node_new(JSON_NODE_ARRAY);
        json_node_take_array(n, ja);
        return n;
    }
    gchar* s = gst_value_serialize(v);
    JsonNode* n = node_string(s ? s : "?");
    g_free(s);
    return n;
}

JsonNode* gst_structure_to_json(const GstStructure* s) {
    JsonObject* o = json_object_new();
    if (s) {
        gint n = gst_structure_n_fields(s);
        for (gint i = 0; i < n; i++) {
            const gchar* name = gst_structure_nth_field_name(s, i);
            json_object_set_member(o, name, gvalue_to_json(gst_structure_get_value(s, name)));
        }
    }
    JsonNode* node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, o);
    return node;
}

static bool gvalue_number(const GValue* v, double* out) {
    switch (G_TYPE_FUNDAMENTAL(G_VALUE_TYPE(v))) {
        case G_TYPE_INT: *out = g_value_get_int(v); return true;
        case G_TYPE_UINT: *out = g_value_get_uint(v); return true;
        case G_TYPE_INT64: *out = (double)g_value_get_int64(v); return true;
        case G_TYPE_UINT64: *out = (double)g_value_get_uint64(v); return true;
        case G_TYPE_FLOAT: *out = g_value_get_float(v); return true;
        case G_TYPE_DOUBLE: *out = g_value_get_double(v); return true;
        default: return false;
    }
}

std::vector<double> gvalue_to_doubles(const GValue* v) {
    std::vector<double> out;
    if (!v || !G_IS_VALUE(v)) return out;
    if (G_VALUE_HOLDS(v, G_TYPE_VALUE_ARRAY)) {
        GValueArray* arr = (GValueArray*)g_value_get_boxed(v);
        for (guint i = 0; arr && i < arr->n_values; i++) {
            double d = 0;
            out.push_back(gvalue_number(&arr->values[i], &d) ? d : 0.0);
        }
        return out;
    }
    if (GST_VALUE_HOLDS_ARRAY(v) || GST_VALUE_HOLDS_LIST(v)) {
        bool is_arr = GST_VALUE_HOLDS_ARRAY(v);
        guint size = is_arr ? gst_value_array_get_size(v) : gst_value_list_get_size(v);
        for (guint i = 0; i < size; i++) {
            const GValue* e = is_arr ? gst_value_array_get_value(v, i) : gst_value_list_get_value(v, i);
            double d = 0;
            out.push_back(gvalue_number(e, &d) ? d : 0.0);
        }
    }
    return out;
}

std::string json_node_to_gst_arg(JsonNode* n) {
    if (!n || JSON_NODE_HOLDS_NULL(n)) return "";
    if (!JSON_NODE_HOLDS_VALUE(n)) return "";
    GType t = json_node_get_value_type(n);
    if (t == G_TYPE_BOOLEAN) return json_node_get_boolean(n) ? "true" : "false";
    if (t == G_TYPE_INT64) return std::to_string(json_node_get_int(n));
    if (t == G_TYPE_DOUBLE) {
        char buf[64];
        std::snprintf(buf, sizeof buf, "%.17g", json_node_get_double(n));
        return buf;
    }
    const gchar* s = json_node_get_string(n);
    return s ? s : "";
}

bool json_to_gvalue(JsonNode* n, GValue* out) {
    if (!n || !JSON_NODE_HOLDS_VALUE(n)) return false;
    GType jt = json_node_get_value_type(n);
    bool is_bool = jt == G_TYPE_BOOLEAN, is_int = jt == G_TYPE_INT64, is_dbl = jt == G_TYPE_DOUBLE;
    bool is_num = is_int || is_dbl;
    double d = is_int ? (double)json_node_get_int(n) : is_dbl ? json_node_get_double(n) : 0.0;
    gint64 i = is_int ? json_node_get_int(n) : is_dbl ? (gint64)json_node_get_double(n) : 0;
    switch (G_TYPE_FUNDAMENTAL(G_VALUE_TYPE(out))) {
        case G_TYPE_BOOLEAN:
            if (is_bool) { g_value_set_boolean(out, json_node_get_boolean(n)); return true; }
            if (is_num) { g_value_set_boolean(out, i != 0); return true; }
            return false;
        case G_TYPE_INT: if (!is_num && !is_bool) return false; g_value_set_int(out, is_bool ? json_node_get_boolean(n) : (gint)i); return true;
        case G_TYPE_UINT: if (!is_num) return false; g_value_set_uint(out, (guint)i); return true;
        case G_TYPE_LONG: if (!is_num) return false; g_value_set_long(out, (glong)i); return true;
        case G_TYPE_ULONG: if (!is_num) return false; g_value_set_ulong(out, (gulong)i); return true;
        case G_TYPE_INT64: if (!is_num) return false; g_value_set_int64(out, i); return true;
        case G_TYPE_UINT64: if (!is_num) return false; g_value_set_uint64(out, (guint64)i); return true;
        case G_TYPE_FLOAT: if (!is_num) return false; g_value_set_float(out, (float)d); return true;
        case G_TYPE_DOUBLE: if (!is_num) return false; g_value_set_double(out, d); return true;
        case G_TYPE_STRING: {
            std::string s = json_node_to_gst_arg(n);
            g_value_set_string(out, s.c_str());
            return true;
        }
        case G_TYPE_ENUM: if (!is_num) return false; g_value_set_enum(out, (gint)i); return true;
        case G_TYPE_FLAGS: if (!is_num) return false; g_value_set_flags(out, (guint)i); return true;
        default: return false;
    }
}

bool json_has(JsonObject* o, const char* key) {
    if (!o || !json_object_has_member(o, key)) return false;
    JsonNode* n = json_object_get_member(o, key);
    return n && !JSON_NODE_HOLDS_NULL(n);
}

std::string json_get_string(JsonObject* o, const char* key, const std::string& def) {
    if (!json_has(o, key)) return def;
    JsonNode* n = json_object_get_member(o, key);
    if (!JSON_NODE_HOLDS_VALUE(n)) return def;
    if (json_node_get_value_type(n) == G_TYPE_STRING) {
        const gchar* s = json_node_get_string(n);
        return s ? s : def;
    }
    return json_node_to_gst_arg(n);
}

bool json_get_bool(JsonObject* o, const char* key, bool def) {
    if (!json_has(o, key)) return def;
    JsonNode* n = json_object_get_member(o, key);
    if (!JSON_NODE_HOLDS_VALUE(n)) return def;
    GType t = json_node_get_value_type(n);
    if (t == G_TYPE_BOOLEAN) return json_node_get_boolean(n);
    if (t == G_TYPE_INT64) return json_node_get_int(n) != 0;
    if (t == G_TYPE_DOUBLE) return json_node_get_double(n) != 0.0;
    if (t == G_TYPE_STRING) {
        const gchar* s = json_node_get_string(n);
        return s && *s;  // python truthiness of a string
    }
    return def;
}

gint64 json_get_int(JsonObject* o, const char* key, gint64 def) {
    if (!json_has(o, key)) return def;
    JsonNode* n = json_object_get_member(o, key);
    if (!JSON_NODE_HOLDS_VALUE(n)) return def;
    GType t = json_node_get_value_type(n);
    if (t == G_TYPE_INT64) return json_node_get_int(n);
    if (t == G_TYPE_DOUBLE) return (gint64)json_node_get_double(n);
    if (t == G_TYPE_BOOLEAN) return json_node_get_boolean(n) ? 1 : 0;
    if (t == G_TYPE_STRING) {
        const gchar* s = json_node_get_string(n);
        if (!s) return def;
        char* end = nullptr;
        long long v = std::strtoll(s, &end, 10);
        return (end && end != s) ? (gint64)v : def;
    }
    return def;
}

JsonObject* json_get_object(JsonObject* o, const char* key) {
    if (!json_has(o, key)) return nullptr;
    JsonNode* n = json_object_get_member(o, key);
    return JSON_NODE_HOLDS_OBJECT(n) ? json_node_get_object(n) : nullptr;
}

JsonArray* json_get_array(JsonObject* o, const char* key) {
    if (!json_has(o, key)) return nullptr;
    JsonNode* n = json_object_get_member(o, key);
    if (!JSON_NODE_HOLDS_ARRAY(n)) return nullptr;
    JsonArray* a = json_node_get_array(n);
    return json_array_get_length(a) > 0 ? a : nullptr;
}

}  // namespace mr
