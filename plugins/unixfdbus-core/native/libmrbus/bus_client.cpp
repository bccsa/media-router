#include "bus_client.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "busproto.h"
#include "control.h"

namespace mrbus {

namespace {
constexpr int64_t CONNECT_RETRY_NS = 500'000'000;   // indefinite, 2 Hz
constexpr size_t MAX_FDS_PER_READ = 4;
}

BusClient::BusClient(std::string path, OnBuffer on_buffer, int64_t stall_ns)
    : path_(std::move(path)), on_buffer_(std::move(on_buffer)), stall_ns_(stall_ns) {
    in_.reserve(4096);
}

BusClient::~BusClient() { disconnect(); }

bool BusClient::stalled(int64_t now_ns) const {
    if (last_buffer_ns_ == 0) return false;   // nothing ever arrived yet
    return now_ns - last_buffer_ns_ >= stall_ns_;
}

void BusClient::disconnect() {
    if (sock_ >= 0) {
        close(sock_);
        sock_ = -1;
    }
    for (int fd : fds_) close(fd);
    fds_.clear();
    in_.clear();
    need_ = 8;
    have_header_ = false;
    out_.clear();
}

void BusClient::maybe_reconnect(int64_t now_ns) {
    if (sock_ >= 0 || now_ns < next_connect_ns_) return;
    next_connect_ns_ = now_ns + CONNECT_RETRY_NS;
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    if (path_.size() >= sizeof(addr.sun_path)) {
        close(fd);
        return;
    }
    strncpy(addr.sun_path, path_.c_str(), sizeof(addr.sun_path) - 1);
    // Blocking connect on a unix socket completes (or fails) immediately once
    // the listener exists — the retry cadence handles the not-yet case.
    if (connect(fd, (sockaddr*)&addr, sizeof addr) != 0) {
        close(fd);
        return;
    }
    // Non-blocking from here on; the poll loop drives reads.
    int fl = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    sock_ = fd;
}

void BusClient::queue_release(uint64_t id) {
    Header h{CMD_RELEASE_BUFFER, sizeof(uint64_t)};
    size_t at = out_.size();
    out_.resize(at + sizeof h + sizeof id);
    memcpy(out_.data() + at, &h, sizeof h);
    memcpy(out_.data() + at + sizeof h, &id, sizeof id);
}

bool BusClient::flush_out() {
    while (!out_.empty()) {
        ssize_t n = send(sock_, out_.data(), out_.size(), MSG_NOSIGNAL);
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return true;
            return false;
        }
        if (n == 0) return false;
        out_.erase(out_.begin(), out_.begin() + n);
    }
    return true;
}

bool BusClient::dispatch_message() {
    Header h;
    memcpy(&h, in_.data(), sizeof h);
    const uint8_t* payload = in_.data() + sizeof h;
    if (h.type == CMD_NEW_BUFFER) {
        if (h.size < sizeof(NewBufferPayload) + sizeof(MemoryPayload)) return false;
        NewBufferPayload p;
        memcpy(&p, payload, sizeof p);
        if (p.n_memory != 1 || fds_.empty()) return false;   // protocol violation
        MemoryPayload mem;
        memcpy(&mem, payload + sizeof p, sizeof mem);
        int fd = fds_.front();
        fds_.erase(fds_.begin());
        payload_buf_.resize(mem.size);
        ssize_t got = pread(fd, payload_buf_.data(), mem.size, (off_t)mem.offset);
        close(fd);
        if (got != (ssize_t)mem.size) return false;
        buffers_++;
        bytes_ += (long long)mem.size;
        last_buffer_ns_ = mono_ns();
        // Release BEFORE the (potentially slow) consumer callback: the stock
        // unixfdsink tracks outstanding buffers, and our pread copy is done.
        queue_release(p.id);
        if (!flush_out()) return false;
        on_buffer_(payload_buf_.data(), payload_buf_.size());
    } else if (h.type == CMD_CAPS) {
        // Caps are transported for gst consumers; this consumer routes raw
        // TS packets, so the string is consumed and dropped.
    }
    // Unknown command types: skip payload (forward compatibility).
    for (int fd : fds_) close(fd);   // any unclaimed rights die with the message
    fds_.clear();
    in_.clear();
    need_ = 8;
    have_header_ = false;
    return true;
}

bool BusClient::read_input() {
    while (true) {
        size_t want = need_ - in_.size();
        if (want == 0) {
            if (!have_header_) {
                Header h;
                memcpy(&h, in_.data(), sizeof h);
                have_header_ = true;
                need_ = sizeof h + h.size;
                if (h.size > (64u << 20)) return false;   // insane length
                continue;
            }
            if (!dispatch_message()) return false;
            continue;
        }
        uint8_t tmp[65536];
        size_t chunk = want < sizeof tmp ? want : sizeof tmp;
        struct iovec iov {tmp, chunk};
        union {
            char buf[CMSG_SPACE(sizeof(int) * MAX_FDS_PER_READ)];
            struct cmsghdr align;
        } u{};
        struct msghdr msg {};
        msg.msg_iov = &iov;
        msg.msg_iovlen = 1;
        msg.msg_control = u.buf;
        msg.msg_controllen = sizeof u.buf;
        ssize_t n = recvmsg(sock_, &msg, MSG_CMSG_CLOEXEC);
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return true;
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) return false;   // producer closed
        for (struct cmsghdr* c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
            if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS) continue;
            int count = (int)((c->cmsg_len - CMSG_LEN(0)) / sizeof(int));
            for (int i = 0; i < count; i++) {
                int fd;
                memcpy(&fd, (char*)CMSG_DATA(c) + i * sizeof(int), sizeof(int));
                fds_.push_back(fd);
            }
        }
        in_.insert(in_.end(), tmp, tmp + n);
    }
}

void BusClient::prepare_poll(std::vector<pollfd>& fds) const {
    if (sock_ >= 0)
        fds.push_back({sock_, (short)(POLLIN | (out_.empty() ? 0 : POLLOUT)), 0});
}

bool BusClient::handle_poll(const pollfd& p) {
    if (sock_ < 0 || p.fd != sock_) return false;
    if (p.revents & (POLLIN | POLLERR | POLLHUP)) {
        if (!read_input()) {
            disconnect();
            return true;
        }
    }
    if (p.revents & POLLOUT) {
        if (!flush_out()) disconnect();
    }
    return true;
}

}  // namespace mrbus
