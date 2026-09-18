// The runner's half of the engine protocol (see gst-pipeline-runner.py):
//   Commands: line-delimited JSON on stdin (bus-messages mode) or fd 3
//   Events:   line-delimited JSON on stderr, prefixed with "GST_JSON:", or fd 4
// Everything else written to stderr is a log line the engine forwards as-is.
#pragma once

#include <json-glib/json-glib.h>

#include <string>

namespace mr::ipc {

/** Pick the command/event fds (fd 3/4 when the parent opened them, stdin/stderr
 *  otherwise) — the same probe the python runner does. */
void init();

/** Emit one event line. Takes ownership of `obj`. Thread-safe. */
void emit(JsonObject* obj);

/** A fresh object with its `event` member set; the caller adds fields and emits. */
JsonObject* event(const char* name);

/** `{"event":"warning","message":…}`. */
void warning(const std::string& message);

/** Non-fatal RPC failure carrying the originating request id (may be empty). */
void command_error(const std::string& req_id, const std::string& message);

/** One log line on stderr: "[mr-gst-runner] <line>\n". Thread-safe. */
void log(const std::string& line);
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));

/** Start the command reader thread. `dispatch` runs on the GLib main context
 *  for every parsed command (ownership of the object passes to it); `on_eof`
 *  runs there once when the command pipe closes. */
void start_reader(void (*dispatch)(JsonObject*), void (*on_eof)());

}  // namespace mr::ipc
