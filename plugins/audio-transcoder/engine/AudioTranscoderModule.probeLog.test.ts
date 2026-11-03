import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real probe runs; only gst-launch is answered (an idle source, then audio).
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFile: execFileMock,
}));

// Every line any logger writes, as [level, logger, msg]: what the engine's 1000-line log keeps.
const lines = vi.hoisted(() => [] as Array<[number, string, string]>);
vi.mock('@media-router/shared-types', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    const levels = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
    const createLogger = (name: string) =>
        Object.fromEntries(
            Object.entries(levels).map(([method, level]) => [
                method,
                (obj: unknown, msg?: string) =>
                    lines.push([level, name, typeof obj === 'string' ? obj : (msg ?? '')]),
            ]),
        );
    return { ...actual, createLogger };
});

import { GstPluginBase, registerCodecClassifier } from '@media-router/engine';
import { AudioTranscoderModule } from './AudioTranscoderModule.js';
import { INPUT_PORT_ID } from './audioTranscoderPorts.js';
import { REPROBE_INTERVAL_MS } from './reprobeLoop.js';

/** What `gst-launch -v` prints for a source that sends nothing before the probe's timeout. */
const IDLE_OUTPUT = 'Setting pipeline to PAUSED ...\nPipeline is PREROLLING ...\n';
/** Its output once the source sends AAC (tsdemux's pad, then parsebin's parsed caps). */
const AAC_OUTPUT = [
    '/GstPipeline:pipeline0/GstTSDemux:tsdemux0.GstPad:audio_0_0044: caps = audio/mpeg, mpegversion=(int)4, stream-format=(string)adts',
    '/GstPipeline:pipeline0/GstParseBin:parsebin0.GstGhostPad:src_0: caps = audio/mpeg, mpegversion=(int)4, framed=(boolean)true, stream-format=(string)adts, rate=(int)48000, channels=(int)2',
].join('\n');

function sourceSends(output: string): void {
    execFileMock.mockImplementation(
        (
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
            // An idle probe ends at execFile's timeout, killed; one with audio at its EOS.
            const idle = output === IDLE_OUTPUT;
            const err = idle ? Object.assign(new Error('timed out'), { killed: true }) : null;
            void Promise.resolve().then(() => cb(err, output, ''));
            return { kill: vi.fn() };
        },
    );
}

registerCodecClassifier({
    test: (caps) => caps.startsWith('audio/mpeg') && caps.includes('mpegversion=(int)4'),
    classify: () => 'aac',
});

const NAMES: Record<string, string> = { 'atx-1': 'FRA IN', 'split-1': 'VV' };

async function makeTranscoder() {
    const module = new AudioTranscoderModule() as any;
    const source = {
        port: 40013,
        socketPath: '/tmp/mr-bus-40013-f13e72.sock',
        connectionId: 'c-0',
        sourceModuleId: 'split-1',
        sourcePortId: 'pid-0x44',
        sinkPortId: INPUT_PORT_ID,
        streamType: 'muxed/mpegts',
    };
    let nextPort = 41000;
    await module.onInit(
        { renditions: [{ codec: 'opus' }] },
        {
            instanceId: 'atx-1',
            mediaRouter: {
                getModuleBusSources: () => [source],
                assignBusChannel: () => ({ port: nextPort++ }),
                moduleName: (id: string) => NAMES[id] ?? id,
            },
        },
    );
    return module;
}

describe('AudioTranscoderModule on an idle source (B-201, MR-006)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        execFileMock.mockReset();
        lines.length = 0;
        AudioTranscoderModule.setS302mSupported(true);
        // The base's start builds the pipeline (and its health text) without spawning a runner.
        vi.spyOn(GstPluginBase.prototype, 'onStart').mockImplementation(async function (this: any) {
            this.buildPipeline(this.config);
        });
        vi.spyOn(GstPluginBase.prototype, 'onStop').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('logs the wait once and shows it in its status; audio found and lost again once each', async () => {
        const module = await makeTranscoder();
        sourceSends(IDLE_OUTPUT);

        // Start, then 30 re-probes (5 minutes) of a source that sends nothing.
        await module.onStart();
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 30);
        expect(execFileMock).toHaveBeenCalledTimes(31);
        expect(lines).toEqual([
            [30, 'Plugin:atx-1', 'FRA IN: no audio from VV yet — waiting for it'],
        ]);
        expect(module.getState()).toMatchObject({
            health: 'warning',
            error: 'No source — waiting for audio from VV (checked every 10 s)',
        });

        // The source starts: one line, the self-heal restart, ok, no more probes.
        sourceSends(AAC_OUTPUT);
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);
        expect(lines.slice(1)).toEqual([
            [30, 'Plugin:atx-1', 'FRA IN: audio from VV is aac, 2 channels'],
        ]);
        expect(module.getState()).toMatchObject({ health: 'ok', error: null });
        expect(module.reprobe.armed).toBe(false);
        expect(execFileMock).toHaveBeenCalledTimes(33); // the tick, then the restart's start
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 3);
        expect(execFileMock).toHaveBeenCalledTimes(33);

        // It stops sending and the module is restarted: one warning, then quiet again.
        sourceSends(IDLE_OUTPUT);
        await module.onStop();
        await module.onStart();
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 30);
        expect(lines.slice(2)).toEqual([
            [40, 'Plugin:atx-1', 'FRA IN: no audio from VV any more — waiting for it'],
        ]);
        expect(module.getState().error).toBe(
            'No source — waiting for audio from VV (checked every 10 s)',
        );
        await module.onStop();
    });

    it('a re-probe that finds audio of a codec no classifier knows warns once, status says so', async () => {
        const module = await makeTranscoder();
        sourceSends(IDLE_OUTPUT);
        await module.onStart();
        sourceSends(
            '/GstPipeline:pipeline0/GstTSDemux:tsdemux0.GstPad:audio_0_0045: caps = audio/x-odd',
        );
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 6);
        expect(lines.map(([level, , msg]) => [level, msg])).toEqual([
            [30, 'FRA IN: no audio from VV yet — waiting for it'],
            [
                40,
                'FRA IN: audio from VV has a codec the probe does not know — using the generic decoder',
            ],
        ]);
        expect(module.getState().error).toContain('Source codec unknown — using generic decoder');
        expect(module.reprobe.armed).toBe(true);
        await module.onStop();
    });
});
