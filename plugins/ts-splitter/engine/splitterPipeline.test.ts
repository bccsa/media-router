import { describe, it, expect } from 'vitest';
import { buildSplitterPipeline, pidAppsrcName, INPUT_APPSINK } from './splitterPipeline.js';

const INPUT = { port: 40000, socketPath: '/tmp/mr-bus-40000-abc123.sock' };
const OUTS = [
    { pid: 0x65, streamType: 0x1b, port: 40010 },
    { pid: 0xc9, streamType: 0x0f, port: 40011 },
];

describe('pidAppsrcName', () => {
    it('is hex-derived and stable', () => {
        expect(pidAppsrcName(0x65)).toBe('out_0x65');
        expect(pidAppsrcName(0x1a4)).toBe('out_0x1a4');
    });
});

describe('buildSplitterPipeline', () => {
    it('reads the consumer edge socket into the appsink and fans each PID out via a bus tee', () => {
        const { pipeline, tsSplit } = buildSplitterPipeline({ input: INPUT, outputs: OUTS });

        expect(pipeline).toContain(
            'unixfdsrc name=netin socket-path=/tmp/mr-bus-40000-abc123.sock' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0' +
                ` ! appsink name=${INPUT_APPSINK}`,
        );
        expect(pipeline).toContain('appsrc name=out_0x65');
        expect(pipeline).toContain('appsrc name=out_0xc9');
        expect(pipeline).toContain('leaky-type=downstream max-bytes=4194304');
        expect(pipeline).toContain('do-timestamp=true');
        expect(pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'tee name=busout_40010 allow-not-linked=true',
        );
        expect(pipeline).toContain('tee name=busout_40011 allow-not-linked=true');
        expect(pipeline).not.toContain('udpsrc');
        expect(pipeline).not.toContain('udpsink');

        expect(tsSplit).toEqual({
            inputAppsink: INPUT_APPSINK,
            tsId: 1,
            outputs: [
                // port enables the runner's wired-only gating (busout_<port>)
                { pid: 0x65, appsrc: 'out_0x65', streamType: 0x1b, port: 40010 },
                { pid: 0xc9, appsrc: 'out_0xc9', streamType: 0x0f, port: 40011 },
            ],
        });
    });

    it('has no second explicit ingress queue — buildBusSrc\'s own 5 s leaky queue is the drain contract', () => {
        const { pipeline } = buildSplitterPipeline({ input: INPUT, outputs: OUTS });
        expect(pipeline.match(/queue leaky=/g)).toHaveLength(1);
        expect(pipeline).not.toContain('max-size-time=1000000000');
    });

    it('falls back to the channel-level socket when no edge socketPath is handed out', () => {
        const { pipeline } = buildSplitterPipeline({ input: { port: 40000 }, outputs: [] });
        expect(pipeline).toContain('unixfdsrc name=netin socket-path=/tmp/mr-bus-40000.sock');
    });

    it('honors tsId', () => {
        const { tsSplit } = buildSplitterPipeline({ input: INPUT, outputs: [], tsId: 7 });
        expect(tsSplit.tsId).toBe(7);
        expect(tsSplit.outputs).toEqual([]);
    });

    it('input-only pipeline still terminates in the appsink (discovery-first)', () => {
        const { pipeline, tsSplit } = buildSplitterPipeline({ input: INPUT, outputs: [] });
        expect(pipeline).toContain(`appsink name=${INPUT_APPSINK}`);
        expect(pipeline).not.toContain('appsrc');
        expect(tsSplit.outputs).toEqual([]);
    });
});
