import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsSplitterModule } from './TsSplitterModule.js';
import { pidPortId } from './splitterPorts.js';

// resolveNativeBinary honors MR_NATIVE_BIN_DIR — point it at a temp dir with
// a stand-in binary so onStart's spawn path is testable everywhere.
let binDir: string;
beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'mr-native-bin-'));
    writeFileSync(join(binDir, 'mr-tssplit'), '#!/bin/sh\n');
    process.env.MR_NATIVE_BIN_DIR = binDir;
});
afterAll(() => {
    delete process.env.MR_NATIVE_BIN_DIR;
    rmSync(binDir, { recursive: true, force: true });
});

interface FakeProc {
    writeLine: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    destroyed: boolean;
}

function makeModule(opts: { upstream?: null | { port: number; socketPath?: string } } = {}) {
    const module = new TsSplitterModule();
    const getModuleBusSource = vi.fn(() =>
        opts.upstream === null
            ? undefined
            : {
                  port: opts.upstream?.port ?? 40000,
                  connectionId: 'c-up',
                  sourceModuleId: 'ip-in-1',
                  sourcePortId: 'mpegts-out',
                  socketPath: opts.upstream?.socketPath ?? '/tmp/mr-bus-40000-edge.sock',
              },
    );
    let nextPort = 41000;
    const allocated: Record<string, number> = {};
    const assignBusChannel = vi.fn((modId: string, portId?: string) => {
        const key = portId ? `${modId}:${portId}` : modId;
        if (!(key in allocated)) allocated[key] = nextPort++;
        return { port: allocated[key] };
    });
    const onProducerPlaying = vi.fn();
    const spawned: Array<{ opts: Record<string, unknown>; proc: FakeProc }> = [];
    const spawn = vi.fn((_owner: string, spawnOpts: Record<string, unknown>) => {
        const proc: FakeProc = { writeLine: vi.fn(), on: vi.fn(), destroyed: false };
        spawned.push({ opts: spawnOpts, proc });
        return proc;
    });
    (module as any).services = {
        instanceId: 'split-1',
        mediaRouter: { getModuleBusSource, assignBusChannel, onProducerPlaying },
        processManager: { spawn },
    };
    (module as any).config = {};
    return { module, getModuleBusSource, assignBusChannel, onProducerPlaying, spawn, spawned };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('TsSplitterModule native child (onStart)', () => {
    it('stays idle with a warning when no upstream is wired', async () => {
        const { module, spawn } = makeModule({ upstream: null });
        const setHealth = vi.spyOn(module as any, 'setHealth').mockImplementation(() => undefined);
        await module.onStart();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('upstream'));
        expect(spawn).not.toHaveBeenCalled();
        expect(module.getBusAttachTarget()).toBeNull();
    });

    it('spawns mr-tssplit with the input edge and one --out per persisted stream', async () => {
        const { module, assignBusChannel, spawned } = makeModule();
        (module as any).config = {
            discoveredStreams: [
                { pid: 0x65, streamType: 0x1b, media: 'video', codec: 'h264' },
                { pid: 0xc9, streamType: 0x0f, media: 'audio', codec: 'aac' },
            ],
        };
        await module.onStart();
        expect(assignBusChannel).toHaveBeenCalledWith('split-1', pidPortId(0x65));
        expect(assignBusChannel).toHaveBeenCalledWith('split-1', pidPortId(0xc9));
        expect(spawned).toHaveLength(1);
        expect(spawned[0].opts.command).toBe(join(binDir, 'mr-tssplit'));
        expect(spawned[0].opts.autoRestart).toBe(true);
        expect(spawned[0].opts.stdin).toBe(true);
        expect(spawned[0].opts.args).toEqual([
            '--input', '/tmp/mr-bus-40000-edge.sock',
            '--caps', 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188',
            '--ts-id', '1',
            '--out', '0x65:busout_41000:0x1b',
            '--out', '0xc9:busout_41001:0xf',
        ]);
        expect((module as any).running).toBe(true);
    });

    it('zero persisted streams -> input-only child (discovery-first)', async () => {
        const { module, assignBusChannel, spawned } = makeModule();
        await module.onStart();
        expect(assignBusChannel).not.toHaveBeenCalled();
        expect(spawned[0].opts.args).not.toContain('--out');
    });

    it('missing binary -> error health, no spawn', async () => {
        const { module, spawn } = makeModule();
        const setHealth = vi.spyOn(module as any, 'setHealth').mockImplementation(() => undefined);
        process.env.MR_NATIVE_BIN_DIR = join(binDir, 'nope');
        try {
            await module.onStart();
        } finally {
            process.env.MR_NATIVE_BIN_DIR = binDir;
        }
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('mr-tssplit'));
        expect(spawn).not.toHaveBeenCalled();
    });

    it('port pool exhaustion -> error health, no spawn', async () => {
        const { module, spawn } = makeModule();
        (module as any).services.mediaRouter.assignBusChannel = vi.fn(() => undefined);
        const setHealth = vi.spyOn(module as any, 'setHealth').mockImplementation(() => undefined);
        (module as any).config = {
            discoveredStreams: [{ pid: 0x65, streamType: 0x1b, media: 'video', codec: 'h264' }],
        };
        await module.onStart();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('pid-0x65'));
        expect(spawn).not.toHaveBeenCalled();
    });

    it('bus attach + live swap both target the controller; verbs reach child stdin', async () => {
        const { module, spawned } = makeModule();
        await module.onStart();
        const target = module.getBusAttachTarget()!;
        expect(target).toBe(module.getLiveSwapTarget());
        target.sendBusAttach('busout_41000', '/tmp/edge.sock');
        expect(JSON.parse(spawned[0].proc.writeLine.mock.calls[0][0])).toEqual({
            cmd: 'bus_attach',
            tee: 'busout_41000',
            socket: '/tmp/edge.sock',
        });
        void module.getLiveSwapTarget()!.busReinput('netin', '/tmp/new.sock').catch(() => {});
        expect(JSON.parse(spawned[0].proc.writeLine.mock.calls[1][0])).toEqual({
            cmd: 'reinput',
            socket: '/tmp/new.sock',
        });
    });

    it('child ready replays edges and triggers producer reattach', async () => {
        const { module, spawned, onProducerPlaying } = makeModule();
        await module.onStart();
        module.getBusAttachTarget()!.sendBusAttach('busout_41000', '/tmp/edge.sock');
        spawned[0].proc.writeLine.mockClear();
        const onStdout = spawned[0].opts.onStdout as (line: string) => void;
        onStdout('{"event":"ready"}');
        expect(onProducerPlaying).toHaveBeenCalledWith('split-1');
        expect(JSON.parse(spawned[0].proc.writeLine.mock.calls[0][0])).toMatchObject({
            cmd: 'bus_attach',
            socket: '/tmp/edge.sock',
        });
    });

    it('routes plugin_event lines into onPluginEvent (discovery persists)', async () => {
        const { module, spawned } = makeModule();
        const emitted: unknown[] = [];
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            emitted.push(changes);
            Object.assign((module as any).config, changes);
        });
        await module.onStart();
        const onStdout = spawned[0].opts.onStdout as (line: string) => void;
        onStdout(
            JSON.stringify({
                event: 'plugin_event',
                channel: 'tssplit:discovered',
                payload: { streams: [{ pid: 0x65, streamType: 0x1b }], pcrPid: 0x65 },
            }),
        );
        expect(emitted).toHaveLength(1);
        expect(module.getDynamicPorts().some((p) => p.id === pidPortId(0x65))).toBe(true);
    });

    it('input stall events map to warning/ok health', async () => {
        const { module, spawned } = makeModule();
        await module.onStart();
        const setHealth = vi.spyOn(module as any, 'setHealth').mockImplementation(() => undefined);
        const onStdout = spawned[0].opts.onStdout as (line: string) => void;
        onStdout('{"event":"input_stalled","ms":2400}');
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('2400'));
        onStdout('{"event":"input_resumed"}');
        expect(setHealth).toHaveBeenCalledWith('ok');
    });

    it('onStop drops the child refs so a stale controller cannot write', async () => {
        const { module } = makeModule();
        await module.onStart();
        expect(module.getBusAttachTarget()).not.toBeNull();
        await module.onStop();
        expect(module.getBusAttachTarget()).toBeNull();
        expect(module.getLiveSwapTarget()).toBeNull();
    });

    it('declares live input swap on mpegts-in only', () => {
        const { module } = makeModule();
        expect(module.getLiveInputSwap('mpegts-in')).toEqual({ element: 'netin' });
        expect(module.getLiveInputSwap('pid-0x65')).toBeNull();
    });
});

describe('TsSplitterModule discovery', () => {
    it('tssplit:discovered persists via emitConfigUpdate and refreshes ports', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const emitted: unknown[] = [];
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            emitted.push(changes);
            Object.assign((module as any).config, changes);
        });

        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [
                { pid: 0x65, streamType: 0x1b },
                { pid: 0xc9, streamType: 0x0f },
            ],
            pcrPid: 0x65,
        });

        expect(emitted).toHaveLength(1);
        const ports = module.getDynamicPorts();
        expect(ports.some((p) => p.id === pidPortId(0x65))).toBe(true);
        expect(ports.some((p) => p.id === pidPortId(0xc9))).toBe(true);
    });

    it('re-delivering identical discovery emits nothing (idempotent)', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const emitted: unknown[] = [];
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            emitted.push(changes);
            Object.assign((module as any).config, changes);
        });

        const payload = { streams: [{ pid: 0x65, streamType: 0x1b }], pcrPid: 0x65 };
        (module as any).onPluginEvent('tssplit:discovered', payload);
        (module as any).onPluginEvent('tssplit:discovered', payload);
        expect(emitted).toHaveLength(1);
    });

    it('layers the ISO 639 language from esInfo into port labels and status', () => {
        const { module } = makeModule();
        (module as any).config = {};
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            Object.assign((module as any).config, changes);
        });

        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [
                { pid: 0x141, streamType: 0x0f, esInfo: '0a046e6f72007c03518003' },
                { pid: 0x65, streamType: 0x1b, esInfo: '' },
            ],
            pcrPid: 0x65,
        });

        const port = module.getDynamicPorts().find((p) => p.id === pidPortId(0x141))!;
        expect(port.label).toBe('Audio nor (aac, PID 0x141)');
        expect(module.getDynamicPorts().find((p) => p.id === pidPortId(0x65))!.label).toBe(
            'Video (h264, PID 0x65)',
        );
        const section = (module as any).dynamicStatusSections.find(
            (s: { id: string }) => s.id === 'stream-321',
        );
        expect(section.label).toBe('Audio nor (aac, PID 0x141)');
        expect(section.fields.some((f: { key: string }) => f.key === 'language')).toBe(true);
    });

    it('a language appearing on a known PID re-persists (not treated as identical)', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const emitted: unknown[] = [];
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            emitted.push(changes);
            Object.assign((module as any).config, changes);
        });

        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [{ pid: 0x141, streamType: 0x0f }],
            pcrPid: 0x65,
        });
        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [{ pid: 0x141, streamType: 0x0f, esInfo: '0a0464657500' }],
            pcrPid: 0x65,
        });
        expect(emitted).toHaveLength(2);
        expect(module.getDynamicPorts().find((p) => p.id === pidPortId(0x141))!.label).toBe(
            'Audio deu (aac, PID 0x141)',
        );
    });

    it('other channels are ignored', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const spy = vi.spyOn(module as any, 'emitConfigUpdate');
        (module as any).onPluginEvent('rist:stats', { anything: true });
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('TsSplitterModule video info', () => {
    function discoveredModule() {
        const { module } = makeModule();
        (module as any).config = {};
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            Object.assign((module as any).config, changes);
        });
        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [
                { pid: 0x65, streamType: 0x1b },
                { pid: 0xc9, streamType: 0x0f },
            ],
            pcrPid: 0x65,
        });
        return module;
    }

    it('tssplit:videoinfo fills the video row of that stream, others stay —', () => {
        const module = discoveredModule();
        (module as any).onPluginEvent('tssplit:videoinfo', {
            pid: 0x65, codec: 'h264', width: 1920, height: 1080,
            interlaced: true, fps: 25, display: '1920×1080i50',
        });
        expect((module as any).statusData['stream-101'].video).toBe('1920×1080i50 (h264)');
        expect((module as any).statusData['stream-201'].video).toBe('—');
    });

    it('videoinfo is ephemeral: never persisted via emitConfigUpdate', () => {
        const module = discoveredModule();
        const emitSpy = (module as any).emitConfigUpdate as ReturnType<typeof vi.fn>;
        const callsBefore = emitSpy.mock.calls.length;
        (module as any).onPluginEvent('tssplit:videoinfo', {
            pid: 0x65, codec: 'h264', display: '1920×1080i50',
        });
        expect(emitSpy.mock.calls.length).toBe(callsBefore);
    });

    it('codec-only payload (no display) changes nothing', () => {
        const module = discoveredModule();
        (module as any).onPluginEvent('tssplit:videoinfo', { pid: 0x65, codec: 'mpeg2', display: null });
        expect((module as any).statusData['stream-101'].video).toBe('—');
    });

    it('onStop clears the video map', async () => {
        const module = discoveredModule();
        (module as any).onPluginEvent('tssplit:videoinfo', {
            pid: 0x65, codec: 'h264', display: '1920×1080i50',
        });
        await module.onStop();
        expect((module as any).videoInfo.size).toBe(0);
    });
});
