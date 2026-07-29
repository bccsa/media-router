#!/usr/bin/env python3
"""Minimal single-client GstUnixFd SERVER — a unixfdsink stand-in for tests.

Serves CAPS then a file's bytes as fixed-size NEW_BUFFER messages (one memfd
per buffer via SCM_RIGHTS), and VERIFIES the client sends RELEASE_BUFFER for
every buffer — the release discipline a stock gst unixfdsink depends on.
Used by mrTssplit.test.ts as the upstream producer for mr-tssplit's input.

Events (stdout JSON lines): ready, client-connected, served {n}, released
{n}, done (everything served AND released).

Usage: unixfd-test-server.py <socket> <file> [--chunk 1316]
           [--pause-after N --pause-ms M]   # silence window mid-stream
           [--hold]                          # keep serving connection open
"""
import argparse
import json
import os
import socket
import struct
import sys
import time

HEADER = struct.Struct('<II')
NEW_BUFFER = struct.Struct('<QQQQQQIBBH')
MEMORY = struct.Struct('<QQ')
CMD_NEW_BUFFER, CMD_RELEASE_BUFFER, CMD_CAPS = 0, 1, 2
NONE = 0xFFFFFFFFFFFFFFFF
CAPS = 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188'


def emit(obj):
    print(json.dumps(obj), flush=True)


def drain_releases(sock, state):
    """Non-blocking drain of client->server bytes, counting RELEASE_BUFFER."""
    try:
        while True:
            data = sock.recv(65536, socket.MSG_DONTWAIT)
            if not data:
                return False
            state['buf'] += data
            while len(state['buf']) >= 8:
                cmd, size = HEADER.unpack(state['buf'][:8])
                if len(state['buf']) < 8 + size:
                    break
                if cmd == CMD_RELEASE_BUFFER:
                    state['released'] += 1
                state['buf'] = state['buf'][8 + size:]
    except BlockingIOError:
        return True
    except OSError:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('sock_path')
    ap.add_argument('file')
    ap.add_argument('--chunk', type=int, default=1316)
    ap.add_argument('--pause-after', type=int, default=0)
    ap.add_argument('--pause-ms', type=int, default=0)
    ap.add_argument('--hold', action='store_true')
    args = ap.parse_args()

    data = open(args.file, 'rb').read()
    try:
        os.unlink(args.sock_path)
    except OSError:
        pass
    lst = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    lst.bind(args.sock_path)
    lst.listen(1)
    emit({'event': 'ready'})
    sock, _ = lst.accept()
    emit({'event': 'client-connected'})

    sock.sendall(HEADER.pack(CMD_CAPS, len(CAPS) + 1) + CAPS.encode() + b'\0')
    state = {'released': 0, 'buf': b''}
    served = 0
    for off in range(0, len(data), args.chunk):
        chunk = data[off:off + args.chunk]
        if args.pause_after and served == args.pause_after:
            time.sleep(args.pause_ms / 1000)
        served += 1
        payload = NEW_BUFFER.pack(served, time.monotonic_ns(), NONE, NONE, NONE,
                                  NONE, 0, 0, 1, 0) + MEMORY.pack(len(chunk), 0)
        fd = os.memfd_create(f'test-{served}')
        os.write(fd, chunk)
        msg = HEADER.pack(CMD_NEW_BUFFER, len(payload)) + payload
        socket.send_fds(sock, [msg], [fd])
        os.close(fd)
        if not drain_releases(sock, state):
            emit({'error': 'client vanished mid-stream'})
            return 1
    emit({'event': 'served', 'n': served})

    deadline = time.monotonic() + 10
    sock.setblocking(False)
    while state['released'] < served and time.monotonic() < deadline:
        if not drain_releases(sock, state):
            break
        time.sleep(0.02)
    emit({'event': 'released', 'n': state['released']})
    if state['released'] == served:
        emit({'event': 'done'})
    else:
        emit({'error': f"released {state['released']} of {served}"})
        return 1
    if args.hold:
        try:
            time.sleep(3600)
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
