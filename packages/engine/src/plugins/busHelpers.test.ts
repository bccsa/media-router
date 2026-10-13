import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    buildBusSrc,
    buildBusSink,
    busSocketPath,
    busTeeName,
    busEdgeSocketPath,
    busIngestSocketPath,
    BUS_TS_CAPS,
    BUS_WATCHDOG_PREFIX,
    quoteGstString,
    latInName,
    latOutName,
    shortHash,
} from './busHelpers.js';
import { setLatenessTapAvailable } from './latenessTap.js';

describe('quoteGstString', () => {
    it('wraps a value in double quotes', () => {
        expect(quoteGstString('rist://h:5004?weight=5&cname=a b')).toBe('"rist://h:5004?weight=5&cname=a b"');
    });

    it('escapes embedded quotes and backslashes for gst-launch', () => {
        expect(quoteGstString('say "hi"')).toBe('"say \\"hi\\""');
        expect(quoteGstString('a\\b')).toBe('"a\\\\b"');
    });
});

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
                ' ! mrlateness name=lat_busin reference=house' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000',
        );
    });

    it('omits the name clause when no name is given', () => {
        expect(buildBusSrc({ port: 40001 })).toBe(
            'unixfdsrc socket-path=/tmp/mr-bus-40001.sock' +
                ' ! mrlateness name=lat_busin_40001 reference=house' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000',
        );
    });

    it('connects to the per-consumer edge socket when supplied', () => {
        const edge = '/tmp/mr-bus-40001-ab12cd.sock';
        expect(buildBusSrc({ port: 40001, socketPath: edge })).toBe(
            `unixfdsrc socket-path=${edge}` +
                ` ! mrlateness name=lat_busin_40001_${shortHash(edge)} reference=house` +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000',
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
                ' ! mrlateness name=lat_busin reference=house' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000',
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
                ' ! mrlateness name=lat_busin reference=house' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000',
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
            `capssetter caps="${BUS_TS_CAPS}" replace=true ! ` +
                `capsfilter caps="${BUS_TS_CAPS}" ! ` +
                'mrlateness name=lat_busout_40001 reference=house ! ' +
                'tee name=busout_40001 allow-not-linked=true',
        );
    });

    it('strips upstream caps fields BEFORE the tee, so no branch inherits them', () => {
        // mpegtsmux publishes its first-generated PAT/PMT as a `streamheader`
        // caps field. unixfd carries caps verbatim and srtsink replays that
        // field to every new caller, so a stale snapshot (taken before the
        // dynamic media pads linked — wrong PCR PID, missing streams) becomes
        // every receiver's first PMT, permanently. `replace=true` is what drops
        // it; a capsfilter cannot, because caps intersection unions fields.
        const sink = buildBusSink(40001);
        expect(sink).toContain('capssetter');
        expect(sink).toContain('replace=true');
        expect(sink.indexOf('capssetter')).toBeLessThan(sink.indexOf('tee name='));
    });

    it('publishes the same caps as the unixfd-fanout sidecar', () => {
        // Both producer paths (GStreamer tee here, unixfd-fanout.py --caps for
        // non-GStreamer producers) must put IDENTICAL caps on the wire — a
        // consumer cannot tell which produced its edge.
        expect(BUS_TS_CAPS).toBe('video/mpegts, systemstream=(boolean)true, packetsize=(int)188');
        expect(buildBusSink(40001)).toContain(BUS_TS_CAPS);
    });
});

describe('bus lateness taps', () => {
    afterEach(() => setLatenessTapAvailable(true));

    it('names ingress taps lat_busin… and egress taps after the tee', () => {
        expect(latInName('busin')).toBe('lat_busin');
        expect(latInName('busin_2')).toBe('lat_busin_2');
        expect(latInName('in0')).toBe('lat_busin_in0');
        expect(latInName(40001)).toBe('lat_busin_40001');
        expect(latOutName(40001)).toBe('lat_busout_40001');
    });

    it('two edges of one channel in one pipeline get distinct taps', () => {
        const a = buildBusSrc({ port: 40001, socketPath: busEdgeSocketPath(40001, 'a') });
        const b = buildBusSrc({ port: 40001, socketPath: busEdgeSocketPath(40001, 'b') });
        const tap = (f: string) => /mrlateness name=(\S+)/.exec(f)?.[1];
        expect(tap(a)).not.toBe(tap(b));
    });

    it('omits every tap when the instrument is missing, so the pipeline still parses', () => {
        setLatenessTapAvailable(false);
        expect(buildBusSrc({ name: 'busin', port: 40001, stallTimeoutMs: 4000 })).toBe(
            'unixfdsrc name=busin socket-path=/tmp/mr-bus-40001.sock' +
                ' ! watchdog name=buswd_busin timeout=4000' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000',
        );
        expect(buildBusSink(40001)).not.toContain('mrlateness');
    });
});
