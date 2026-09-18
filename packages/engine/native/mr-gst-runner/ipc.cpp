#include "ipc.h"

#include <fcntl.h>
#include <glib.h>
#include <unistd.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>

#include "json_util.h"

namespace mr::ipc {

namespace {

int g_cmd_fd = 0;      // stdin, or 3 in data-pipe mode
int g_event_fd = 2;    // stderr, or 4 in data-pipe mode
std::mutex g_write_lock;

void write_all(int fd, const std::string& s) {
    size_t off = 0;
    while (off < s.size()) {
        ssize_t n = ::write(fd, s.data() + off, s.size() - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            return;  // parent gone (EPIPE) — nothing to report to
        }
        off += (size_t)n;
    }
}

struct Dispatch {
    void (*fn)(JsonObject*);
    JsonObject* obj;
};

gboolean dispatch_idle(gpointer data) {
    auto* d = static_cast<Dispatch*>(data);
    d->fn(d->obj);
    json_object_unref(d->obj);
    delete d;
    return G_SOURCE_REMOVE;
}

gboolean eof_idle(gpointer data) {
    reinterpret_cast<void (*)()>(data)();
    return G_SOURCE_REMOVE;
}

}  // namespace

void init() {
    // fd 3 present → data-pipe mode (commands on 3, events on 4); otherwise
    // commands on stdin, events on stderr. Same probe as the python runner.
    if (fcntl(3, F_GETFD) != -1 && fcntl(4, F_GETFD) != -1) {
        g_cmd_fd = 3;
        g_event_fd = 4;
    }
}

void emit(JsonObject* obj) {
    std::string line = "GST_JSON:" + json_object_to_string(obj) + "\n";
    json_object_unref(obj);
    std::lock_guard<std::mutex> lock(g_write_lock);
    write_all(g_event_fd, line);
}

JsonObject* event(const char* name) {
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "event", name);
    return o;
}

void warning(const std::string& message) {
    JsonObject* o = event("warning");
    json_object_set_string_member(o, "message", message.c_str());
    emit(o);
}

void command_error(const std::string& req_id, const std::string& message) {
    JsonObject* o = event("command_error");
    json_object_set_string_member(o, "message", message.c_str());
    if (!req_id.empty()) json_object_set_string_member(o, "id", req_id.c_str());
    emit(o);
}

void log(const std::string& line) {
    std::string out = "[mr-gst-runner] " + line + "\n";
    std::lock_guard<std::mutex> lock(g_write_lock);
    write_all(2, out);
}

void logf(const char* fmt, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    log(buf);
}

void start_reader(void (*dispatch)(JsonObject*), void (*on_eof)()) {
    std::thread([dispatch, on_eof] {
        FILE* f = fdopen(g_cmd_fd, "r");
        if (f) {
            char* line = nullptr;
            size_t cap = 0;
            ssize_t n;
            while ((n = getline(&line, &cap, f)) >= 0) {
                std::string s(line, (size_t)n);
                while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' '))
                    s.pop_back();
                if (s.empty()) continue;
                std::string err;
                JsonObject* obj = json_parse_object(s, &err);
                if (!obj) {
                    // No id available — log only; never tear the pipeline down
                    // for a bad parent message.
                    command_error("", "Invalid JSON command: " + s);
                    continue;
                }
                g_idle_add(dispatch_idle, new Dispatch{dispatch, obj});
            }
            free(line);
        }
        // Input closed — shut down (the parent is gone or told us to stop).
        g_idle_add(eof_idle, reinterpret_cast<gpointer>(on_eof));
    }).detach();
}

}  // namespace mr::ipc
