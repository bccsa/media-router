import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setLogTap } from '@media-router/shared-types';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
    GST_INSPECT_TIMEOUT_MS,
    gstElementSupportsCaps,
    gstInspectMaxChannels,
    isGstInspectTimeout,
    probeGstElement,
    findLadspaElement,
} from './gstInspect.js';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function callBack(cb: ExecCallback, err: Error | null, stdout = '') {
    setTimeout(() => cb(err, stdout, ''), 0);
}

/** The error execFile hands its callback when its `timeout` killed the child. */
function killedAtBound(): Error {
    return Object.assign(new Error('Command failed: gst-inspect-1.0'), {
        killed: true,
        signal: 'SIGTERM',
        code: null,
    });
}

/** The error execFile hands its callback when a signal from elsewhere, or a crash, ended the child. */
function killedBySignal(signal: string): Error {
    return Object.assign(new Error('Command failed: gst-inspect-1.0'), {
        killed: false,
        signal,
        code: null,
    });
}

/** The warnings gstInspect logs while `run` runs, as JSON. */
async function warnings(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
    const lines: Array<Record<string, unknown>> = [];
    setLogTap((l) => {
        const line = JSON.parse(l) as Record<string, unknown>;
        if (line.name === 'gstInspect' && line.level === 40) lines.push(line);
    });
    try {
        await run();
        await new Promise((r) => setImmediate(r));
    } finally {
        setLogTap(null);
    }
    return lines;
}

/** The warning a crashed run of `what` leaves. */
const crashed = (what: string, signal: string) =>
    expect.objectContaining({
        msg: `gst-inspect-1.0 ${what} crashed (${signal}), so ${what} is taken as not installed`,
        signal,
        args: [what],
    });

describe('probeGstElement', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('resolves true when gst-inspect-1.0 exits 0', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null),
        );
        await expect(probeGstElement('opusenc-unique-1')).resolves.toBe(true);
    });

    it('resolves false when gst-inspect-1.0 exits non-zero', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, new Error('exit 1')),
        );
        await expect(probeGstElement('nonexistent-element-2')).resolves.toBe(false);
    });

    it('caches the result so a second call does not re-invoke gst-inspect', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null),
        );
        await probeGstElement('cached-element-3');
        await probeGstElement('cached-element-3');
        await probeGstElement('cached-element-3');
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('runs with the bound that covers a cold registry scan, 30 s (B-102)', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null),
        );
        await probeGstElement('bound-element-4');
        expect(GST_INSPECT_TIMEOUT_MS).toBe(30_000);
        expect(execFileMock).toHaveBeenCalledWith(
            'gst-inspect-1.0',
            ['bound-element-4'],
            { timeout: GST_INSPECT_TIMEOUT_MS },
            expect.any(Function),
        );
    });

    it('a run killed at the bound rejects, named, and is not cached (B-102)', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedAtBound()),
        );
        const err = await probeGstElement('timed-out-element-5').catch((e: unknown) => e);
        expect(isGstInspectTimeout(err)).toBe(true);
        expect((err as Error).message).toBe(
            'gst-inspect-1.0 timed-out-element-5 timed out after 30 s, so whether ' +
                "timed-out-element-5 is installed is not known (GStreamer's plugin registry scan " +
                'hung or ran too slow)',
        );

        // The next call runs gst-inspect again; its answer is then cached.
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null),
        );
        await expect(probeGstElement('timed-out-element-5')).resolves.toBe(true);
        await expect(probeGstElement('timed-out-element-5')).resolves.toBe(true);
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('a run killed by SIGKILL, not at the bound (an OOM kill), is no answer either: it rejects and is not cached', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedBySignal('SIGKILL')),
        );
        const err = await probeGstElement('killed-element-7').catch((e: unknown) => e);
        expect(isGstInspectTimeout(err)).toBe(true);
        expect((err as Error).message).toBe(
            'gst-inspect-1.0 killed-element-7 was killed by SIGKILL, so whether killed-element-7 ' +
                'is installed is not known',
        );

        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null),
        );
        await expect(probeGstElement('killed-element-7')).resolves.toBe(true);
        await expect(probeGstElement('killed-element-7')).resolves.toBe(true);
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('a run killed by SIGTERM, not at the bound (a stop), is no answer likewise', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedBySignal('SIGTERM')),
        );
        const err = await probeGstElement('stopped-element-8').catch((e: unknown) => e);
        expect(isGstInspectTimeout(err)).toBe(true);
        expect((err as Error).message).toBe(
            'gst-inspect-1.0 stopped-element-8 was killed by SIGTERM, so whether stopped-element-8 ' +
                'is installed is not known',
        );

        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null),
        );
        await expect(probeGstElement('stopped-element-8')).resolves.toBe(true);
        await expect(probeGstElement('stopped-element-8')).resolves.toBe(true);
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('a run that crashed (SIGSEGV, SIGABRT, SIGBUS) is a failed run: absent and cached, as before B-102, its warning naming the signal', async () => {
        for (const signal of ['SIGSEGV', 'SIGABRT', 'SIGBUS']) {
            execFileMock.mockReset();
            execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
                callBack(cb, killedBySignal(signal)),
            );
            const name = `crashed-element-9-${signal}`;
            const lines = await warnings(async () => {
                await expect(probeGstElement(name)).resolves.toBe(false);
            });
            expect(lines).toEqual([crashed(name, signal)]);

            execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
                callBack(cb, null),
            );
            await expect(probeGstElement(name)).resolves.toBe(false);
            expect(execFileMock).toHaveBeenCalledTimes(1);
        }
    });

    it('a failed exit logs nothing', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(
                cb,
                Object.assign(new Error('exit 255'), { killed: false, signal: null, code: 255 }),
            ),
        );
        const lines = await warnings(async () => {
            await expect(probeGstElement('missing-element-10')).resolves.toBe(false);
        });
        expect(lines).toEqual([]);
    });

    it('callers waiting on the same timed-out run all see the timeout', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedAtBound()),
        );
        const both = await Promise.allSettled([
            probeGstElement('shared-timeout-6'),
            probeGstElement('shared-timeout-6'),
        ]);
        expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });
});

describe('gstElementSupportsCaps', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('caches per (element, caps) pair without letting two pairs collide', async () => {
        // The cache key joins the two halves with a NUL. Pinned because the
        // source carried a LITERAL NUL (invisible in editors and diffs, and it
        // made grep treat the file as binary); the escape rewrite has to keep
        // the exact same runtime key. Drop the separator and `('mux', 'a/b')`
        // and `('muxa', '/b')` would share one cached probe result.
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, 'audio/x-smpte-302m'),
        );
        await expect(gstElementSupportsCaps('mux', 'audio/x-smpte-302m')).resolves.toBe(true);
        await expect(gstElementSupportsCaps('mux', 'audio/x-smpte-302m')).resolves.toBe(true);
        expect(execFileMock).toHaveBeenCalledTimes(1);

        // Same concatenation, different pair — must probe again, not reuse.
        await gstElementSupportsCaps('muxa', 'udio/x-smpte-302m');
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('a timed-out run rejects and is not cached (B-102)', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedAtBound()),
        );
        await expect(gstElementSupportsCaps('slowmux', 'audio/x-smpte-302m')).rejects.toThrow(
            'gst-inspect-1.0 slowmux timed out after 30 s',
        );
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, 'audio/x-smpte-302m'),
        );
        await expect(gstElementSupportsCaps('slowmux', 'audio/x-smpte-302m')).resolves.toBe(true);
        expect(execFileMock).toHaveBeenCalledTimes(2);
        expect(execFileMock.mock.calls[0][2]).toEqual({ timeout: GST_INSPECT_TIMEOUT_MS });
    });

    it('a run that crashed reads as unsupported and is cached, as before B-102', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedBySignal('SIGSEGV')),
        );
        await expect(gstElementSupportsCaps('crashmux', 'audio/x-smpte-302m')).resolves.toBe(false);
        await expect(gstElementSupportsCaps('crashmux', 'audio/x-smpte-302m')).resolves.toBe(false);
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });
});

describe('findLadspaElement', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('returns null when the ladspa wrapper is missing (and does not cache the failure)', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, new Error('No such element')),
        );
        await expect(findLadspaElement('sc-compressor-stereo')).resolves.toBeNull();
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('a timed-out run rejects instead of reading as not installed, and is not cached (B-102)', async () => {
        // A fresh copy of the module: the list it caches would serve the other cases.
        vi.resetModules();
        const fresh = await import('./gstInspect.js');
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedAtBound()),
        );
        await expect(fresh.findLadspaElement('sc-gate-stereo')).rejects.toThrow(
            'gst-inspect-1.0 ladspa timed out after 30 s',
        );
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, '  ladspa-x-so-sc-gate-stereo: Sidechain Gate Stereo\n'),
        );
        await expect(fresh.findLadspaElement('sc-gate-stereo')).resolves.toBe(
            'ladspa-x-so-sc-gate-stereo',
        );
        expect(execFileMock).toHaveBeenCalledTimes(2);
        expect(execFileMock.mock.calls[0][2]).toEqual({ timeout: GST_INSPECT_TIMEOUT_MS });
    });

    it('a run that crashed reads as no wrapper and, as a failed run, is not cached', async () => {
        vi.resetModules();
        const fresh = await import('./gstInspect.js');
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedBySignal('SIGABRT')),
        );
        await expect(fresh.findLadspaElement('sc-gate-stereo')).resolves.toBeNull();
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, '  ladspa-x-so-sc-gate-stereo: Sidechain Gate Stereo\n'),
        );
        await expect(fresh.findLadspaElement('sc-gate-stereo')).resolves.toBe(
            'ladspa-x-so-sc-gate-stereo',
        );
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('resolves versioned element names by suffix and caches the list', async () => {
        const stdout = `Plugin Details:
  Name                     ladspa
  ladspa-lsp-plugins-ladspa-1-2-5-so-http---lsp-plug-in-plugins-ladspa-sc-compressor-stereo: Sidechain Compressor Stereo
  ladspa-lsp-plugins-ladspa-1-2-5-so-http---lsp-plug-in-plugins-ladspa-sc-gate-stereo: Sidechain Gate Stereo
  ladspa-gate-1410-so-gate: Gate

  46 features:
`;
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, stdout),
        );
        await expect(findLadspaElement('sc-compressor-stereo')).resolves.toBe(
            'ladspa-lsp-plugins-ladspa-1-2-5-so-http---lsp-plug-in-plugins-ladspa-sc-compressor-stereo',
        );
        await expect(findLadspaElement('sc-gate-stereo')).resolves.toBe(
            'ladspa-lsp-plugins-ladspa-1-2-5-so-http---lsp-plug-in-plugins-ladspa-sc-gate-stereo',
        );
        await expect(findLadspaElement('no-such-suffix')).resolves.toBeNull();
        // One gst-inspect run serves all lookups
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });
});

describe('gstInspectMaxChannels', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('parses the smallest "channels: [ 1, N ]" range from gst-inspect output', async () => {
        const stdout = `
Pad Templates:
  SRC template: 'src'
    Capabilities:
      audio/x-opus
                 rate: { (int)8000, (int)12000 }
             channels: [ 1, 8 ]

  SINK template: 'sink'
    Capabilities:
      audio/x-raw
                 rate: { (int)8000, (int)16000 }
             channels: [ 1, 2 ]
`;
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, stdout),
        );
        await expect(gstInspectMaxChannels('opusenc')).resolves.toBe(2);
    });

    it('takes the larger range when only one is present', async () => {
        const stdout = 'channels: [ 1, 6 ]';
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, stdout),
        );
        await expect(gstInspectMaxChannels('avenc_aac')).resolves.toBe(6);
    });

    it('falls back to 2 when the element is missing (gst-inspect errors)', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, new Error('No such element')),
        );
        await expect(gstInspectMaxChannels('does-not-exist')).resolves.toBe(2);
    });

    it('falls back to 2 when the output declares no channel range', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, 'unrelated output, no channels declaration'),
        );
        await expect(gstInspectMaxChannels('weird-element')).resolves.toBe(2);
    });

    it('a timed-out run rejects instead of reading as 2 channels (B-102)', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedAtBound()),
        );
        await expect(gstInspectMaxChannels('slowenc')).rejects.toThrow(
            'gst-inspect-1.0 slowenc timed out after 30 s',
        );
        expect(execFileMock.mock.calls[0][2]).toEqual({ timeout: GST_INSPECT_TIMEOUT_MS });
    });

    it('a run that crashed reads as 2 channels, as a missing element does', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, killedBySignal('SIGBUS')),
        );
        await expect(gstInspectMaxChannels('crashenc')).resolves.toBe(2);
    });
});

describe("a process's first gst-inspect-1.0 run (B-102)", () => {
    beforeEach(() => {
        execFileMock.mockReset();
        // Each case needs the module before any run: a fresh copy of it.
        vi.resetModules();
    });

    it('goes alone, so a cold registry is rescanned once; the rest then run at once', async () => {
        const fresh = await import('./gstInspect.js');
        const pending: ExecCallback[] = [];
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) => {
            pending.push(cb);
        });
        const answers = Promise.all([
            fresh.probeGstElement('first-a'),
            fresh.probeGstElement('first-b'),
            fresh.gstInspectMaxChannels('first-c'),
        ]);
        await new Promise((r) => setTimeout(r, 10));
        expect(execFileMock).toHaveBeenCalledTimes(1);

        pending[0](null, '', '');
        await new Promise((r) => setTimeout(r, 10));
        expect(execFileMock).toHaveBeenCalledTimes(3);
        pending[1](null, '', '');
        pending[2](null, 'channels: [ 1, 8 ]', '');
        await expect(answers).resolves.toEqual([true, true, 8]);
    });

    it('one that timed out does not hold the rest', async () => {
        const fresh = await import('./gstInspect.js');
        const pending: ExecCallback[] = [];
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) => {
            pending.push(cb);
        });
        const first = fresh.probeGstElement('first-hangs').catch((e: unknown) => e);
        const second = fresh.probeGstElement('second-answers');
        await new Promise((r) => setTimeout(r, 10));
        expect(execFileMock).toHaveBeenCalledTimes(1);

        pending[0](killedAtBound(), '', '');
        expect(fresh.isGstInspectTimeout(await first)).toBe(true);
        await new Promise((r) => setTimeout(r, 10));
        expect(execFileMock).toHaveBeenCalledTimes(2);
        pending[1](null, '', '');
        await expect(second).resolves.toBe(true);
    });
});

/** A stand-in gst-inspect-1.0: logs each run, then acts by the element's name (a crash dumps no core). */
const FAKE_GST_INSPECT = `#!/bin/sh
echo "$1" >> "$FAKE_GST_INSPECT_DIR/runs.log"
case "$1" in
slow-*) sleep 2.5 ;;
hang-*) [ -e "$FAKE_GST_INSPECT_DIR/$1.answers" ] || exec sleep 60 ;;
oom-*) [ -e "$FAKE_GST_INSPECT_DIR/$1.answers" ] || kill -9 $$ ;;
term-*) [ -e "$FAKE_GST_INSPECT_DIR/$1.answers" ] || kill -TERM $$ ;;
segv-*) [ -e "$FAKE_GST_INSPECT_DIR/$1.answers" ] || { ulimit -c 0; kill -SEGV $$; } ;;
*) echo "No such element or plugin '$1'" >&2; exit 255 ;;
esac
echo "Factory Details:"
`;

describe('a slow or hung gst-inspect-1.0 on PATH (B-102)', () => {
    let dir: string;
    let savedPath: string | undefined;
    let realExecFile: typeof import('child_process').execFile;
    /** Shortens the bound execFile gets, so a hang needs no 30 s wait; null = the module's bound. */
    let boundMs: number | null = null;
    const bounds: number[] = [];

    beforeAll(async () => {
        realExecFile = (await vi.importActual<typeof import('child_process')>('child_process'))
            .execFile;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-fake-gst-inspect-'));
        fs.writeFileSync(path.join(dir, 'gst-inspect-1.0'), FAKE_GST_INSPECT, { mode: 0o755 });
        savedPath = process.env.PATH;
        process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
        process.env.FAKE_GST_INSPECT_DIR = dir;
    });

    afterAll(() => {
        process.env.PATH = savedPath;
        delete process.env.FAKE_GST_INSPECT_DIR;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        execFileMock.mockReset();
        execFileMock.mockImplementation(
            (file: string, args: string[], opts: { timeout: number }, cb: ExecCallback) => {
                bounds.push(opts.timeout);
                return realExecFile(
                    file,
                    args,
                    boundMs === null ? opts : { ...opts, timeout: boundMs },
                    cb,
                );
            },
        );
    });

    const runs = (name: string): number => {
        const log = path.join(dir, 'runs.log');
        if (!fs.existsSync(log)) return 0;
        return fs
            .readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l === name).length;
    };

    it('an element whose run takes longer than the old 2 s is present, and cached', async () => {
        const t0 = Date.now();
        await expect(probeGstElement('slow-element')).resolves.toBe(true);
        expect(Date.now() - t0).toBeGreaterThan(2000);
        expect(bounds.at(-1)).toBe(GST_INSPECT_TIMEOUT_MS);
        await expect(probeGstElement('slow-element')).resolves.toBe(true);
        expect(runs('slow-element')).toBe(1);
    }, 15_000);

    it('a run that hangs past the bound is killed and not cached: the next call runs it again', async () => {
        boundMs = 1000;
        try {
            await expect(probeGstElement('hang-element')).rejects.toThrow(
                'gst-inspect-1.0 hang-element timed out after 30 s',
            );
            await expect(probeGstElement('hang-element')).rejects.toThrow(
                'gst-inspect-1.0 hang-element timed out after 30 s',
            );
            expect(runs('hang-element')).toBe(2);

            // Once gst-inspect answers, that answer is the one cached.
            fs.writeFileSync(path.join(dir, 'hang-element.answers'), '');
            await expect(probeGstElement('hang-element')).resolves.toBe(true);
            await expect(probeGstElement('hang-element')).resolves.toBe(true);
            expect(runs('hang-element')).toBe(3);
        } finally {
            boundMs = null;
        }
    }, 15_000);

    it('a run killed by SIGKILL (an OOM kill) is not cached as absent: the next call runs it again', async () => {
        await expect(probeGstElement('oom-element')).rejects.toThrow(
            'gst-inspect-1.0 oom-element was killed by SIGKILL',
        );
        expect(runs('oom-element')).toBe(1);

        fs.writeFileSync(path.join(dir, 'oom-element.answers'), '');
        await expect(probeGstElement('oom-element')).resolves.toBe(true);
        await expect(probeGstElement('oom-element')).resolves.toBe(true);
        expect(runs('oom-element')).toBe(2);
    });

    it('a run killed by SIGTERM (a stop) likewise', async () => {
        await expect(probeGstElement('term-element')).rejects.toThrow(
            'gst-inspect-1.0 term-element was killed by SIGTERM',
        );
        expect(runs('term-element')).toBe(1);

        fs.writeFileSync(path.join(dir, 'term-element.answers'), '');
        await expect(probeGstElement('term-element')).resolves.toBe(true);
        await expect(probeGstElement('term-element')).resolves.toBe(true);
        expect(runs('term-element')).toBe(2);
    });

    it('a run that crashes (SIGSEGV) is absent and cached, as before B-102, its warning naming the signal', async () => {
        const lines = await warnings(async () => {
            await expect(probeGstElement('segv-element')).resolves.toBe(false);
        });
        expect(lines).toEqual([crashed('segv-element', 'SIGSEGV')]);

        // Cached: the answer it would give now is never asked for.
        fs.writeFileSync(path.join(dir, 'segv-element.answers'), '');
        await expect(probeGstElement('segv-element')).resolves.toBe(false);
        expect(runs('segv-element')).toBe(1);
    });

    it('a failed run is absent and cached, as before', async () => {
        await expect(probeGstElement('missing-element')).resolves.toBe(false);
        await expect(probeGstElement('missing-element')).resolves.toBe(false);
        expect(runs('missing-element')).toBe(1);
    });
});
