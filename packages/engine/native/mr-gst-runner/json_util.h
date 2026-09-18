// JSON helpers for the runner protocol — thin wrappers over json-glib plus the
// GValue/GstStructure → JSON conversion the python runner does in
// `gst_structure_to_dict` / `_safe_value`.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <string>
#include <vector>

namespace mr {

/** One compact JSON line for `obj` (no trailing newline). Borrows `obj`. */
std::string json_object_to_string(JsonObject* obj);

/** Parse one line into an owned JsonObject, or nullptr (with `err` set). */
JsonObject* json_parse_object(const std::string& line, std::string* err);

/** GValue → owned JsonNode: numbers, bools, strings, enums (as int), nested
 *  structures, GValueArray / GstValueArray / GstValueList (as arrays); anything
 *  else is serialised to its gst string form, "?" when even that fails. */
JsonNode* gvalue_to_json(const GValue* v);

/** GstStructure → owned JsonNode (object), field by field. */
JsonNode* gst_structure_to_json(const GstStructure* s);

/** Numeric array GValue (level's `decay`/`peak`) → doubles; empty if not one. */
std::vector<double> gvalue_to_doubles(const GValue* v);

/** JSON value → GValue already initialised to a property's type. False when
 *  no sensible conversion exists (the caller falls back to deserialising the
 *  string form). */
bool json_to_gvalue(JsonNode* n, GValue* out);

/** JSON scalar → the string `gst_value_deserialize` expects. */
std::string json_node_to_gst_arg(JsonNode* n);

// --- member getters on a JsonObject (nullptr-safe, null-member-safe) ---
bool json_has(JsonObject* o, const char* key);
std::string json_get_string(JsonObject* o, const char* key, const std::string& def = "");
bool json_get_bool(JsonObject* o, const char* key, bool def = false);
gint64 json_get_int(JsonObject* o, const char* key, gint64 def = 0);
/** Member that is an object, or nullptr (borrowed). */
JsonObject* json_get_object(JsonObject* o, const char* key);
/** Member that is a non-empty array, or nullptr (borrowed). */
JsonArray* json_get_array(JsonObject* o, const char* key);

}  // namespace mr
