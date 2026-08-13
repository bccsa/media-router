#include "app.h"

#include <cstdio>

#include "libmrbus/busproto.h"
#include "libmrbus/control.h"

namespace mrtssplit {

using mrbus::emit_line;
using mrbus::json_escape;

namespace {

bool g_stdout_alive = true;

void emit(const std::string& line) {
    if (g_stdout_alive && !emit_line(line)) g_stdout_alive = false;
}

std::string json_double(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.10g", v);
    return buf;
}

// The exact payload shape gst-pipeline-runner.py emits for tssplit:videoinfo
// (unknown fields are JSON null; TsSplitterModule.onPluginEvent is unchanged).
std::string videoinfo_payload(int pid, const mrts::VideoInfo& v) {
    std::string display = mrts::format_video_info(v);
    std::string s = "{\"codec\":\"" + std::string(v.codec) + "\"";
    s += ",\"width\":" + (v.width ? std::to_string(*v.width) : "null");
    s += ",\"height\":" + (v.height ? std::to_string(*v.height) : "null");
    s += ",\"interlaced\":" +
         (v.interlaced ? std::string(*v.interlaced ? "true" : "false") : "null");
    s += ",\"fps\":" + (v.fps ? json_double(*v.fps) : "null");
    if (v.scrambled) s += ",\"scrambled\":true";
    s += ",\"pid\":" + std::to_string(pid);
    s += ",\"display\":" +
         (display.empty() ? std::string("null") : "\"" + json_escape(display) + "\"");
    return s + "}";
}

}  // namespace

bool stdout_alive() { return g_stdout_alive; }

App::App(Options opts) : opts_(std::move(opts)) {
    mrts::SplitterCallbacks cb;
    cb.on_discovered = [](const std::vector<std::pair<int, int>>& streams, int pcr_pid,
                          const std::vector<std::pair<int, std::vector<uint8_t>>>& es) {
        std::string s = "{\"event\":\"plugin_event\",\"channel\":\"tssplit:discovered\","
                        "\"payload\":{\"streams\":[";
        for (size_t i = 0; i < streams.size(); i++) {
            char hex[3];
            std::string es_hex;
            for (uint8_t b : es[i].second) {
                std::snprintf(hex, sizeof hex, "%02x", b);
                es_hex += hex;
            }
            s += std::string(i ? "," : "") + "{\"pid\":" + std::to_string(streams[i].first) +
                 ",\"streamType\":" + std::to_string(streams[i].second) + ",\"esInfo\":\"" +
                 es_hex + "\"}";
        }
        s += "],\"pcrPid\":" + std::to_string(pcr_pid) + "}}";
        emit(s);
    };
    cb.on_videoinfo = [](int pid, const mrts::VideoInfo& v) {
        emit("{\"event\":\"plugin_event\",\"channel\":\"tssplit:videoinfo\",\"payload\":" +
             videoinfo_payload(pid, v) + "}");
    };
    cb.on_desync = [](long long dropped) {
        emit("{\"event\":\"desync\",\"dropped\":" + std::to_string(dropped) + "}");
    };
    std::vector<mrts::SplitterCore::OutputSpec> specs;
    for (size_t i = 0; i < opts_.outputs.size(); i++) {
        specs.push_back({opts_.outputs[i].first, opts_.stream_types[i]});
        Output o;
        o.pid = opts_.outputs[i].first;
        o.tee = opts_.outputs[i].second;
        o.server = std::make_unique<mrbus::FanoutServer>(opts_.caps, emit);
        outputs_.push_back(std::move(o));
    }
    core_ = std::make_unique<mrts::SplitterCore>(opts_.ts_id, specs, cb);
    if (opts_.stamp_timeline) {
        // One event builder for every native producer (mrts::*_event_json), so
        // what a re-anchor reports here is field for field what the python
        // sidecar reports — the copies that used to live in each sidecar had
        // already lost `lastPts90k` and `deltaTicks`.
        stamper_ = std::make_unique<mrts::TimelineStamper>(
            [](const mrts::TimelineStamper::Anchored& a) {
                emit(mrts::anchor_event_json(a));
            },
            [](const mrts::TimelineStamper::Reanchor& r) {
                emit(mrts::reanchor_event_json(r));
            });
    }
    refresh_gating();   // nothing wired yet -> all outputs disabled
    input_ = std::make_unique<mrbus::BusClient>(
        opts_.input_socket, [this](const uint8_t* d, size_t n) { on_input_buffer(d, n); },
        opts_.stall_ns);
}

void App::on_input_buffer(const uint8_t* data, size_t len) {
    // Coalesce before broadcast: splitter batches arrive per input buffer
    // (~7-packet same-PID runs at typical A/V interleave — measured 692
    // buffers/s of ~1.3 KB on a 1080p50 feed), and every broadcast costs a
    // memfd + per-client fd-pass here plus mmap/munmap/close per buffer in
    // every consumer. Accumulating to BUFFER_BYTES (~24 KB ≈ 22 ms of a
    // typical video PID) cuts that to ~45/s for at most FLUSH_INTERVAL_MS of
    // added latency (time flush in flush_due, essential for low-rate PIDs —
    // audio would take seconds to fill a size batch). Packet order within an
    // output is preserved; PSI stays ahead of the ES packets it precedes.
    const int64_t now = mrbus::mono_ns();
    for (const auto& b : core_->feed(data, len)) {
        for (auto& o : outputs_) {
            if (o.pid == b.pid) {
                if (opts_.flush_ns <= 0) {
                    // Ultra-low-latency mode: no coalescing, no extra copy.
                    o.server->broadcast(b.data->data(), b.data->size(),
                                        stamp_for(o, b.data->data(), b.data->size()));
                    o.batches++;
                    break;
                }
                if (o.pending.empty()) o.pending_since_ns = now;
                o.pending.insert(o.pending.end(), b.data->begin(), b.data->end());
                if (o.pending.size() >= (size_t)mrbus::BUFFER_BYTES) flush_output(o);
                break;
            }
        }
    }
}

int64_t App::stamp_for(const Output& o, const uint8_t* data, size_t len) {
    if (!stamper_) return -1;   // send time, exactly as before the contract
    return stamper_->stamp(data, len, mrbus::mono_ns(), o.pid);
}

void App::flush_output(Output& o) {
    if (o.pending.empty()) return;
    o.server->broadcast(o.pending.data(), o.pending.size(),
                        stamp_for(o, o.pending.data(), o.pending.size()));
    o.batches++;
    o.pending.clear();
    o.pending_since_ns = 0;
}

void App::flush_due(int64_t now_ns) {
    for (auto& o : outputs_) {
        if (!o.pending.empty() && now_ns - o.pending_since_ns >= opts_.flush_ns)
            flush_output(o);
    }
}

void App::refresh_gating() {
    // Wired-only gating: an output is produced only while its tee has >= 1
    // attached edge (same rule as the runner's _bus_topology_version gate).
    std::vector<int> enabled;
    for (const auto& o : outputs_)
        if (o.server->edge_count() > 0) enabled.push_back(o.pid);
    core_->set_enabled(enabled);
}

void App::bus_attach(const std::string& tee, const std::string& socket_path) {
    for (size_t i = 0; i < outputs_.size(); i++) {
        if (outputs_[i].tee == tee) {
            outputs_[i].server->attach(socket_path);   // emits attached/error
            edge_owner_[socket_path] = i;
            refresh_gating();
            return;
        }
    }
    emit("{\"event\":\"warning\",\"message\":\"" +
         json_escape("bus_attach: unknown tee " + tee) + "\"}");
}

void App::bus_detach(const std::string& socket_path) {
    auto it = edge_owner_.find(socket_path);
    if (it == edge_owner_.end()) return;   // unknown detach is silent (parity)
    outputs_[it->second].server->detach(socket_path);
    edge_owner_.erase(it);
    refresh_gating();
}

void App::reinput(const std::string& socket_path) {
    // Make-before-break: connect the new edge first; the old input keeps
    // flowing until the swap. Failure keeps the old input untouched.
    pending_input_ = std::make_unique<mrbus::BusClient>(
        socket_path, [this](const uint8_t* d, size_t n) { on_input_buffer(d, n); },
        opts_.stall_ns);
    pending_deadline_ns_ = mrbus::mono_ns() + 5'000'000'000;
}

void App::add_output(int pid, const std::string& tee) {
    for (const auto& o : outputs_) {
        if (o.pid == pid || o.tee == tee) {
            // Idempotent: a replayed verb (or a respawn that already declared
            // the pid via --out) must not create a second listener.
            emit("{\"event\":\"output_added\",\"pid\":" + std::to_string(pid) +
                 ",\"tee\":\"" + json_escape(tee) + "\",\"idempotent\":true}");
            return;
        }
    }
    if (!core_->add_output(pid)) {
        emit("{\"event\":\"output_add_failed\",\"pid\":" + std::to_string(pid) +
             ",\"message\":\"" + json_escape("core rejected pid") + "\"}");
        return;
    }
    Output o;
    o.pid = pid;
    o.tee = tee;
    o.server = std::make_unique<mrbus::FanoutServer>(opts_.caps, emit);
    outputs_.push_back(std::move(o));
    refresh_gating();
    emit("{\"event\":\"output_added\",\"pid\":" + std::to_string(pid) +
         ",\"tee\":\"" + json_escape(tee) + "\"}");
}

void App::prepare_poll(std::vector<pollfd>& fds) const {
    if (input_) input_->prepare_poll(fds);
    if (pending_input_) pending_input_->prepare_poll(fds);
    for (const auto& o : outputs_) o.server->prepare_poll(fds);
}

void App::handle_poll(const pollfd& p) {
    if (input_ && input_->handle_poll(p)) return;
    if (pending_input_ && pending_input_->handle_poll(p)) return;
    for (auto& o : outputs_)
        if (o.server->handle_poll(p)) return;
}

void App::emit_stats(int64_t now_ns) {
    size_t clients = 0;
    std::string drops;
    for (const auto& o : outputs_) {
        clients += o.server->client_count();
        for (const auto& [edge, n] : o.server->drops()) {
            if (!drops.empty()) drops += ",";
            drops += "\"" + json_escape(edge) + "\":" + std::to_string(n);
        }
    }
    long long bytes = input_ ? input_->bytes_received() : 0;
    double dt = (now_ns - last_stats_ns_) / 1e9;
    long long kbps = dt > 0 ? (long long)((bytes - last_stats_bytes_) * 8 / 1000.0 / dt) : 0;
    last_stats_bytes_ = bytes;
    // `timeline` only while the contract is on: with it off there is no stamper
    // and the line stays byte-identical to the pre-contract one. The drift loop
    // is per-EGRESS (one stamper, one anchor for every output PID), so this is
    // one object for the whole splitter and not one per branch.
    std::string timeline =
        stamper_ ? ",\"timeline\":" + mrts::drift_stats_json(stamper_->drift()) : "";
    emit("{\"stats\":{\"clients\":" + std::to_string(clients) + ",\"drops\":{" + drops +
         "}" + timeline + ",\"in_kbps\":" + std::to_string(kbps) + "}}");
}

void App::tick(int64_t now_ns) {
    // Time-based flush for coalesced output (see on_input_buffer). The poll
    // loop wakes at least every 100 ms idle and per input buffer when
    // streaming, so flush latency is bounded by FLUSH_INTERVAL_MS in steady
    // state and by the poll timeout when the source pauses.
    flush_due(now_ns);
    if (input_) input_->maybe_reconnect(now_ns);
    if (pending_input_) {
        pending_input_->maybe_reconnect(now_ns);
        if (pending_input_->connected()) {
            emit("{\"event\":\"reinput_done\",\"socket\":\"" +
                 json_escape(pending_input_->path()) + "\"}");
            input_ = std::move(pending_input_);
            pending_deadline_ns_ = 0;
        } else if (now_ns >= pending_deadline_ns_) {
            emit("{\"event\":\"reinput_failed\",\"message\":\"" +
                 json_escape("no listener at " + pending_input_->path()) + "\"}");
            pending_input_.reset();
        }
    }
    bool stalled = input_ && input_->stalled(now_ns);
    if (stalled && !was_stalled_) {
        emit("{\"event\":\"input_stalled\",\"ms\":" +
             std::to_string((now_ns - input_->last_buffer_ns()) / 1'000'000) + "}");
    } else if (!stalled && was_stalled_) {
        emit("{\"event\":\"input_resumed\"}");
    }
    was_stalled_ = stalled;
    if (last_stats_ns_ == 0) last_stats_ns_ = now_ns;
    if (now_ns - last_stats_ns_ >= mrbus::STATS_INTERVAL_NS) {
        emit_stats(now_ns);
        last_stats_ns_ = now_ns;
    }
}

void App::shutdown() {
    for (auto& o : outputs_) o.server->detach_all();
}

}  // namespace mrtssplit
