#!/usr/bin/env python3
"""Test client for unixfd-fanout.py — a minimal unixfdsrc stand-in.

Connects to an edge socket, expects CAPS first, then `--buffers N` NEW_BUFFER
messages with passed fds; validates the 56-byte payload layout, the fd's
content, and TS packet alignment (0x47 at every 188-byte stride — the test
producer sends packets shaped 0x47 + 187×0xAA so all-0x47 data can't fake
alignment); sends RELEASE_BUFFER back for each (the sidecar must drain it),
and prints one JSON verdict per buffer.

Usage: unixfd-fanout.test-client.py <edge socket> [--buffers N]
"""

import json
import os
import socket
import struct
import sys

HEADER = struct.Struct('<II')
NEW_BUFFER = struct.Struct('<QQQQQQIBBH')
MEMORY = struct.Struct('<QQ')

COMMAND_TYPE_NEW_BUFFER = 0
COMMAND_TYPE_RELEASE_BUFFER = 1
COMMAND_TYPE_CAPS = 2


def recv_exact(sock, n):
    data = b''
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise EOFError('peer closed')
        data += chunk
    return data


def ts_aligned(data):
    if len(data) % 188 != 0:
        return False
    return all(
        data[off] == 0x47 and data[off + 1] != 0x47 for off in range(0, len(data), 188)
    )


def main():
    edge = sys.argv[1]
    n_buffers = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[2] == '--buffers' else 1

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(edge)
    print(json.dumps({'event': 'client-connected'}), flush=True)

    # --- CAPS must arrive first, before any buffer ---
    header, fds, _flags, _addr = socket.recv_fds(sock, HEADER.size, 4)
    cmd, size = HEADER.unpack(header)
    if cmd != COMMAND_TYPE_CAPS or fds:
        print(json.dumps({'error': f'expected CAPS first, got cmd={cmd} fds={len(fds)}'}), flush=True)
        return 1
    caps = recv_exact(sock, size)
    print(json.dumps({'caps': caps.rstrip(b'\0').decode()}), flush=True)

    for i in range(n_buffers):
        header, fds, _flags, _addr = socket.recv_fds(sock, HEADER.size, 4)
        cmd, size = HEADER.unpack(header)
        if cmd != COMMAND_TYPE_NEW_BUFFER or len(fds) != 1:
            print(json.dumps({'error': f'buffer {i}: expected NEW_BUFFER+1fd, got cmd={cmd} fds={len(fds)}'}), flush=True)
            return 1
        payload = recv_exact(sock, size)
        (buf_id, pts, dts, duration, offset, offset_end, flags_, mem_type, n_memory, n_meta) = (
            NEW_BUFFER.unpack(payload[: NEW_BUFFER.size])
        )
        mem_size, mem_offset = MEMORY.unpack(
            payload[NEW_BUFFER.size : NEW_BUFFER.size + MEMORY.size]
        )
        data = os.pread(fds[0], mem_size, mem_offset)
        os.close(fds[0])
        print(
            json.dumps(
                {
                    'result': {
                        'n': i,
                        'id': buf_id,
                        'ptsValid': 0 < pts < 2**63,
                        'noneFields': all(
                            v == 0xFFFFFFFFFFFFFFFF for v in (dts, duration, offset, offset_end)
                        ),
                        'flags': flags_,
                        'memType': mem_type,
                        'nMemory': n_memory,
                        'nMeta': n_meta,
                        'memSize': mem_size,
                        'memOffset': mem_offset,
                        'tsAligned': ts_aligned(data),
                    }
                }
            ),
            flush=True,
        )
        sock.sendall(HEADER.pack(COMMAND_TYPE_RELEASE_BUFFER, 8) + struct.pack('<Q', buf_id))

    print(json.dumps({'event': 'done'}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
