import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture gst-launch invocations instead of spawning anything.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
    execFile: execFileMock,
}));

import { setLogTap } from '@media-router/shared-types';
import {
    probeMpegTsStream,
    registerCodecClassifier,
    _resetCodecClassifiersForTests,
} from './MpegTsProbe.js';
import { busSocketPath, busEdgeSocketPath } from '../plugins/busHelpers.js';

/** Resolve the mocked execFile with the given -v output. Async on purpose —
 *  the real callback never fires synchronously, and the probe's safety timer
 *  is declared after the execFile call. */
function answerWith(output: string): void {
    execFileMock.mockImplementation(
        (
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string, stderr: string) => void,
        ) => {
            setImmediate(() => cb(null, output, ''));
            return { kill: vi.fn() };
        },
    );
}

describe('probeMpegTsStream pipeline args', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('probes the supplied per-consumer edge socket via unixfdsrc', async () => {
        const edge = busEdgeSocketPath(41000, 'conn-1');
        answerWith('');
        await probeMpegTsStream(41000, 100, edge);
        const [cmd, args] = execFileMock.mock.calls[0];
        expect(cmd).toBe('gst-launch-1.0');
        expect(args).toContain('unixfdsrc');
        expect(args).toContain(`socket-path=${edge}`);
        expect(args).toContain('num-buffers=50');
        expect(args.join(' ')).not.toContain('udpsrc');
    });

    it('falls back to the channel-level socket when no edge socket is supplied', async () => {
        answerWith('');
        await probeMpegTsStream(41000, 100);
        const [, args] = execFileMock.mock.calls[0];
        expect(args).toContain(`socket-path=${busSocketPath(41000)}`);
    });

    it('parses negotiated caps from the gst-launch -v output', async () => {
        answerWith('caps = audio/x-opus, rate=(int)48000, channels=(int)2');
        const result = await probeMpegTsStream(41000, 100);
        expect(result.sampleRate).toBe(48000);
        expect(result.channels).toBe(2);
    });

    it('resolves codec=unknown when no audio caps appear before the timeout', async () => {
        answerWith('nothing negotiated');
        const result = await probeMpegTsStream(41000, 100);
        expect(result.codec).toBe('unknown');
        expect(result.rawCaps).toBe('');
    });

    it('logs nothing per run: 60 runs on an idle source, then one with audio (B-201)', async () => {
        // A warning per miss, every 10 s per idle transcoder, filled the engine's 1000-line log.
        const lines: Array<{ name: string; msg: string }> = [];
        registerCodecClassifier({
            test: (c) => c.startsWith('audio/x-opus'),
            classify: () => 'opus',
        });
        setLogTap((l) => lines.push(JSON.parse(l)));
        try {
            answerWith('Setting pipeline to PAUSED ...\nPipeline is PREROLLING ...\n');
            for (let i = 0; i < 60; i++) {
                expect(await probeMpegTsStream(41000, 100)).toEqual({
                    codec: 'unknown',
                    rawCaps: '',
                });
            }
            answerWith('caps = audio/x-opus, rate=(int)48000, channels=(int)2');
            expect((await probeMpegTsStream(41000, 100)).codec).toBe('opus');
        } finally {
            setLogTap(null);
            _resetCodecClassifiersForTests();
        }
        expect(execFileMock).toHaveBeenCalledTimes(61);
        expect(lines).toEqual([]);
    });
});
