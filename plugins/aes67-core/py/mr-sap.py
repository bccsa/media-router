#!/usr/bin/env python3
"""SAP announce/discovery sidecar for the AES67 plugins (ADR-0005 decision 7).

One process per module that needs the SAP group (239.255.255.255:9875):

    --announce   the TX module's session, re-sent every `--interval` seconds
                 and DELETED on shutdown, so a stopped stream leaves other
                 devices' pickers immediately instead of aging out.
    --listen     the RX module's discovery: every announcement on the group is
                 parsed into the session table and the CURRENT SET is emitted
                 as one snapshot whenever it changes.

Events on stdout (JSON lines, the house sidecar convention):

    {"event": "ready", "announcing": bool, "listening": bool, "sdp": "..."}
    {"event": "streams", "streams": [ {...}, ... ]}      full set, on change
    {"event": "error", "message": "..."}

Snapshots rather than add/remove deltas: the owning module can then replace its
table wholesale, so a sidecar restart re-syncs the GUI on the next change
instead of leaving a phantom entry that only a 5-minute timeout clears.

Pure stdlib (sockets + selectors), like `unixfd-fanout.py`. All SAP/SDP
knowledge lives in `aes67_sap.py` — this file is I/O and lifecycle only.
"""

import argparse
import json
import os
import selectors
import signal
import socket
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aes67_sap as sap  # noqa: E402

#: How often the discovery table is aged and the snapshot re-checked. Well under
#: any real announce interval, so a deletion shows up promptly.
TICK_S = 1.0


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def outbound_ip(target):
    """The local address the kernel would use to reach `target` (no packets sent).

    Used when the caller gives no --source-ip: a SAP packet's originating
    source field and the SDP `o=` line must both be a real address of ours, and
    the module has no better answer than "whatever this route picks".
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((target, 9))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def is_multicast(addr):
    try:
        return 224 <= int(addr.split(".", 1)[0]) <= 239
    except (ValueError, IndexError):
        return False


def make_send_socket(group, iface_ip, ttl):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    # The multicast knobs are skipped for a unicast --group. That is not a
    # degenerate case to guard against: it is how the sidecar's own end-to-end
    # test runs two of these against each other on 127.0.0.1, where `lo` has no
    # MULTICAST flag and a join would fail outright.
    if is_multicast(group):
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL,
                     struct.pack("b", max(1, min(255, ttl))))
        if iface_ip:
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface_ip))
    return s


def make_listen_socket(group, port, iface_ip):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # Every AES67 device on the box shares the group; without REUSEPORT a second
    # listener (two RX modules) would fail to bind.
    if hasattr(socket, "SO_REUSEPORT"):
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except OSError:
            pass
    s.bind(("", port))
    if is_multicast(group):
        mreq = socket.inet_aton(group) + socket.inet_aton(iface_ip or "0.0.0.0")
        s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    s.setblocking(False)
    return s


class SapSidecar:
    def __init__(self, args):
        self.args = args
        self.running = True
        self.source_ip = args.source_ip or outbound_ip(args.group)
        self.table = sap.DiscoveryTable(interval_s=args.interval, timeout_s=args.timeout)
        self.last_snapshot = None
        self.next_announce = 0.0
        self.send_sock = None
        self.listen_sock = None
        self.sdp = None
        self.packet = None

    # -- announce ---------------------------------------------------------

    def build_announcement(self):
        self.sdp = sap.build_sdp(
            session_name=self.args.session_name,
            source_ip=self.source_ip,
            stream_address=self.args.stream_address,
            stream_port=self.args.stream_port,
            encoding=self.args.encoding,
            rate=self.args.rate,
            channels=self.args.channels,
            ptime_ms=self.args.ptime,
            payload_type=self.args.payload_type,
            ttl=self.args.ttl,
            ptp_gmid=self.args.ptp_gmid or None,
            ptp_domain=self.args.ptp_domain,
        )
        self.packet = sap.build_sap_packet(self.sdp, self.source_ip)

    def send_announcement(self, deletion=False):
        if not self.send_sock:
            return
        packet = (
            sap.build_sap_packet(self.sdp, self.source_ip, deletion=True)
            if deletion else self.packet
        )
        try:
            self.send_sock.sendto(packet, (self.args.group, self.args.port))
        except OSError as e:
            emit({"event": "error", "message": "SAP send failed: %s" % e})

    # -- discovery --------------------------------------------------------

    def absorb(self, data, addr):
        action, _ = self.table.feed(data, source_ip=addr[0])
        if action:
            self.publish()

    def publish(self, force=False):
        streams = self.table.entries()
        snapshot = json.dumps(streams, sort_keys=True)
        if snapshot == self.last_snapshot and not force:
            return
        self.last_snapshot = snapshot
        emit({"event": "streams", "streams": streams})

    # -- lifecycle --------------------------------------------------------

    def stop(self, *_):
        self.running = False

    def run(self):
        selector = selectors.DefaultSelector()
        if self.args.announce:
            self.send_sock = make_send_socket(
                self.args.group, self.args.iface_address, self.args.ttl)
            self.build_announcement()
        if self.args.listen:
            try:
                self.listen_sock = make_listen_socket(
                    self.args.group, self.args.port, self.args.iface_address)
            except OSError as e:
                emit({"event": "error", "message": "SAP listen failed: %s" % e})
                return 1
            selector.register(self.listen_sock, selectors.EVENT_READ)

        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        emit({
            "event": "ready",
            "announcing": bool(self.args.announce),
            "listening": bool(self.args.listen),
            "sourceIp": self.source_ip,
            "sdp": self.sdp,
        })
        if self.args.listen:
            self.publish(force=True)

        while self.running:
            now = time.monotonic()
            if self.args.announce and now >= self.next_announce:
                self.send_announcement()
                self.next_announce = now + self.args.interval
            for key, _ in selector.select(timeout=TICK_S):
                try:
                    data, addr = key.fileobj.recvfrom(65535)
                except OSError:
                    continue
                self.absorb(data, addr)
            if self.args.listen:
                self.publish()   # prunes as it goes; emits only on a change

        # A deletion packet is the difference between "this stream is gone" and
        # "wait five minutes and assume so" on every other device's picker.
        if self.args.announce:
            self.send_announcement(deletion=True)
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--announce", action="store_true", help="announce a session")
    parser.add_argument("--listen", action="store_true", help="discover announced sessions")
    parser.add_argument("--group", default=sap.SAP_GROUP_IPV4)
    parser.add_argument("--port", type=int, default=sap.SAP_PORT)
    parser.add_argument("--iface-address", default="",
                        help="local IP of the NIC to announce on / join from")
    parser.add_argument("--source-ip", default="",
                        help="originating source for the SAP header and SDP o= line")
    parser.add_argument("--interval", type=float, default=sap.DEFAULT_ANNOUNCE_INTERVAL_S)
    parser.add_argument("--timeout", type=float, default=None,
                        help="discovery ageing timeout (default 10x interval)")
    # Announce-side session parameters.
    parser.add_argument("--session-name", default="AES67 stream")
    parser.add_argument("--stream-address", default="")
    parser.add_argument("--stream-port", type=int, default=5004)
    parser.add_argument("--encoding", default="L24")
    parser.add_argument("--rate", type=int, default=48000)
    parser.add_argument("--channels", type=int, default=2)
    parser.add_argument("--ptime", type=float, default=1.0)
    parser.add_argument("--payload-type", type=int, default=96)
    parser.add_argument("--ttl", type=int, default=16)
    parser.add_argument("--ptp-gmid", default="",
                        help="PTP grandmaster id — announces the RFC 7273 clock pair when set")
    parser.add_argument("--ptp-domain", type=int, default=0)
    args = parser.parse_args()

    if not args.announce and not args.listen:
        parser.error("nothing to do: pass --announce and/or --listen")
    if args.announce and not args.stream_address:
        parser.error("--announce needs --stream-address")
    return SapSidecar(args).run()


if __name__ == "__main__":
    raise SystemExit(main())
