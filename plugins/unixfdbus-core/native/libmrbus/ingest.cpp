#include "ingest.h"

#include <errno.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "busproto.h"
#include "control.h"
#include "fanout_server.h"   // unlink_stale

namespace mrbus {

Ingest::Ingest(std::string path, OnChunk on_chunk, Emit emit)
    : path_(std::move(path)), on_chunk_(std::move(on_chunk)), emit_(std::move(emit)) {}

Ingest::~Ingest() { cleanup(); }

bool Ingest::start() {
    unlink_stale(path_, "ingest", emit_);
    listener_ = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (listener_ < 0) return false;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    if (path_.size() >= sizeof(addr.sun_path)) return false;
    strncpy(addr.sun_path, path_.c_str(), sizeof(addr.sun_path) - 1);
    if (bind(listener_, (sockaddr*)&addr, sizeof addr) < 0 || listen(listener_, 1) < 0) {
        emit_("{\"event\":\"error\",\"message\":\"" +
              json_escape("ingest " + path_ + ": " + strerror(errno)) + "\"}");
        close(listener_);
        listener_ = -1;
        return false;
    }
    return true;
}

void Ingest::cleanup() {
    if (conn_ >= 0) {
        close(conn_);
        conn_ = -1;
    }
    if (listener_ >= 0) {
        close(listener_);
        listener_ = -1;
        unlink(path_.c_str());
    }
}

void Ingest::accept_conn() {
    int conn = accept4(listener_, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (conn < 0) return;
    if (conn_ >= 0) {
        // New producer incarnation (data child respawned). The old
        // connection is dead weight — replace it.
        close(conn_);
    }
    conn_ = conn;
}

void Ingest::read_conn() {
    uint8_t buf[65536];
    while (true) {
        ssize_t n = recv(conn_, buf, sizeof buf, 0);
        if (n > 0) {
            pending_.insert(pending_.end(), buf, buf + n);
            last_ingest_ns_ = mono_ns();
            while (pending_.size() >= (size_t)BUFFER_BYTES) {
                on_chunk_(pending_.data(), BUFFER_BYTES);
                pending_.erase(pending_.begin(), pending_.begin() + BUFFER_BYTES);
            }
            continue;
        }
        if (n == 0) {
            close_conn();
            return;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        if (errno == EINTR) continue;
        close_conn();
        return;
    }
}

void Ingest::close_conn() {
    if (conn_ < 0) return;
    close(conn_);
    conn_ = -1;
    flush_partial();
    // A sub-packet remainder from a dead producer is a truncated TS packet —
    // carrying it would splice the next incarnation mid-packet. Drop it.
    pending_.clear();
}

void Ingest::flush_partial() {
    size_t aligned = pending_.size() / TS_PKT * TS_PKT;
    if (aligned > 0) {
        on_chunk_(pending_.data(), aligned);
        pending_.erase(pending_.begin(), pending_.begin() + aligned);
    }
}

void Ingest::maybe_flush_partial(int64_t now_ns) {
    if (!pending_.empty() &&
        now_ns - last_ingest_ns_ >= (int64_t)FLUSH_INTERVAL_MS * 1'000'000)
        flush_partial();
}

void Ingest::prepare_poll(std::vector<pollfd>& fds) const {
    if (listener_ >= 0) fds.push_back({listener_, POLLIN, 0});
    if (conn_ >= 0) fds.push_back({conn_, POLLIN, 0});
}

bool Ingest::handle_poll(const pollfd& p) {
    if (p.fd == listener_) {
        if (p.revents & POLLIN) accept_conn();
        return true;
    }
    if (p.fd == conn_) {
        if (p.revents & (POLLIN | POLLERR | POLLHUP)) read_conn();
        return true;
    }
    return false;
}

}  // namespace mrbus
