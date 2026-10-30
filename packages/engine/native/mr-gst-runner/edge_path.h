// Who may hold and remove a bus edge's socket path (B-190): unixfdsink never binds over a
// file and unlinks its socket-path at stop, whoever owns it then, so an edge's sink binds a
// private path published with link(2), and a runner unlinks only its own socket's path.
#pragma once

#include <sys/types.h>

#include <string>

namespace mr::bus {

/** The socket a runner published at an edge path: the only one it may unlink. */
struct EdgePath {
    bool published = false;
    dev_t dev = 0;
    ino_t ino = 0;
};

/** The sink's private bind path: unique to this process, beside the edge path. */
std::string bind_path(const std::string& socket);

/** True when the edge path is free: absent, or a file nothing listens on (a
 *  runner that died hard) removed. Otherwise `held` says what holds it: an old
 *  runner still draining, or a second producer on one path. */
bool path_free(const std::string& path, std::string* held);

/** Publish a started sink's socket at the edge path: 0, or the errno
 *  (EEXIST: another socket took the path since `path_free`). */
int publish_path(const std::string& bind, const std::string& socket, EdgePath& p);

/** Unlink the edge path if it still names this runner's socket. Call while the
 *  sink still listens, so a successor finds the path live or gone, never stale,
 *  and cannot replace it between the check and the unlink. */
void release_path(const std::string& socket, EdgePath& p);

}  // namespace mr::bus
