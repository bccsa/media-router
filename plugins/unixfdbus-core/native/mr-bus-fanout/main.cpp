// mr-bus-fanout — native GstUnixFd fan-out sidecar for non-GStreamer bus
// producers. Drop-in replacement for unixfd-fanout.py: identical CLI
// (--ingest, --caps), identical stdin verbs (bus_attach / bus_detach),
// identical stdout events (ready / attached / detached / warning / error /
// stats every 2 s). The conformance suite (unixfdFanout.test.ts) runs both
// implementations against the same protocol clients.
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../libmrbus/busproto.h"
#include "../libmrbus/control.h"
#include "../libmrbus/fanout_server.h"
#include "../libmrbus/ingest.h"

using namespace mrbus;

static volatile sig_atomic_t g_stop = 0;

int main(int argc, char** argv) {
    std::string ingest_path, caps;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--ingest" && i + 1 < argc) ingest_path = argv[++i];
        else if (a == "--caps" && i + 1 < argc) caps = argv[++i];
    }
    if (ingest_path.empty() || caps.empty()) {
        std::fprintf(stderr, "usage: mr-bus-fanout --ingest <socket> --caps <caps>\n");
        return 2;
    }

    signal(SIGPIPE, SIG_IGN);
    // SIGTERM (ManagedProcess graceful stop) → clean exit so the socket paths
    // are unlinked instead of left stale for the next incarnation.
    struct sigaction sa {};
    sa.sa_handler = [](int) { g_stop = 1; };
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

    bool stdout_alive = true;
    auto emit = [&stdout_alive](const std::string& line) {
        if (stdout_alive && !emit_line(line)) stdout_alive = false;   // engine gone
    };

    FanoutServer server(caps, emit);
    Ingest ingest(ingest_path,
                  [&server](const uint8_t* d, size_t n) { server.broadcast(d, n); },
                  emit);
    if (!ingest.start()) return 1;

    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
    LineReader control;
    emit("{\"event\":\"ready\"}");

    int64_t last_stats = mono_ns();
    std::vector<pollfd> fds;
    std::vector<std::string> lines;
    while (!g_stop && stdout_alive) {
        fds.clear();
        fds.push_back({STDIN_FILENO, POLLIN, 0});
        ingest.prepare_poll(fds);
        server.prepare_poll(fds);
        if (poll(fds.data(), (nfds_t)fds.size(), FLUSH_INTERVAL_MS) < 0 && errno != EINTR)
            break;
        for (const auto& p : fds) {
            if (!p.revents) continue;
            if (p.fd == STDIN_FILENO) {
                lines.clear();
                if (!control.read_lines(STDIN_FILENO, lines)) {
                    g_stop = 1;   // engine closed stdin / died — exit cleanly
                    break;
                }
                for (const auto& line : lines) {
                    std::string trimmed = line;
                    while (!trimmed.empty() && (trimmed.back() == '\r' || trimmed.back() == ' '))
                        trimmed.pop_back();
                    if (trimmed.empty()) continue;
                    std::map<std::string, std::string> cmd;
                    if (!parse_flat_json(trimmed, cmd)) {
                        emit("{\"event\":\"warning\",\"message\":\"" +
                             json_escape("bad control line: " + trimmed.substr(0, 120)) +
                             "\"}");
                        continue;
                    }
                    if (cmd["cmd"] == "bus_attach" && !cmd["socket"].empty())
                        server.attach(cmd["socket"]);
                    else if (cmd["cmd"] == "bus_detach" && !cmd["socket"].empty())
                        server.detach(cmd["socket"]);
                }
                continue;
            }
            if (ingest.handle_poll(p)) continue;
            server.handle_poll(p);
        }
        int64_t now = mono_ns();
        ingest.maybe_flush_partial(now);
        if (now - last_stats >= STATS_INTERVAL_NS) {
            last_stats = now;
            std::string drops;
            for (const auto& [edge, n] : server.drops()) {
                if (!drops.empty()) drops += ",";
                drops += "\"" + json_escape(edge) + "\":" + std::to_string(n);
            }
            emit("{\"stats\":{\"clients\":" + std::to_string(server.client_count()) +
                 ",\"drops\":{" + drops + "}}}");
        }
    }
    server.detach_all();
    ingest.cleanup();
    return 0;
}
