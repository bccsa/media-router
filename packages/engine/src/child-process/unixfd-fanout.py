#!/usr/bin/env python3
"""GstUnixFd fan-out sidecar for non-GStreamer bus producers (hls-player).

Speaks the GstUnixFd wire protocol (gst-plugins-bad gst/unixfd/gstunixfd.[ch])
as the SERVER side, replacing `tee ! queue leaky=2 ! unixfdsink` for a
producer that has no GStreamer pipeline. One instance per producer module:

    ingest unix socket  <-- raw paced MPEG-TS from the producer's data
                            process (hls-pipe's Node child)
    per-edge listeners  --> one per consumer connection (`bus_attach`),
                            each serving unixfdsrc clients

Control on stdin (JSON lines, same verbs as gst-pipeline-runner.py):
    {"cmd": "bus_attach", "tee": <opaque>, "socket": <edge path>}
    {"cmd": "bus_detach", "socket": <edge path>}
Events on stdout (JSON lines):
    {"event": "ready"}                      ingest listener up, attach ok
    {"event": "attached"|"detached", ...}
    {"stats": {"clients": n, "drops": {edge: n}}}   every 2 s

Protocol notes (layouts are ABI-frozen upstream — see the static asserts in
gstunixfd.c):
  - AF_UNIX SOCK_STREAM. Every message: 8-byte header {u32 type, u32 size}
    (native LE). NEW_BUFFER's header rides the sendmsg that carries the
    memfd via SCM_RIGHTS; the payload bytes follow on the stream.
  - Client accept: send CAPS (NUL-terminated caps string) BEFORE any buffer.
  - pts/dts are absolute CLOCK_MONOTONIC ns; we stamp send-time pts (live
    source equivalence — consumers re-timestamp from the TS anyway).
  - One memfd per buffer, written once, fd closed after send: the client's
    dup keeps the pages alive, so no RELEASE_BUFFER bookkeeping is needed —
    but clients DO send RELEASE_BUFFER back and it must be drained.
  - No EOS on shutdown: bus semantics are "go silent" (consumer recovery is
    its restart path + busSocketGate, same as a dying gst producer).

Fan-out discipline mirrors the gst busedge branches: per-client bounded
send queue with a 500 ms time budget, drop-oldest (leaky=2), non-blocking
sockets — one stalled consumer can never block the ingest loop or siblings.
Drops are counted and reported, never silent.

Pure stdlib; needs Python >= 3.9 (socket.send_fds, os.memfd_create).
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

COMMAND_TYPE_NEW_BUFFER = 0
COMMAND_TYPE_CAPS = 2

HEADER = struct.Struct('<II')  # {u32 type, u32 payload_size}
# NewBufferPayload: id, pts, dts, duration, offset, offset_end (u64 x6),
# flags (u32), type (u8), n_memory (u8), n_meta (u16) = 56 bytes, then
# n_memory x MemoryPayload {u64 size, u64 offset}.
NEW_BUFFER = struct.Struct('<QQQQQQIBBH')
MEMORY = struct.Struct('<QQ')
CLOCK_TIME_NONE = 0xFFFFFFFFFFFFFFFF
MEMORY_TYPE_DEFAULT = 0

# 128 TS packets per buffer — boundaries are irrelevant to tsparse/tsdemux,
# but staying 188-aligned keeps buffers whole-packet like the UDP path.
BUFFER_BYTES = 128 * 188
FLUSH_INTERVAL = 0.02   # flush a partial buffer after 20 ms of ingest silence
QUEUE_BUDGET = 0.5      # per-client send-queue time budget (busedge queue parity)
STATS_INTERVAL = 2.0


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def unlink_stale(path, log_label):
    """Probe-then-unlink a pre-existing socket path (mirrors the runner's
    probe-first unlink — a crashed process leaves a path that refuses
    connections; a live listener means a zombie predecessor we take over)."""
    if not os.path.exists(path):
        return
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.2)
    try:
        probe.connect(path)
        emit({'event': 'warning', 'message': f'{log_label}: live socket at {path} — replacing'})
    except OSError:
        pass
    finally:
        probe.close()
    try:
        os.unlink(path)
    except OSError:
        pass


class Client:
    """One accepted unixfdsrc connection on an edge socket."""

    def __init__(self, sock, edge):
        self.sock = sock
        self.edge = edge
        # Send queue of [data(memoryview), fd or None, enqueue_time, started,
        # sheddable]. `started` guards partially-sent messages: their bytes
        # are already on the wire, so they must complete and can never be
        # dropped. `sheddable` is False for protocol-critical messages (CAPS).
        self.queue = []
        self.queued_bytes = 0

    def enqueue(self, data, fd, now, sheddable=True):
        self.queue.append([memoryview(data), fd, now, False, sheddable])
        self.queued_bytes += len(data)

    def shed(self, now):
        """Drop unstarted buffer messages older than the queue budget (the
        gst busedge branches' `queue leaky=2 max-size-time=500ms` parity)."""
        dropped = 0
        kept = []
        for entry in self.queue:
            if entry[4] and not entry[3] and now - entry[2] > QUEUE_BUDGET:
                if entry[1] is not None:
                    os.close(entry[1])
                self.queued_bytes -= len(entry[0])
                dropped += 1
            else:
                kept.append(entry)
        self.queue = kept
        return dropped

    def flush(self):
        """Drain the queue as far as the socket allows. Returns False when the
        client is dead. The fd rides the sendmsg carrying the message's first
        byte (the header) — the kernel attaches SCM_RIGHTS at that byte
        position, which is exactly where unixfdsrc's recvmsg reads it."""
        while self.queue:
            entry = self.queue[0]
            data, fd = entry[0], entry[1]
            try:
                if fd is not None and not entry[3]:
                    sent = socket.send_fds(self.sock, [data], [fd])
                else:
                    sent = self.sock.send(data)
            except (BlockingIOError, InterruptedError):
                return True
            except OSError:
                return False
            if sent == 0:
                return False
            entry[3] = True
            if fd is not None:
                # SCM_RIGHTS delivered with the first successful sendmsg;
                # our dup is no longer needed whatever remains of the payload.
                os.close(fd)
                entry[1] = None
            self.queued_bytes -= sent
            if sent < len(data):
                entry[0] = data[sent:]
                return True
            self.queue.pop(0)
        return True

    def close(self):
        for entry in self.queue:
            if entry[1] is not None:
                os.close(entry[1])
        self.queue = []
        self.queued_bytes = 0
        try:
            self.sock.close()
        except OSError:
            pass


class Fanout:
    def __init__(self, ingest_path, caps):
        self.ingest_path = ingest_path
        self.caps_message = HEADER.pack(COMMAND_TYPE_CAPS, len(caps) + 1) + caps.encode() + b'\0'
        self.sel = selectors.DefaultSelector()
        self.edges = {}         # edge path -> listener socket
        self.clients = {}       # client socket -> Client
        self.drops = {}         # edge path -> dropped-message count
        self.ingest_listener = None
        self.ingest_conn = None
        self.pending = bytearray()
        self.buffer_id = 0
        self.last_ingest = 0.0
        self.control_buf = b''

    # --- setup -----------------------------------------------------------

    def start(self):
        unlink_stale(self.ingest_path, 'ingest')
        self.ingest_listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.ingest_listener.setblocking(False)
        self.ingest_listener.bind(self.ingest_path)
        self.ingest_listener.listen(1)
        self.sel.register(self.ingest_listener, selectors.EVENT_READ, self.accept_ingest)
        os.set_blocking(sys.stdin.fileno(), False)
        self.sel.register(sys.stdin, selectors.EVENT_READ, self.read_control)
        emit({'event': 'ready'})

    # --- control (stdin) ---------------------------------------------------

    def read_control(self, _key):
        try:
            data = os.read(sys.stdin.fileno(), 65536)
        except BlockingIOError:
            return
        if not data:
            # Engine closed stdin / died — nothing left to control us; exit so
            # we don't linger holding the sockets.
            raise SystemExit(0)
        # Accumulate until newline — a control line can arrive split across
        # reads, and a fragment parsed alone would be silently dropped.
        self.control_buf += data
        *lines, self.control_buf = self.control_buf.split(b'\n')
        for raw in lines:
            line = raw.decode(errors='replace').strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except ValueError:
                emit({'event': 'warning', 'message': f'bad control line: {line[:120]}'})
                continue
            if cmd.get('cmd') == 'bus_attach' and cmd.get('socket'):
                self.attach(cmd['socket'])
            elif cmd.get('cmd') == 'bus_detach' and cmd.get('socket'):
                self.detach(cmd['socket'])

    def attach(self, path):
        if path in self.edges:
            emit({'event': 'attached', 'socket': path, 'idempotent': True})
            return
        unlink_stale(path, 'edge')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.setblocking(False)
        try:
            listener.bind(path)
            listener.listen(4)
        except OSError as err:
            listener.close()
            emit({'event': 'error', 'message': f'bus_attach {path}: {err}'})
            return
        self.edges[path] = listener
        self.sel.register(listener, selectors.EVENT_READ, self.accept_client)
        emit({'event': 'attached', 'socket': path})

    def detach(self, path):
        listener = self.edges.pop(path, None)
        if listener is None:
            return
        self.sel.unregister(listener)
        listener.close()
        try:
            os.unlink(path)
        except OSError:
            pass
        for sock, client in list(self.clients.items()):
            if client.edge == path:
                self.drop_client(sock)
        emit({'event': 'detached', 'socket': path})

    # --- clients -----------------------------------------------------------

    def accept_client(self, key):
        listener = key.fileobj
        edge = next((p for p, l in self.edges.items() if l is listener), None)
        try:
            sock, _addr = listener.accept()
        except OSError:
            return
        sock.setblocking(False)
        client = Client(sock, edge)
        self.clients[sock] = client
        self.sel.register(sock, selectors.EVENT_READ, self.service_client)
        # Caps first, before any buffer — same guarantee unixfdsink gives a
        # client on accept. Queued like any message so partial sends are safe,
        # but never sheddable: a capsless stream is rejected downstream.
        client.enqueue(self.caps_message, None, time.monotonic(), sheddable=False)
        self.pump_client(sock, client)

    def service_client(self, key, writable=False):
        sock = key.fileobj
        client = self.clients.get(sock)
        if client is None:
            return
        # Drain whatever the client sends (RELEASE_BUFFER and any future
        # command) — unread data would eventually block unixfdsrc's send.
        try:
            while True:
                data = sock.recv(4096)
                if not data:
                    self.drop_client(sock)
                    return
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            self.drop_client(sock)
            return
        if writable:
            self.pump_client(sock, client)

    def pump_client(self, sock, client):
        if not client.flush():
            self.drop_client(sock)
            return
        events = selectors.EVENT_READ
        if client.queue:
            events |= selectors.EVENT_WRITE
        self.sel.modify(sock, events, self.service_client)

    def drop_client(self, sock):
        client = self.clients.pop(sock, None)
        if client is None:
            return
        try:
            self.sel.unregister(sock)
        except (KeyError, ValueError):
            pass
        client.close()

    # --- ingest ------------------------------------------------------------

    def accept_ingest(self, _key):
        try:
            conn, _addr = self.ingest_listener.accept()
        except OSError:
            return
        if self.ingest_conn is not None:
            # New producer incarnation (hls URL change respawned the child).
            # The old connection is dead weight — replace it.
            try:
                self.sel.unregister(self.ingest_conn)
            except (KeyError, ValueError):
                pass
            self.ingest_conn.close()
        conn.setblocking(False)
        self.ingest_conn = conn
        self.sel.register(conn, selectors.EVENT_READ, self.read_ingest)

    def read_ingest(self, _key):
        try:
            while True:
                data = self.ingest_conn.recv(65536)
                if not data:
                    self.close_ingest()
                    return
                self.pending += data
                self.last_ingest = time.monotonic()
                while len(self.pending) >= BUFFER_BYTES:
                    self.broadcast(bytes(self.pending[:BUFFER_BYTES]))
                    del self.pending[:BUFFER_BYTES]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            self.close_ingest()

    def close_ingest(self):
        if self.ingest_conn is None:
            return
        try:
            self.sel.unregister(self.ingest_conn)
        except (KeyError, ValueError):
            pass
        self.ingest_conn.close()
        self.ingest_conn = None
        self.flush_partial()
        # A sub-packet remainder from a dead producer is a truncated TS packet
        # — garbage on its own, and carrying it would splice the NEXT
        # (packet-aligned) producer incarnation mid-packet, desyncing every
        # buffer boundary from then on. Drop it.
        self.pending.clear()

    def flush_partial(self):
        """Emit a sub-BUFFER_BYTES tail, 188-aligned (carry the remainder)."""
        aligned = (len(self.pending) // 188) * 188
        if aligned > 0:
            self.broadcast(bytes(self.pending[:aligned]))
            del self.pending[:aligned]

    # --- broadcast ---------------------------------------------------------

    def broadcast(self, chunk):
        if not self.clients:
            return  # tee with no branches: drop and keep flowing
        self.buffer_id += 1
        payload = NEW_BUFFER.pack(
            self.buffer_id,
            time.monotonic_ns(),      # pts: absolute CLOCK_MONOTONIC, like unixfdsink
            CLOCK_TIME_NONE,          # dts
            CLOCK_TIME_NONE,          # duration
            CLOCK_TIME_NONE,          # offset
            CLOCK_TIME_NONE,          # offset_end
            0,                        # flags
            MEMORY_TYPE_DEFAULT,
            1,                        # n_memory
            0,                        # n_meta
        ) + MEMORY.pack(len(chunk), 0)
        message = HEADER.pack(COMMAND_TYPE_NEW_BUFFER, len(payload)) + payload

        fd = os.memfd_create(f'mr-bus-{self.buffer_id}')
        os.write(fd, chunk)
        now = time.monotonic()
        for sock, client in list(self.clients.items()):
            shed = client.shed(now)
            if shed:
                self.drops[client.edge] = self.drops.get(client.edge, 0) + shed
            client.enqueue(message, os.dup(fd), now)
            self.pump_client(sock, client)
        os.close(fd)

    # --- main loop ---------------------------------------------------------

    def run(self):
        self.start()
        last_stats = time.monotonic()
        while True:
            events = self.sel.select(timeout=FLUSH_INTERVAL)
            for key, mask in events:
                callback = key.data
                if callback == self.service_client:
                    callback(key, writable=bool(mask & selectors.EVENT_WRITE))
                else:
                    callback(key)
            now = time.monotonic()
            if self.pending and now - self.last_ingest >= FLUSH_INTERVAL:
                self.flush_partial()
            if now - last_stats >= STATS_INTERVAL:
                last_stats = now
                emit({'stats': {'clients': len(self.clients), 'drops': dict(self.drops)}})

    def cleanup(self):
        for path in list(self.edges):
            self.detach(path)
        for sock in list(self.clients):
            self.drop_client(sock)
        if self.ingest_listener is not None:
            self.ingest_listener.close()
        try:
            os.unlink(self.ingest_path)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ingest', required=True, help='ingest unix socket path')
    parser.add_argument('--caps', required=True, help='GstCaps string sent to each client')
    args = parser.parse_args()

    fanout = Fanout(args.ingest, args.caps)
    # SIGTERM (ManagedProcess graceful stop) → SystemExit so `finally` unlinks
    # our socket paths instead of leaving stale files for the next incarnation.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        fanout.run()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except BrokenPipeError:
        pass  # engine stdout gone — exit quietly
    finally:
        fanout.cleanup()


if __name__ == '__main__':
    main()
