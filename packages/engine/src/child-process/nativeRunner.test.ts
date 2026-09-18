import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerStartOptions } from './PythonProcess.js';
import {
    nativeRunnerEligible,
    nativeRunnerIneligibility,
    resolveNativeHook,
    resolveNativeRunner,
    selectRunner,
} from './nativeRunner.js';

const PY = '/opt/x/gst-pipeline-runner.py';

function fakeBinDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mr-native-runner-'));
    const bin = join(dir, 'mr-gst-runner');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    return dir;
}

const audioMatrix: RunnerStartOptions = {
    pipeline: 'unixfdsrc socket-path=/tmp/mr-bus-40000-abc.sock ! queue ! tsdemux ! avdec_s302m ! fakesink',
    linkOnPadAdded: [],
    busReports: [],
    timeSyncContract: true,
    latchRepair: true,
    decoderThreadType: 'auto',
} as RunnerStartOptions;

describe('nativeRunnerEligible', () => {
    it('accepts the audio-matrix / SRT shape (contract, no python-only feature)', () => {
        expect(nativeRunnerIneligibility(audioMatrix)).toBeNull();
        expect(nativeRunnerEligible(audioMatrix)).toBe(true);
    });

    it('names the first python-only feature it finds', () => {
        expect(nativeRunnerIneligibility({ ...audioMatrix, preserveSourceTimeline: { demux: 'd' } } as never)).toBe(
            'preserveSourceTimeline',
        );
        expect(
            nativeRunnerIneligibility({ ...audioMatrix, runnerHooks: [{ module: 'no_such_hook' }] } as never, {
                MR_PLUGINS_DIR: '/nonexistent',
                MR_LIBEXEC_DIR: '/nonexistent',
            }),
        ).toBe('runnerHooks: no_such_hook');
        expect(
            nativeRunnerIneligibility({
                ...audioMatrix,
                linkOnPadAdded: [{ from: 'demux', media: 'video', branches: ['fakesink'] }],
            }),
        ).toBeNull();
        expect(nativeRunnerIneligibility({ ...audioMatrix, readKlvNames: true })).toBe('readKlvNames');
        expect(nativeRunnerIneligibility({ ...audioMatrix, useStdioForData: true })).toBe('useStdioForData');
        expect(nativeRunnerIneligibility({ ...audioMatrix, rist: { role: 'sender' } } as never)).toBe('rist');
        expect(nativeRunnerIneligibility({ ...audioMatrix, pipeline: 'mrristsrc ! fakesink' })).toBeNull();
    });

    it('refuses the legacy net clock but not the contract clock', () => {
        const legacy = { ...audioMatrix, timeSyncContract: false, clock: { host: '127.0.0.1', port: 1 } };
        expect(nativeRunnerIneligibility(legacy)).toBe('clock');
        const contract = { ...audioMatrix, timeSyncContract: true, clock: { host: '127.0.0.1', port: 1 } };
        expect(nativeRunnerIneligibility(contract)).toBeNull();
    });

    it('treats null / empty python-only fields as absent', () => {
        expect(nativeRunnerIneligibility({ ...audioMatrix, runnerHooks: [] } as never)).toBeNull();
        expect(nativeRunnerIneligibility({ ...audioMatrix, preserveSourceTimeline: undefined })).toBeNull();
    });

    it('accepts the video-player shape (Stage 3: gates, watches, probe, pad-link rules)', () => {
        expect(
            nativeRunnerIneligibility({
                ...audioMatrix,
                linkOnPadAdded: [{ from: 'demux', media: 'video', branches: ['queue ! avdec_h264 ! fakesink'] }],
                keyframeGate: { decoder: 'vdec' },
                renderWatch: { sink: 'vsink' },
                tsProbe: { appsink: 'tap' },
            } as never),
        ).toBeNull();
    });

    it('accepts the presentation-leg shape (Stage 2: branch alignment + backlog shed)', () => {
        const leg = {
            ...audioMatrix,
            alignBranchesToStamps: { demuxes: ['mixin_demux0'] },
            backlogShed: {
                element: 'sink',
                sink: 'sink',
                keyframeAligned: false,
                toleranceMs: 250,
                holdMs: 5000,
                cooldownMs: 60000,
                sanityMs: 10000,
            },
        };
        expect(nativeRunnerIneligibility(leg)).toBeNull();
    });
});

describe('resolveNativeHook', () => {
    it('finds a hook under a plugin native tool dir and accepts the description', () => {
        const plugins = mkdtempSync(join(tmpdir(), 'mr-plugins-'));
        mkdirSync(join(plugins, 'some-plugin', 'native', 'my-hook'), { recursive: true });
        writeFileSync(join(plugins, 'some-plugin', 'native', 'my-hook', 'libmrhook_my_hook.so'), '');
        const env = { MR_PLUGINS_DIR: plugins, MR_LIBEXEC_DIR: '/nonexistent' };
        expect(resolveNativeHook('my_hook', env)).toBe(
            join(plugins, 'some-plugin', 'native', 'my-hook', 'libmrhook_my_hook.so'),
        );
        expect(resolveNativeHook('other', env)).toBeNull();
        expect(nativeRunnerIneligibility({ ...audioMatrix, runnerHooks: [{ module: 'my_hook' }] } as never, env)).toBeNull();
        expect(
            nativeRunnerIneligibility(
                { ...audioMatrix, runnerHooks: [{ module: 'my_hook' }, { module: 'other' }] } as never,
                env,
            ),
        ).toBe('runnerHooks: other');
    });

    it('finds an installed hook under libexec/<plugin>/', () => {
        const libexec = mkdtempSync(join(tmpdir(), 'mr-libexec-'));
        mkdirSync(join(libexec, 'some-plugin'), { recursive: true });
        writeFileSync(join(libexec, 'some-plugin', 'libmrhook_inst.so'), '');
        expect(resolveNativeHook('inst', { MR_PLUGINS_DIR: '/nonexistent', MR_LIBEXEC_DIR: libexec })).toBe(
            join(libexec, 'some-plugin', 'libmrhook_inst.so'),
        );
        expect(resolveNativeHook('../etc', { MR_PLUGINS_DIR: '/nonexistent', MR_LIBEXEC_DIR: libexec })).toBeNull();
    });

    it('refuses a hook two plugins ship, loudly', () => {
        const plugins = mkdtempSync(join(tmpdir(), 'mr-hooks-dup-'));
        for (const plugin of ['alpha', 'beta']) {
            mkdirSync(join(plugins, plugin, 'native', 'tool'), { recursive: true });
            writeFileSync(join(plugins, plugin, 'native', 'tool', 'libmrhook_dup.so'), '');
        }
        const lines: string[] = [];
        const env = { MR_PLUGINS_DIR: plugins, MR_LIBEXEC_DIR: '/nonexistent' };
        expect(resolveNativeHook('dup', env, (l) => lines.push(l))).toBeNull();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/ambiguous — alpha, beta all ship libmrhook_dup\.so/);
        expect(
            nativeRunnerIneligibility({ ...audioMatrix, runnerHooks: [{ module: 'dup' }] } as never, env, () => {}),
        ).toBe('runnerHooks: dup');
    });

    it('counts one plugin once across the deployed tree and its install, tree preferred', () => {
        const plugins = mkdtempSync(join(tmpdir(), 'mr-hooks-tree-'));
        const libexec = mkdtempSync(join(tmpdir(), 'mr-hooks-libexec-'));
        mkdirSync(join(plugins, 'same', 'native', 'tool'), { recursive: true });
        writeFileSync(join(plugins, 'same', 'native', 'tool', 'libmrhook_one.so'), '');
        mkdirSync(join(libexec, 'same'), { recursive: true });
        writeFileSync(join(libexec, 'same', 'libmrhook_one.so'), '');
        const lines: string[] = [];
        expect(resolveNativeHook('one', { MR_PLUGINS_DIR: plugins, MR_LIBEXEC_DIR: libexec }, (l) => lines.push(l))).toBe(
            join(plugins, 'same', 'native', 'tool', 'libmrhook_one.so'),
        );
        expect(lines).toHaveLength(0);
    });
});

describe('resolveNativeRunner', () => {
    it('honours MR_NATIVE_BIN_DIR as authoritative', () => {
        const dir = fakeBinDir();
        expect(resolveNativeRunner({ MR_NATIVE_BIN_DIR: dir })).toBe(join(dir, 'mr-gst-runner'));
        expect(resolveNativeRunner({ MR_NATIVE_BIN_DIR: '/nonexistent' })).toBeNull();
    });
});

describe('selectRunner', () => {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);

    it('defaults to python when nothing opts in', () => {
        const cmd = selectRunner(audioMatrix, PY, {}, log);
        expect(cmd).toEqual({ kind: 'python', file: 'python3', args: [PY] });
    });

    it('goes native for an eligible description under MR_GST_RUNNER_NATIVE=1', () => {
        const dir = fakeBinDir();
        const cmd = selectRunner(audioMatrix, PY, { MR_GST_RUNNER_NATIVE: '1', MR_NATIVE_BIN_DIR: dir }, log);
        expect(cmd.kind).toBe('native');
        expect(cmd.file).toBe(join(dir, 'mr-gst-runner'));
        expect(cmd.args).toEqual([]);
    });

    it('keeps an ineligible description on python even under the opt-in, silently', () => {
        logs.length = 0;
        const dir = fakeBinDir();
        const cmd = selectRunner(
            { ...audioMatrix, runnerHooks: [{ module: 'x' }] } as never,
            PY,
            { MR_GST_RUNNER_NATIVE: '1', MR_NATIVE_BIN_DIR: dir, MR_PLUGINS_DIR: '/nonexistent', MR_LIBEXEC_DIR: '/nonexistent' },
            log,
        );
        expect(cmd.kind).toBe('python');
        expect(logs).toEqual([]);
    });

    it('honours runner: "native" without the engine-wide opt-in', () => {
        const dir = fakeBinDir();
        const cmd = selectRunner({ ...audioMatrix, runner: 'native' }, PY, { MR_NATIVE_BIN_DIR: dir }, log);
        expect(cmd.kind).toBe('native');
    });

    it('logs when an explicit native request cannot be honoured', () => {
        logs.length = 0;
        const dir = fakeBinDir();
        selectRunner({ ...audioMatrix, runner: 'native', readKlvNames: true }, PY, { MR_NATIVE_BIN_DIR: dir }, log);
        expect(logs[0]).toMatch(/readKlvNames/);
        logs.length = 0;
        selectRunner({ ...audioMatrix, runner: 'native' }, PY, { MR_NATIVE_BIN_DIR: '/nonexistent' }, log);
        expect(logs[0]).toMatch(/not built/);
    });

    it('runner: "python" pins python even under the opt-in', () => {
        const dir = fakeBinDir();
        const cmd = selectRunner(
            { ...audioMatrix, runner: 'python' },
            PY,
            { MR_GST_RUNNER_NATIVE: '1', MR_NATIVE_BIN_DIR: dir },
            log,
        );
        expect(cmd.kind).toBe('python');
    });
});
