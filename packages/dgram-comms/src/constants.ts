/**
 * Default SO_RCVBUF for dgram-comms UDP sockets (4 MiB).
 *
 * The OS default (~208 KB on Linux) overflows when many engines reconnect at
 * once: a manager restart triggers a reconnect storm from every engine
 * (connect + immediate telemetry burst) and the receive buffer drops the
 * excess as UDP RcvbufErrors — 306 packets dropped in a single production
 * restart on the 7-engine fleet. 4 MiB gives ~20x headroom.
 *
 * DEPENDS ON the host raising net.core.rmem_max: the kernel silently clamps
 * this request down to that ceiling (never an error), so on a box left at the
 * ~208 KB default this reverts to a no-op. The media-router image ships
 * `net.core.rmem_max = 16 MB` in /etc/sysctl.d/90-media-router-udp.conf — the
 * same ceiling the engine's 8 MB udpsrc buffers rely on (see udpHelpers
 * `NET_UDP_RCV_BUF`) — so 4 MB is honoured on every fleet host.
 */
export const DEFAULT_RECV_BUFFER_SIZE = 4 * 1024 * 1024;
