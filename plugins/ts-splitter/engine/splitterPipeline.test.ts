import { describe, it, expect, afterEach } from 'vitest';
import { buildSplitterPipeline, pidAppsrcName, INPUT_APPSINK } from './splitterPipeline.js';

const INPUT = { host: '239.255.0.1', port: 40000 };
const OUTS = [
    { pid: 0x65, streamType: 0x1b, host: '239.255.0.1', port: 40010 },
    { pid: 0xc9, streamType: 0x0f, host: '239.255.0.1', port: 40011 },
];

const savedTransport = process.env.MR_BUS_TRANSPORT;
afterEach(() => {
    if (savedTransport === undefined) delete process.env.MR_BUS_TRANSPORT;
    else process.env.MR_BUS_TRANSPORT = savedTransport;
});

describe('pidAppsrcName', () => {
    it('is hex-derived and stable', () => {
        expect(pidAppsrcName(0x65)).toBe('out_0x65');
        expect(pidAppsrcName(0x1a4)).toBe('out_0x1a4');
    });
});

describe('buildSplitterPipeline (udp transport)', () => {
    it('builds udpsrc + explicit leaky ingress queue + appsink, udpsink outputs', () => {
        delete process.env.MR_BUS_TRANSPORT;
        const { pipeline, tsSplit } = buildSplitterPipeline({ input: INPUT, outputs: OUTS });

        expect(pipeline).toContain('udpsrc');
        expect(pipeline).toContain('multicast-group=239.255.0.1');
        expect(pipeline).toContain(
            'queue leaky=2 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0',
        );
        expect(pipeline).toContain(`appsink name=${INPUT_APPSINK}`);
        expect(pipeline).toContain('appsrc name=out_0x65');
        expect(pipeline).toContain('appsrc name=out_0xc9');
        expect(pipeline).toContain('leaky-type=downstream max-bytes=4194304');
        expect(pipeline).toContain('do-timestamp=true');
        expect(pipeline).toContain('udpsink name=usink_0x65');
        // appsrc is-live does NOT exempt the branch from preroll (gst 1.22):
        // a dark output must not wedge the pipeline in PAUSED.
        expect(pipeline).toMatch(/udpsink name=usink_0x65[^!]*async=false/);
        expect(pipeline).not.toContain('unixfdsrc');
        expect(pipeline).not.toContain('busout_');

        expect(tsSplit).toEqual({
            inputAppsink: INPUT_APPSINK,
            tsId: 1,
            outputs: [
                { pid: 0x65, appsrc: 'out_0x65', streamType: 0x1b },
                { pid: 0xc9, appsrc: 'out_0xc9', streamType: 0x0f },
            ],
        });
    });

    it('honors tsId', () => {
        delete process.env.MR_BUS_TRANSPORT;
        const { tsSplit } = buildSplitterPipeline({ input: INPUT, outputs: [], tsId: 7 });
        expect(tsSplit.tsId).toBe(7);
        expect(tsSplit.outputs).toEqual([]);
    });
});

describe('buildSplitterPipeline (unixfd transport)', () => {
    it('uses the consumer edge socket in and fan-out tees out, no doubled queue', () => {
        process.env.MR_BUS_TRANSPORT = 'unixfd';
        const { pipeline } = buildSplitterPipeline({
            input: { ...INPUT, socketPath: '/tmp/mr-bus-40000-abc123.sock' },
            outputs: OUTS,
        });

        expect(pipeline).toContain('unixfdsrc');
        expect(pipeline).toContain('socket-path=/tmp/mr-bus-40000-abc123.sock');
        expect(pipeline).toContain(`appsink name=${INPUT_APPSINK}`);
        // buildUdpSrc's own 5s ingress queue only — no second explicit queue
        expect(pipeline).not.toContain('max-size-time=1000000000');
        expect(pipeline).toContain('tee name=busout_40010 allow-not-linked=true');
        expect(pipeline).toContain('tee name=busout_40011 allow-not-linked=true');
        expect(pipeline).not.toContain('udpsink');
    });

    it('input-only pipeline still terminates in the appsink (discovery-first)', () => {
        process.env.MR_BUS_TRANSPORT = 'unixfd';
        const { pipeline, tsSplit } = buildSplitterPipeline({
            input: { ...INPUT, socketPath: '/tmp/mr-bus-40000-abc123.sock' },
            outputs: [],
        });
        expect(pipeline).toContain(`appsink name=${INPUT_APPSINK}`);
        expect(pipeline).not.toContain('appsrc');
        expect(tsSplit.outputs).toEqual([]);
    });
});
