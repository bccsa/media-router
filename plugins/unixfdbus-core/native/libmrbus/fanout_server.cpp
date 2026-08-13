#include "fanout_server.h"

#include <errno.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstdio>

#include "busproto.h"
#include "control.h"

namespace mrbus {

namespace {

int bind_unix_listener(const std::string& path, int backlog) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    if (path.size() >= sizeof(addr.sun_path)) {
        close(fd);
        errno = ENAMETOOLONG;
        return -1;
    }
    strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
    if (bind(fd, (sockaddr*)&addr, sizeof addr) < 0 || listen(fd, backlog) < 0) {
        int e = errno;
        close(fd);
        errno = e;
        return -1;
    }
    return fd;
}

// sendmsg carrying `fd` via SCM_RIGHTS on the message's first byte — the
// kernel attaches the rights at that byte position, which is exactly where
// unixfdsrc's recvmsg reads them.
ssize_t send_with_fd(int sock, const uint8_t* data, size_t len, int fd) {
    struct iovec iov { const_cast<uint8_t*>(data), len };
    union {
        char buf[CMSG_SPACE(sizeof(int))];
        struct cmsghdr align;
    } u{};
    struct msghdr msg {};
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    msg.msg_control = u.buf;
    msg.msg_controllen = sizeof u.buf;
    struct cmsghdr* c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET;
    c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &fd, sizeof(int));
    return sendmsg(sock, &msg, MSG_NOSIGNAL);
}

}  // namespace

void unlink_stale(const std::string& path, const char* label,
                  const std::function<void(const std::string&)>& emit) {
    if (access(path.c_str(), F_OK) != 0) return;
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd >= 0) {
        struct timeval tv {0, 200000};
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
        if (connect(fd, (sockaddr*)&addr, sizeof addr) == 0)
            emit("{\"event\":\"warning\",\"message\":\"" + json_escape(
                     std::string(label) + ": live socket at " + path + " - replacing") +
                 "\"}");
        close(fd);
    }
    unlink(path.c_str());
}

FanoutServer::FanoutServer(std::string caps, Emit emit) : emit_(std::move(emit)) {
    Header h{CMD_CAPS, (uint32_t)caps.size() + 1};
    caps_msg_.resize(sizeof h + caps.size() + 1);
    memcpy(caps_msg_.data(), &h, sizeof h);
    memcpy(caps_msg_.data() + sizeof h, caps.data(), caps.size());
    caps_msg_.back() = 0;   // NUL-terminated caps string
}

FanoutServer::~FanoutServer() {
    for (auto& [sock, c] : clients_) {
        for (auto& m : c.q)
            if (m.fd >= 0) close(m.fd);
        close(sock);
    }
    for (auto& [path, fd] : edges_) close(fd);
}

void FanoutServer::attach(const std::string& path) {
    if (edges_.count(path)) {
        emit_("{\"event\":\"attached\",\"socket\":\"" + json_escape(path) +
              "\",\"idempotent\":true}");
        return;
    }
    unlink_stale(path, "edge", emit_);
    int fd = bind_unix_listener(path, 4);
    if (fd < 0) {
        emit_("{\"event\":\"error\",\"message\":\"" +
              json_escape("bus_attach " + path + ": " + strerror(errno)) + "\"}");
        return;
    }
    edges_[path] = fd;
    emit_("{\"event\":\"attached\",\"socket\":\"" + json_escape(path) + "\"}");
}

void FanoutServer::detach(const std::string& path) {
    auto it = edges_.find(path);
    if (it == edges_.end()) return;
    close(it->second);
    edges_.erase(it);
    unlink(path.c_str());
    for (auto cit = clients_.begin(); cit != clients_.end();) {
        if (cit->second.edge == path) {
            int sock = cit->first;
            ++cit;
            drop_client(sock);
        } else {
            ++cit;
        }
    }
    emit_("{\"event\":\"detached\",\"socket\":\"" + json_escape(path) + "\"}");
}

void FanoutServer::detach_all() {
    while (!edges_.empty()) detach(edges_.begin()->first);
}

bool FanoutServer::edge_has_client(const std::string& path) const {
    for (const auto& [sock, c] : clients_)
        if (c.edge == path) return true;
    return false;
}

void FanoutServer::accept_client(int listener_fd) {
    std::string edge;
    for (const auto& [path, fd] : edges_)
        if (fd == listener_fd) edge = path;
    int sock = accept4(listener_fd, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (sock < 0) return;
    Client& c = clients_[sock];
    c.sock = sock;
    c.edge = edge;
    // Caps first, before any buffer — the guarantee unixfdsink gives a client
    // on accept. Queued like any message so partial sends are safe, but never
    // sheddable: a capsless stream is rejected downstream.
    Msg m;
    m.data = caps_msg_;
    m.t_ns = mono_ns();
    m.sheddable = false;
    c.q.push_back(std::move(m));
    if (!flush_client(c)) drop_client(sock);
}

bool FanoutServer::drain_client(Client& c) {
    char buf[4096];
    while (true) {
        ssize_t n = recv(c.sock, buf, sizeof buf, 0);
        if (n > 0) continue;                    // RELEASE_BUFFER etc. — discard
        if (n == 0) return false;               // client closed
        if (errno == EAGAIN || errno == EWOULDBLOCK) return true;
        if (errno == EINTR) continue;
        return false;
    }
}

int FanoutServer::shed_client(Client& c, int64_t now_ns) {
    int dropped = 0;
    for (auto it = c.q.begin(); it != c.q.end();) {
        if (it->sheddable && !it->started && now_ns - it->t_ns > QUEUE_BUDGET_NS) {
            if (it->fd >= 0) close(it->fd);
            it = c.q.erase(it);
            dropped++;
        } else {
            ++it;
        }
    }
    return dropped;
}

bool FanoutServer::flush_client(Client& c) {
    while (!c.q.empty()) {
        Msg& m = c.q.front();
        ssize_t sent;
        if (m.fd >= 0 && !m.started)
            sent = send_with_fd(c.sock, m.data.data() + m.off, m.data.size() - m.off, m.fd);
        else
            sent = send(c.sock, m.data.data() + m.off, m.data.size() - m.off, MSG_NOSIGNAL);
        if (sent < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return true;
            return false;
        }
        if (sent == 0) return false;
        m.started = true;
        if (m.fd >= 0) {
            // SCM_RIGHTS delivered with the first successful sendmsg; our dup
            // is no longer needed whatever remains of the payload.
            close(m.fd);
            m.fd = -1;
        }
        m.off += (size_t)sent;
        if (m.off < m.data.size()) return true;
        c.q.pop_front();
    }
    return true;
}

void FanoutServer::drop_client(int sock) {
    auto it = clients_.find(sock);
    if (it == clients_.end()) return;
    for (auto& m : it->second.q)
        if (m.fd >= 0) close(m.fd);
    close(sock);
    clients_.erase(it);
}

void FanoutServer::broadcast(const uint8_t* data, size_t len, int64_t pts_ns) {
    if (clients_.empty()) return;   // tee with no branches: drop, keep flowing
    buffer_id_++;
    NewBufferPayload p{};
    p.id = buffer_id_;
    // Like unixfdsink: absolute monotonic ns — send-time unless the caller
    // mapped the payload onto the house timeline (see the header).
    p.pts = (uint64_t)(pts_ns < 0 ? mono_ns() : pts_ns);
    p.dts = p.duration = p.offset = p.offset_end = CLOCK_TIME_NONE;
    p.flags = 0;
    p.memory_type = MEMORY_TYPE_DEFAULT;
    p.n_memory = 1;
    p.n_meta = 0;
    MemoryPayload mem{len, 0};
    Header h{CMD_NEW_BUFFER, (uint32_t)(sizeof p + sizeof mem)};
    std::vector<uint8_t> msg(sizeof h + sizeof p + sizeof mem);
    memcpy(msg.data(), &h, sizeof h);
    memcpy(msg.data() + sizeof h, &p, sizeof p);
    memcpy(msg.data() + sizeof h + sizeof p, &mem, sizeof mem);

    char name[32];
    std::snprintf(name, sizeof name, "mr-bus-%llu", (unsigned long long)buffer_id_);
    int fd = memfd_create(name, 0);
    if (fd < 0) return;
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, data + off, len - off);
        if (n <= 0) {
            close(fd);
            return;
        }
        off += (size_t)n;
    }
    int64_t now = mono_ns();
    std::vector<int> dead;
    for (auto& [sock, c] : clients_) {
        int shed = shed_client(c, now);
        if (shed) drops_[c.edge] += shed;
        Msg m;
        m.data = msg;
        m.fd = dup(fd);
        m.t_ns = now;
        c.q.push_back(std::move(m));
        if (!flush_client(c)) dead.push_back(sock);
    }
    close(fd);
    for (int sock : dead) drop_client(sock);
}

void FanoutServer::prepare_poll(std::vector<pollfd>& fds) const {
    for (const auto& [path, fd] : edges_) fds.push_back({fd, POLLIN, 0});
    for (const auto& [sock, c] : clients_)
        fds.push_back({sock, (short)(POLLIN | (c.q.empty() ? 0 : POLLOUT)), 0});
}

bool FanoutServer::handle_poll(const pollfd& p) {
    for (const auto& [path, fd] : edges_) {
        if (fd == p.fd) {
            if (p.revents & POLLIN) accept_client(fd);
            return true;
        }
    }
    auto it = clients_.find(p.fd);
    if (it == clients_.end()) return false;
    Client& c = it->second;
    if (p.revents & (POLLIN | POLLERR | POLLHUP)) {
        if (!drain_client(c)) {
            drop_client(p.fd);
            return true;
        }
    }
    if (p.revents & POLLOUT) {
        if (!flush_client(c)) drop_client(p.fd);
    }
    return true;
}

}  // namespace mrbus
