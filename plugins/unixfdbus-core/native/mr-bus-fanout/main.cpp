// mr-bus-fanout — native GstUnixFd fan-out sidecar for non-GStreamer bus
// producers (hls-player). It ingests raw TS, moves it onto house time
// (house_rebase.h), stamps each buffer by identity and serves the consumer
// edges. stdin verbs bus_attach / bus_detach; stdout events ready / attached /
// detached / warning / error, and stats every 2 s.
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
#include "house_rebase.h"
#include "mrts/lateness.h"
#include "mrts/ts_house.h"

using namespace mrbus;

static volatile sig_atomic_t g_stop = 0;

int main(int argc, char** argv) {
    std::string ingest_path, caps;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        const bool known = a == "--ingest" || a == "--caps";
        if (known && i + 1 < argc) {
            (a == "--ingest" ? ingest_path : caps) = argv[++i];
        } else {
            std::fprintf(stderr, known ? "missing value for %s\n" : "unknown arg: %s\n", a.c_str());
            ingest_path.clear();
            break;
        }
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
    // The TS onto house time, then every buffer stamped PES - 1 h (P3).
    mrfanout::HouseRebase rebase;
    mrts::IdentityStamp identity;
    std::vector<uint8_t> out;
    // Lateness of what we write (§9.5): now - stamp.
    mrts::LatenessWindow lateness(STATS_INTERVAL_NS);
    Ingest ingest(ingest_path,
                  [&](const uint8_t* d, size_t n) {
                      const int64_t now = mono_ns();
                      rebase.process(d, n, now, out);
                      if (out.empty()) return;
                      const int64_t pts = identity.stamp(out.data(), out.size(), now);
                      lateness.add(now - pts);
                      // A raw-TS ingest carries no buffer flags.
                      server.broadcast(out.data(), out.size(), pts, 0);
                  },
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
            const mrfanout::HouseRebase::Stats rs = rebase.stats();
            char shift[32] = "null";
            if (rs.anchored) std::snprintf(shift, sizeof shift, "%.3f", (double)rs.shift_90k / 90.0);
            const std::string rb = ",\"rebase\":{\"shiftMs\":" + std::string(shift) +
                                   ",\"reanchors\":" + std::to_string(rs.reanchors) +
                                   ",\"kept\":" + std::to_string(rs.kept) +
                                   ",\"dropped\":" + std::to_string(rs.dropped) +
                                   ",\"desyncBytes\":" + std::to_string(rs.desync_bytes) + "}";
            std::string lat = lateness.empty()
                                  ? ""
                                  : ",\"lateness\":" + mrts::lateness_json_ms(lateness.take(now));
            emit("{\"stats\":{\"clients\":" + std::to_string(server.client_count()) +
                 ",\"drops\":{" + drops + "}" + rb + lat + "}}");
        }
    }
    server.detach_all();
    ingest.cleanup();
    return 0;
}
