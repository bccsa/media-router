#include "edge_path.h"

#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>

#include "ipc.h"

namespace mr::bus {

namespace {

/** Connect-probe a unix socket path (200 ms). */
bool socket_accepts(const std::string& path) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
    if (fd < 0) return false;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
    bool ok = false;
    int r = ::connect(fd, (sockaddr*)&addr, sizeof addr);
    if (r == 0) {
        ok = true;
    } else if (errno == EINPROGRESS || errno == EAGAIN) {
        pollfd p{fd, POLLOUT, 0};
        if (::poll(&p, 1, 200) > 0) {
            int soerr = 0;
            socklen_t len = sizeof soerr;
            ok = ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &len) == 0 && soerr == 0;
        }
    }
    ::close(fd);
    return ok;
}

}  // namespace

std::string bind_path(const std::string& socket) { return socket + "." + std::to_string(::getpid()); }

bool path_free(const std::string& path, std::string* held) {
    struct stat st{};
    if (::lstat(path.c_str(), &st) != 0) return true;
    if (socket_accepts(path)) {
        *held = "live producer already on " + path;
        return false;
    }
    if (::unlink(path.c_str()) == 0) {
        ipc::warning("bus_attach: unlinked stale bus socket " + path);
        return true;
    }
    if (errno == ENOENT) return true;
    *held = "stale bus socket " + path + " cannot be removed (" + std::strerror(errno) + ")";
    return false;
}

int publish_path(const std::string& bind, const std::string& socket, EdgePath& p) {
    struct stat st{};
    if (::lstat(bind.c_str(), &st) != 0 || ::link(bind.c_str(), socket.c_str()) != 0) return errno;
    ::unlink(bind.c_str());
    p.published = true;
    p.dev = st.st_dev;
    p.ino = st.st_ino;
    return 0;
}

void release_path(const std::string& socket, EdgePath& p) {
    if (!p.published) return;
    p.published = false;
    struct stat st{};
    if (::lstat(socket.c_str(), &st) == 0 && st.st_dev == p.dev && st.st_ino == p.ino) ::unlink(socket.c_str());
}

}  // namespace mr::bus
