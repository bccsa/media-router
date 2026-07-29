#!/usr/bin/env python3
"""Test client for unixfd-fanout.py — a minimal unixfdsrc stand-in.

Connects to an edge socket, expects CAPS first, then `--buffers N` NEW_BUFFER
messages with passed fds; validates the 56-byte payload layout, the fd's
content, and TS packet alignment (0x47 at every 188-byte stride — the test
producer sends packets shaped 0x47 + 187×0xAA so all-0x47 data can't fake
alignment); sends RELEASE_BUFFER back for each (the sidecar must drain it),
and prints one JSON verdict per buffer.

Usage: unixfd-fanout.test-client.py <edge socket> [--buffers N]
       unixfd-fanout.test-client.py <edge socket> --capture <file>
                                    [--expect-bytes N]

--capture mode (mrTssplit.test.ts): consume NEW_BUFFERs into <file>, releasing
each buffer, and print a verdict with byte/buffer totals and the stream sha256.
Ends after --expect-bytes bytes when given (deterministic — required by hash
comparisons), otherwise when the peer closes the connection.
"""

import hashlib
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


_U64 = struct.Struct('<Q')
_RELEASE_HDR = HEADER.pack(COMMAND_TYPE_RELEASE_BUFFER, 8)


def capture(sock, path, expect_bytes=0):
    """Consume buffers into `path`, reporting a verdict when done.

    `expect_bytes` > 0 makes termination DETERMINISTIC: the capture ends as
    soon as that many payload bytes have arrived. Callers that compare a
    whole-stream hash MUST use it — the alternative (ending on `bus_detach`)
    truncates the capture, because detaching closes the client socket and
    discards whatever the fan-out still had queued for it. That is correct
    producer behaviour (a detached consumer is gone), so the test must let
    the data arrive first rather than race it. With `expect_bytes` == 0 the
    capture simply runs until the peer closes.

    The receive loop is deliberately lean: the fan-out sheds any message left
    unsent past its 500 ms leaky budget, so a slow consumer loses bytes.
    Payloads are only appended to a list here — the file write and the sha256
    happen once at the end — and the per-buffer struct work uses unpack_from
    (no slice copies) with a pre-packed RELEASE header.
    """
    sock.settimeout(15)
    chunks = []
    buffers = total = 0
    while True:
        # The ENTIRE exchange is guarded: a `bus_detach` closes this socket at
        # an arbitrary point, so the disconnect can land mid-message (between
        # the header and its payload) or while the RELEASE is going out. That
        # is a normal end of capture, not an error — but recv_exact raises
        # EOFError and sendall raises OSError, which unguarded would kill the
        # client before it prints its verdict (observed as an intermittent
        # "timed out waiting for capture verdict" under parallel load).
        fds = []
        try:
            header, fds, _flags, _addr = socket.recv_fds(sock, HEADER.size, 4)
            if not header:
                break                        # clean EOF at a message boundary
            cmd, size = HEADER.unpack(header)
            payload = recv_exact(sock, size)
            if cmd == COMMAND_TYPE_CAPS:
                # Proof of ACCEPTANCE (not just connect) — the test gates data
                # flow on this so no broadcast can precede the accept.
                print(json.dumps({'caps': payload.rstrip(b'\0').decode()}), flush=True)
                continue
            if cmd != COMMAND_TYPE_NEW_BUFFER:
                continue
            if len(fds) != 1:
                print(json.dumps({'error': f'buffer without fd (fds={len(fds)})'}),
                      flush=True)
                return 1
            mem_size, mem_offset = MEMORY.unpack_from(payload, NEW_BUFFER.size)
            data = os.pread(fds[0], mem_size, mem_offset)
            chunks.append(data)
            buffers += 1
            total += len(data)
            sock.sendall(_RELEASE_HDR + _U64.pack(_U64.unpack_from(payload, 0)[0]))
            if expect_bytes and total >= expect_bytes:
                break                        # deterministic end — see docstring
        except (OSError, EOFError):
            break                            # edge detached — normal end
        finally:
            for fd in fds:
                try:
                    os.close(fd)
                except OSError:
                    pass
    blob = b''.join(chunks)
    with open(path, 'wb') as out:
        out.write(blob)
    print(json.dumps({'captured': {'buffers': buffers, 'bytes': total,
                                   'sha256': hashlib.sha256(blob).hexdigest()}}), flush=True)
    return 0


def main():
    edge = sys.argv[1]
    n_buffers = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[2] == '--buffers' else 1

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(edge)
    print(json.dumps({'event': 'client-connected'}), flush=True)

    if len(sys.argv) > 3 and sys.argv[2] == '--capture':
        expect = 0
        if len(sys.argv) > 5 and sys.argv[4] == '--expect-bytes':
            expect = int(sys.argv[5])
        return capture(sock, sys.argv[3], expect)

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
