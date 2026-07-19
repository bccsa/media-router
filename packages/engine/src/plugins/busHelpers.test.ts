import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    buildBusSrc,
    buildBusSink,
    busSocketPath,
    busTeeName,
    busEdgeSocketPath,
    busIngestSocketPath,
    BUS_WATCHDOG_PREFIX,
} from './busHelpers.js';

describe('bus socket-path helpers', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('derives the channel socket path from the port, honouring MR_BUS_SOCKET_DIR', () => {
        expect(busSocketPath(40001)).toBe('/tmp/mr-bus-40001.sock');
        vi.stubEnv('MR_BUS_SOCKET_DIR', '/run/mr');
        expect(busSocketPath(40001)).toBe('/run/mr/mr-bus-40001.sock');
    });

    it('derives the non-gst producer ingest socket from the port, honouring MR_BUS_SOCKET_DIR', () => {
        expect(busIngestSocketPath(40001)).toBe('/tmp/mr-bus-40001-ingest.sock');
        vi.stubEnv('MR_BUS_SOCKET_DIR', '/run/mr');
        expect(busIngestSocketPath(40001)).toBe('/run/mr/mr-bus-40001-ingest.sock');
    });

    it('derives deterministic tee + per-edge socket names from the port', () => {
        expect(busTeeName(40001)).toBe('busout_40001');
        // Per-edge socket: stable per (port, connId), short enough for AF_UNIX.
        const a = busEdgeSocketPath(40001, 'srt-input-x:mpegts-out-mpegts-muxer-y:audio-0');
        const b = busEdgeSocketPath(40001, 'srt-input-x:mpegts-out-mpegts-muxer-y:audio-0');
        const c = busEdgeSocketPath(40001, 'srt-input-x:mpegts-out-audio-decoder-z:mpegts-in');
        expect(a).toBe(b); // deterministic
        expect(a).not.toBe(c); // distinct consumers → distinct sockets
        expect(a.startsWith('/tmp/mr-bus-40001-')).toBe(true);
        expect(a.endsWith('.sock')).toBe(true);
        expect(a.length).toBeLessThan(108); // AF_UNIX path cap
        vi.stubEnv('MR_BUS_SOCKET_DIR', '/run/mr');
        expect(busEdgeSocketPath(40001, a).startsWith('/run/mr/')).toBe(true);
    });
});

describe('buildBusSrc', () => {
    it('emits unixfdsrc on the channel socket with a leaky deep ingress queue', () => {
        // LEAKY deep ingress (5 s, above any steady-state skew): consumers
        // must never stop draining their socket — stock unixfdsink blocks in
        // send under its object lock, so a back-pressuring consumer freezes
        // its upstream producer and the stall cascades through the graph.
        expect(buildBusSrc({ name: 'busin', port: 40001 })).toBe(
            'unixfdsrc name=busin socket-path=/tmp/mr-bus-40001.sock' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0',
        );
    });

    it('omits the name clause when no name is given', () => {
        expect(buildBusSrc({ port: 40001 })).toBe(
            'unixfdsrc socket-path=/tmp/mr-bus-40001.sock' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0',
        );
    });

    it('connects to the per-consumer edge socket when supplied', () => {
        const edge = '/tmp/mr-bus-40001-ab12cd.sock';
        expect(buildBusSrc({ port: 40001, socketPath: edge })).toBe(
            `unixfdsrc socket-path=${edge}` +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0',
        );
        // Falls back to the channel socket when no edge socket is given.
        expect(buildBusSrc({ port: 40001 })).toContain(
            'socket-path=/tmp/mr-bus-40001.sock',
        );
    });

    it('inserts a named watchdog before the queue when stallTimeoutMs is set', () => {
        expect(BUS_WATCHDOG_PREFIX).toBe('buswd');
        // Watchdog sits between the unixfdsrc and the queue so it sees exactly
        // what the socket delivers — downstream back-pressure can't fake a
        // source stall.
        expect(buildBusSrc({ name: 'busin', port: 40001, stallTimeoutMs: 4000 })).toBe(
            'unixfdsrc name=busin socket-path=/tmp/mr-bus-40001.sock' +
                ' ! watchdog name=buswd_busin timeout=4000' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0',
        );
    });

    it('keys the watchdog name by port when the src is unnamed', () => {
        expect(buildBusSrc({ port: 40001, stallTimeoutMs: 5000 })).toContain(
            ' ! watchdog name=buswd_40001 timeout=5000 ! ',
        );
    });

    it('omits the watchdog when stallTimeoutMs is unset', () => {
        expect(buildBusSrc({ port: 40001 })).not.toContain('watchdog');
    });

    it('combines an edge socket with the stall watchdog (the live consumer shape)', () => {
        const edge = '/tmp/mr-bus-40001-ab12cd.sock';
        expect(buildBusSrc({ name: 'busin', port: 40001, socketPath: edge, stallTimeoutMs: 5000 })).toBe(
            `unixfdsrc name=busin socket-path=${edge}` +
                ' ! watchdog name=buswd_busin timeout=5000' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0',
        );
    });
});

describe('buildBusSink', () => {
    it('pins TS caps and fans out on a per-port tee with allow-not-linked', () => {
        // The egress is a tee (named by port) with allow-not-linked so the
        // producer runs with zero consumers; the actual unixfdsink branches
        // are attached per consumer at runtime (bus_attach). TS capsfilter is
        // pinned before the tee (unixfd consumers fail not-negotiated without
        // caps) and inherited by every branch.
        expect(buildBusSink(40001)).toBe(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'tee name=busout_40001 allow-not-linked=true',
        );
    });
});
