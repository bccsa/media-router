// mr-gst-runner — native GStreamer pipeline runner for Media Router (ADR-0019).
//
// Same process contract as gst-pipeline-runner.py: one pipeline per process,
// line-delimited JSON commands on stdin, `GST_JSON:`-prefixed events on
// stderr, exit 0 after `stop` / SIGTERM / a closed command pipe. The reason it
// exists is memory: the python runner's fixed cost is ~19 MB of interpreter
// and PyGObject per module (measured 10.9.16.50, 2026-09-16), this one's is
// the GStreamer graph alone.
#include <glib-unix.h>
#include <gst/gst.h>
#include <unistd.h>

#include <cstdio>
#include <thread>

#include "ipc.h"
#include "runner.h"

namespace {

void dispatch_command(JsonObject* obj) { mr::runner().dispatch(obj); }

void on_command_eof() { mr::runner().handle_stop(); }

gboolean on_signal(gpointer) {
    mr::runner().handle_stop();
    return G_SOURCE_CONTINUE;
}

}  // namespace

int main(int argc, char** argv) {
    // The generic pre-init prgname hook (`PipelineDescription.env`): a plugin
    // that needs a GLib program name set before GStreamer initialises.
    if (const char* prg = g_getenv("MR_GLIB_PRGNAME"))
        if (*prg) g_set_prgname(prg);
    gst_init(&argc, &argv);
    mr::ipc::init();

    mr::Runner& r = mr::runner();
    r.decoder_max_threads = (int)std::max<unsigned>(1, std::thread::hardware_concurrency());
    r.loop = g_main_loop_new(nullptr, FALSE);

    g_unix_signal_add(SIGTERM, on_signal, nullptr);
    g_unix_signal_add(SIGINT, on_signal, nullptr);
    signal(SIGPIPE, SIG_IGN);

    mr::ipc::emit(mr::ipc::event("ready"));
    mr::ipc::start_reader(dispatch_command, on_command_eof);

    g_main_loop_run(r.loop);

    // Last teardown before the hard exit (normally a no-op: handle_stop already
    // took the pipeline to NULL).
    std::fprintf(stderr, "[mr-gst-runner] Main loop exited (pipeline=%s)\n", r.pipeline ? "set" : "unset");
    if (r.pipeline && !r.stopping) r.teardown_pipeline(r.pipeline);
    std::fflush(stderr);
    // Skip process finalisation the way the python runner skips Py_Finalize:
    // streaming threads mid-unwind race the deinit; the runner is a disposable
    // child, the pipeline is NULL, and a hard exit is strictly safer here.
    _exit(0);
}
