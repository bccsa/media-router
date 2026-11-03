import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
    buildBusDemux,
    buildBusSrc,
    buildBusSink,
    buildTsUdpInput,
    busSocketPath,
    busTeeName,
    busEdgeSocketPath,
    busIngestSocketPath,
    busSocketPort,
    BUS_TS_CAPS,
    BUS_WATCHDOG_PREFIX,
    quoteGstString,
    latInName,
    latOutName,
    shortHash,
    type BusDemuxOpts,
} from './busHelpers.js';
import { setLatenessTapAvailable } from './latenessTap.js';
import { buildBackpressureQueue } from './tsHelpers.js';

describe('quoteGstString', () => {
    it('wraps a value in double quotes', () => {
        expect(quoteGstString('rist://h:5004?weight=5&cname=a b')).toBe(
            '"rist://h:5004?weight=5&cname=a b"',
        );
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

    it('reads the channel port back from each bus socket path, nothing from any other (B-194)', () => {
        expect(busSocketPort(busEdgeSocketPath(40010, 'tc-chat:out-0-aout:audio-in'))).toBe(40010);
        expect(busSocketPort(busSocketPath(40002))).toBe(40002);
        expect(busSocketPort(busIngestSocketPath(40003))).toBe(40003);
        vi.stubEnv('MR_BUS_SOCKET_DIR', '/run/mr');
        expect(busSocketPort(busEdgeSocketPath(41000, 'c'))).toBe(41000);
        expect(busSocketPort('/tmp/other.sock')).toBeUndefined();
        expect(busSocketPort('/tmp/mr-bus-x-1.sock')).toBeUndefined();
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
        expect(buildBusSrc({ port: 40001 })).toContain('socket-path=/tmp/mr-bus-40001.sock');
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
        expect(
            buildBusSrc({ name: 'busin', port: 40001, socketPath: edge, stallTimeoutMs: 5000 }),
        ).toBe(
            `unixfdsrc name=busin socket-path=${edge}` +
                ' ! watchdog name=buswd_busin timeout=5000' +
                ' ! mrlateness name=lat_busin reference=house' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000',
        );
    });
});

describe('buildTsUdpInput', () => {
    it('chains unixfdsrc bus ingress → jitter queue, and nothing after it (WI-P3-18)', () => {
        const s = buildTsUdpInput({ port: 5500 });
        // Bus ingress connects the channel socket (caps arrive over the socket)
        expect(s).toContain('unixfdsrc socket-path=/tmp/mr-bus-5500.sock');
        // buildBusSrc's leaky deep ingress queue (5 s)
        expect(s).toContain('queue leaky=2 max-size-time=5000000000');
        // jitter queue defaults to 200 ms and BACK-PRESSURES (leaky=0): raw TS
        // must never be shed mid-slice — see buildTsUdpInput.
        expect(s).toContain('queue leaky=0 max-size-time=200000000');
        expect(s).not.toContain('leaky=2 max-size-time=200000000');
        // The jitter queue is last: the bus's whole-packet buffers (ADR-0011) reach the
        // consumer's demux as sent, and the demux re-frames any other split itself.
        expect(s).toBe(`${buildBusSrc({ port: 5500 })} ! ${buildBackpressureQueue(200)}`);
    });
    it('honours a custom jitterMs', () => {
        const s = buildTsUdpInput({ port: 1, jitterMs: 100 });
        expect(s).toContain('max-size-time=100000000');
    });
    it('connects to the per-consumer edge socket when supplied', () => {
        const s = buildTsUdpInput({ port: 1, socketPath: '/tmp/mr-bus-1-ab12cd.sock' });
        expect(s).toContain('unixfdsrc socket-path=/tmp/mr-bus-1-ab12cd.sock');
    });
    it('inserts the bus stall watchdog when stallTimeoutMs is set', () => {
        const s = buildTsUdpInput({ port: 1, udpsrcName: 'in0', stallTimeoutMs: 5000 });
        expect(s).toContain(' ! watchdog name=buswd_in0 timeout=5000 ! ');
    });
    it('emits the optional element name on the unixfdsrc', () => {
        const s = buildTsUdpInput({ port: 1, udpsrcName: 'in0' });
        expect(s).toContain('unixfdsrc name=in0');
    });
    it('neither re-frames nor re-times a bus buffer: no tsparse (WI-P3-18, OQ-26)', () => {
        // The `tsparse set-timestamps=false` it ended in re-framed for tsdemux and cleared
        // every buffer flag on the way, a gap marker's GAP and DISCONT included (B-144).
        const s = buildTsUdpInput({
            port: 1,
            udpsrcName: 'in0',
            stallTimeoutMs: 5000,
            jitterMs: 100,
        });
        expect(s).not.toContain('tsparse');
        expect(s).not.toContain('set-timestamps');
        expect(s).toMatch(
            / ! queue leaky=0 max-size-time=100000000 max-size-buffers=0 max-size-bytes=0$/,
        );
    });
});

describe('buildBusDemux (B-145)', () => {
    const INGRESS =
        ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000';
    const jitter = (ms: number) =>
        ` ! queue leaky=0 max-size-time=${ms * 1_000_000} max-size-buffers=0 max-size-bytes=0`;
    const EDGE = '/tmp/mr-bus-40001-ab12cd.sock';

    it('is the bus source and the demux alone by default: demux mode, every pad class', () => {
        expect(buildBusDemux({ port: 40001, name: 'demux' })).toBe(
            'unixfdsrc socket-path=/tmp/mr-bus-40001.sock' +
                ' ! mrlateness name=lat_busin_40001 reference=house' +
                `${INGRESS} ! mrtsdemux name=demux`,
        );
        expect(buildBusDemux({ port: 40001, name: 'demux' })).toBe(
            `${buildBusSrc({ port: 40001 })} ! mrtsdemux name=demux`,
        );
    });

    it('hands socketPath, srcName and stallTimeoutMs to buildBusSrc', () => {
        expect(
            buildBusDemux({
                port: 40001,
                socketPath: EDGE,
                srcName: 'busin_0',
                stallTimeoutMs: 5000,
                name: 'demux_0',
            }),
        ).toBe(
            `${buildBusSrc({ port: 40001, socketPath: EDGE, name: 'busin_0', stallTimeoutMs: 5000 })}` +
                ' ! mrtsdemux name=demux_0',
        );
        // Unnamed, the tap is keyed by the edge socket, as buildBusSrc keys it.
        expect(buildBusDemux({ port: 40001, socketPath: EDGE, name: 'd' })).toContain(
            `unixfdsrc socket-path=${EDGE} ! mrlateness name=lat_busin_40001_${shortHash(EDGE)} `,
        );
    });

    it('select: select mode, the one stream of those caps', () => {
        expect(
            buildBusDemux({ port: 40001, name: 'mixin_demux0', select: 'audio/x-smpte-302m' }),
        ).toBe(
            `${buildBusSrc({ port: 40001 })} ! mrtsdemux name=mixin_demux0 select=audio/x-smpte-302m`,
        );
    });

    it('media: demux mode on those pad classes only', () => {
        expect(buildBusDemux({ port: 40001, name: 'addemux', media: 'audio' })).toBe(
            `${buildBusSrc({ port: 40001 })} ! mrtsdemux name=addemux media=audio`,
        );
        expect(buildBusDemux({ port: 40001, name: 'd', media: 'video,private' })).toMatch(
            / ! mrtsdemux name=d media=video,private$/,
        );
    });

    it("jitterMs: buildTsUdpInput's back-pressuring jitter queue before the demux", () => {
        const s = buildBusDemux({ port: 41000, srcName: 'busin', jitterMs: 200, name: 'demux' });
        expect(s).toBe(
            `${buildTsUdpInput({ port: 41000, udpsrcName: 'busin', jitterMs: 200 })} ! mrtsdemux name=demux`,
        );
        expect(s).toBe(
            `${buildBusSrc({ port: 41000, name: 'busin' })} ! ${buildBackpressureQueue(200)}` +
                ' ! mrtsdemux name=demux',
        );
        // Unset there is no jitter queue at all; 0 is a queue at the helper's 20 ms floor.
        expect(buildBusDemux({ port: 41000, name: 'demux' })).not.toContain('leaky=0');
        expect(buildBusDemux({ port: 41000, jitterMs: 0, name: 'demux' })).toContain(
            `${jitter(20)} ! mrtsdemux name=demux`,
        );
    });

    it('tee: a tee before the demux for a tap; queue: a plain queue between the two', () => {
        const base = { port: 40001, jitterMs: 200, name: 'demux', media: 'private' };
        expect(buildBusDemux({ ...base, tee: { name: 'vp_ts' } })).toBe(
            `${buildTsUdpInput({ port: 40001 })} ! tee name=vp_ts ! mrtsdemux name=demux media=private`,
        );
        expect(buildBusDemux({ ...base, tee: { name: 'in_t', queue: true } })).toBe(
            `${buildTsUdpInput({ port: 40001 })} ! tee name=in_t ! queue ! mrtsdemux name=demux media=private`,
        );
    });

    it("builds each consumer's segment as it stood before the helper, byte for byte", () => {
        const src = (port: number, name?: string) =>
            `unixfdsrc${name ? ` name=${name}` : ''} socket-path=/tmp/mr-bus-${port}.sock`;
        const tap = (key: string) => ` ! mrlateness name=lat_busin${key} reference=house`;
        const cases: Array<[string, BusDemuxOpts, string]> = [
            [
                '302M fan-in branch',
                { port: 40001, name: 'mixin_demux0', select: 'audio/x-smpte-302m' },
                `${src(40001)}${tap('_40001')}${INGRESS} ! mrtsdemux name=mixin_demux0 select=audio/x-smpte-302m`,
            ],
            [
                'AES67 Output',
                {
                    port: 41000,
                    srcName: 'busin',
                    jitterMs: 200,
                    name: 'demux',
                    select: 'audio/x-smpte-302m',
                },
                `${src(41000, 'busin')}${tap('')}${INGRESS}${jitter(200)} ! mrtsdemux name=demux select=audio/x-smpte-302m`,
            ],
            [
                'Audio Decoder',
                { port: 41000, name: 'addemux', media: 'audio' },
                `${src(41000)}${tap('_41000')}${INGRESS} ! mrtsdemux name=addemux media=audio`,
            ],
            [
                'Audio Transcoder',
                { port: 40001, name: 'demux', media: 'audio' },
                `${src(40001)}${tap('_40001')}${INGRESS} ! mrtsdemux name=demux media=audio`,
            ],
            [
                'MPEG-TS Muxer input 1',
                { port: 40002, srcName: 'busin_1', name: 'demux_1' },
                `${src(40002, 'busin_1')}${tap('_1')}${INGRESS} ! mrtsdemux name=demux_1`,
            ],
            [
                'subtitle input',
                { port: 40500, jitterMs: 200, name: 'subdemux', media: 'private' },
                `${src(40500)}${tap('_40500')}${INGRESS}${jitter(200)} ! mrtsdemux name=subdemux media=private`,
            ],
            [
                'Teletext Subtitles',
                {
                    port: 40600,
                    jitterMs: 200,
                    tee: { name: 'in_t', queue: true },
                    name: 'demux',
                    media: 'private',
                },
                `${src(40600)}${tap('_40600')}${INGRESS}${jitter(200)}` +
                    ' ! tee name=in_t ! queue ! mrtsdemux name=demux media=private',
            ],
            [
                'Video Transcoder',
                { port: 40001, jitterMs: 300, name: 'demux', media: 'video' },
                `${src(40001)}${tap('_40001')}${INGRESS}${jitter(300)} ! mrtsdemux name=demux media=video`,
            ],
            [
                'Video Player',
                {
                    port: 40001,
                    stallTimeoutMs: 5000,
                    jitterMs: 200,
                    tee: { name: 'vp_ts' },
                    name: 'vpdemux',
                    media: 'video',
                },
                `${src(40001)} ! watchdog name=buswd_40001 timeout=5000${tap('_40001')}${INGRESS}` +
                    `${jitter(200)} ! tee name=vp_ts ! mrtsdemux name=vpdemux media=video`,
            ],
        ];
        for (const [consumer, opts, want] of cases) {
            expect(buildBusDemux(opts), consumer).toBe(want);
        }
    });
});

describe('every mrtsdemux in a launch string comes from buildBusDemux (B-145)', () => {
    it('no other source writes the element: one place builds every bus input', () => {
        const root = join(__dirname, '..', '..', '..', '..');
        const sources = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
                const path = join(dir, e.name);
                if (e.isDirectory())
                    return ['node_modules', 'testing'].includes(e.name) ? [] : sources(path);
                return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
            });
        // Every package's sources and every plugin's engine half, without tests and test helpers.
        const files = ['packages', 'plugins'].flatMap((top) =>
            readdirSync(join(root, top))
                .map((name) => join(root, top, name, top === 'packages' ? 'src' : 'engine'))
                .filter((dir) => existsSync(dir))
                .flatMap(sources),
        );
        // A launch string's element: linked (`! mrtsdemux`) or given a property, outside comments.
        const writers = files.filter((f) =>
            readFileSync(f, 'utf8')
                .split('\n')
                .some(
                    (line) =>
                        !/^\s*(\*|\/\/|\/\*)/.test(line) &&
                        /!\s*mrtsdemux\b|\bmrtsdemux\s+[\w-]+=/.test(line),
                ),
        );
        expect(writers.map((f) => relative(root, f))).toEqual([
            'packages/engine/src/plugins/busHelpers.ts',
        ]);
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
                'mrlateness name=lat_busout_40001 reference=running-time ! ' +
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

    it('publishes the same caps as the mr-bus-fanout sidecar', () => {
        // Both producer paths (GStreamer tee here, mr-bus-fanout --caps for
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
        expect(buildBusDemux({ port: 40001, jitterMs: 200, name: 'demux' })).toBe(
            'unixfdsrc socket-path=/tmp/mr-bus-40001.sock' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000' +
                ' ! queue leaky=0 max-size-time=200000000 max-size-buffers=0 max-size-bytes=0' +
                ' ! mrtsdemux name=demux',
        );
    });
});
