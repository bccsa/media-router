// mr-tssplit — native TS splitter child process.
//
// Consumes one muxed TS from a bus edge socket (GstUnixFd client), routes
// packets per PID through the mrts SplitterCore, and serves each output PID
// as its own SPTS bus producer (GstUnixFd fan-out server per tee). Replaces
// the gst-pipeline-runner appsink/appsrc shell for the ts-splitter module.
//
// Control (stdin JSON lines, engine-compatible verbs):
//   {"cmd":"bus_attach","tee":"busout_<port>","socket":"<edge>"}
//   {"cmd":"bus_detach","socket":"<edge>"}
//   {"cmd":"reinput","socket":"<new input edge>"}   (make-before-break)
// Events (stdout JSON lines): ready, attached/detached, plugin_event
// (tssplit:discovered / tssplit:videoinfo — runner-identical payloads),
// input_stalled/input_resumed, desync, reinput_done/reinput_failed, stats.
//
// Usage: mr-tssplit --input <edge socket> --caps <BUS_TS_CAPS> [--ts-id 1]
//                   [--stall-ms 2000] --out 0x100:busout_40001[:0x1b] ...
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "../libmrbus/busproto.h"
#include "../libmrbus/control.h"
#include "app.h"

using namespace mrtssplit;

static volatile sig_atomic_t g_stop = 0;

int main(int argc, char** argv) {
    Options opts;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--input" && i + 1 < argc) {
            opts.input_socket = argv[++i];
        } else if (a == "--caps" && i + 1 < argc) {
            opts.caps = argv[++i];
        } else if (a == "--ts-id" && i + 1 < argc) {
            opts.ts_id = std::atoi(argv[++i]);
        } else if (a == "--stall-ms" && i + 1 < argc) {
            opts.stall_ns = (int64_t)std::atoll(argv[++i]) * 1'000'000;
        } else if (a == "--out" && i + 1 < argc) {
            // pid:tee[:stream_type], e.g. 0x100:busout_40001:0x1b
            std::string spec = argv[++i];
            size_t c1 = spec.find(':');
            if (c1 == std::string::npos) {
                std::fprintf(stderr, "bad --out spec: %s\n", spec.c_str());
                return 2;
            }
            size_t c2 = spec.find(':', c1 + 1);
            int pid = (int)std::strtol(spec.c_str(), nullptr, 0);
            std::string tee = spec.substr(c1 + 1, c2 == std::string::npos
                                                      ? std::string::npos
                                                      : c2 - c1 - 1);
            int stype = c2 == std::string::npos
                            ? -1
                            : (int)std::strtol(spec.c_str() + c2 + 1, nullptr, 0);
            opts.outputs.push_back({pid, tee});
            opts.stream_types.push_back(stype);
        } else {
            std::fprintf(stderr, "unknown arg: %s\n", a.c_str());
            return 2;
        }
    }
    if (opts.input_socket.empty() || opts.caps.empty()) {
        std::fprintf(stderr,
                     "usage: mr-tssplit --input <socket> --caps <caps> "
                     "[--ts-id N] [--stall-ms N] --out pid:tee[:stype] ...\n");
        return 2;
    }

    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa {};
    sa.sa_handler = [](int) { g_stop = 1; };
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

    App app(std::move(opts));

    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
    mrbus::LineReader control;
    // Ready = output listeners attachable + input retry loop running (NOT
    // input-connected: attach must work while the producer is still dark).
    mrbus::emit_line("{\"event\":\"ready\"}");

    std::vector<pollfd> fds;
    std::vector<std::string> lines;
    while (!g_stop && stdout_alive()) {
        fds.clear();
        fds.push_back({STDIN_FILENO, POLLIN, 0});
        app.prepare_poll(fds);
        if (poll(fds.data(), (nfds_t)fds.size(), 100) < 0 && errno != EINTR) break;
        for (const auto& p : fds) {
            if (!p.revents) continue;
            if (p.fd == STDIN_FILENO) {
                lines.clear();
                if (!control.read_lines(STDIN_FILENO, lines)) {
                    g_stop = 1;   // engine closed stdin — exit cleanly
                    break;
                }
                for (const auto& line : lines) {
                    if (line.empty()) continue;
                    std::map<std::string, std::string> cmd;
                    if (!mrbus::parse_flat_json(line, cmd)) {
                        mrbus::emit_line(
                            "{\"event\":\"warning\",\"message\":\"" +
                            mrbus::json_escape("bad control line: " + line.substr(0, 120)) +
                            "\"}");
                        continue;
                    }
                    if (cmd["cmd"] == "bus_attach" && !cmd["socket"].empty())
                        app.bus_attach(cmd["tee"], cmd["socket"]);
                    else if (cmd["cmd"] == "bus_detach" && !cmd["socket"].empty())
                        app.bus_detach(cmd["socket"]);
                    else if (cmd["cmd"] == "reinput" && !cmd["socket"].empty())
                        app.reinput(cmd["socket"]);
                }
                continue;
            }
            app.handle_poll(p);
        }
        app.tick(mrbus::mono_ns());
    }
    app.shutdown();
    return 0;
}
