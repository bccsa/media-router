import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Golden parity: the native mrts core (native/mrts) must produce byte-identical
 * outputs to the Python reference (ts_split.py) over a deterministic synthetic
 * MPTS that exercises PSI carousel, PCR re-injection with jitter, descriptor
 * codec identity (Opus), desync recovery, SPS video-info probing, and a
 * mid-stream codec change. Both sides run the identical CLI contract
 * (native_parity_ref.py ⟷ mrts_cli); any byte diff on any output PID fails.
 */

const NATIVE_DIR = join(__dirname, '../../../../native');
const CLI = join(NATIVE_DIR, 'mrts/mrts_cli');
const FIXTURE_GEN = join(__dirname, 'native_parity_fixture.py');
const REF_RUNNER = join(__dirname, 'native_parity_ref.py');

const OUTPUTS = '0x65,0xc9:0x06,0xca,0x1f0,0x999';
const OUTPUT_PIDS = [0x65, 0xc9, 0xca, 0x1f0, 0x999];

const havePython = spawnSync('python3', ['--version']).status === 0;
const haveCompiler = spawnSync('make', ['--version']).status === 0 &&
    spawnSync('c++', ['--version']).status === 0;

function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
    return stdout
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l));
}

function run(cmd: string, args: string[]): { events: Array<Record<string, unknown>> } {
    const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(res.error, `${cmd} failed to spawn`).toBeUndefined();
    expect(res.status, `${cmd} exited non-zero: ${res.stderr}`).toBe(0);
    return { events: jsonLines(res.stdout) };
}

describe.skipIf(!havePython || !haveCompiler)('native mrts core parity', () => {
    let dir: string;
    let fixture: string;

    beforeAll(() => {
        const build = spawnSync('sh', [join(NATIVE_DIR, 'build-host.sh')], {
            encoding: 'utf8',
        });
        expect(build.status, `native build failed: ${build.stderr}`).toBe(0);
        dir = mkdtempSync(join(tmpdir(), 'mrts-parity-'));
        fixture = join(dir, 'fixture.ts');
        const gen = spawnSync('python3', [FIXTURE_GEN, fixture], {
            cwd: __dirname,
            encoding: 'utf8',
        });
        expect(gen.status, `fixture generation failed: ${gen.stderr}`).toBe(0);
    }, 120_000);

    afterAll(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    // 1316 = live bus buffer granularity; 977 = unaligned (exercises the
    // remainder carry); whole-file = single-feed discovery path.
    for (const chunk of [1316, 977, 0]) {
        const label = chunk === 0 ? 'whole-file' : `chunk ${chunk}`;
        it(`outputs byte-identical to the python core (${label})`, () => {
            const size = chunk === 0 ? String(64 * 1024 * 1024) : String(chunk);
            const pyDir = join(dir, `py-${chunk}`);
            const cxxDir = join(dir, `cxx-${chunk}`);
            mkdirSync(pyDir);
            mkdirSync(cxxDir);
            const argsFor = (outDir: string) => [
                '--outputs', OUTPUTS, '--chunk', size, '--out-dir', outDir, fixture,
            ];
            const py = run('python3', [REF_RUNNER, ...argsFor(pyDir)]);
            const cxx = run(CLI, argsFor(cxxDir));

            for (const pid of OUTPUT_PIDS) {
                const name = `out_0x${pid.toString(16)}.ts`;
                expect(sha256(join(cxxDir, name)), `pid 0x${pid.toString(16)} differs`).toBe(
                    sha256(join(pyDir, name)),
                );
            }

            // Event parity: discovery + desync accounting exact; video info
            // field-compared (fps numerically — JSON float formatting differs).
            const pick = (evs: Array<Record<string, unknown>>, type: string) =>
                evs.filter((e) => e.event === type);
            expect(pick(cxx.events, 'discovered')).toEqual(pick(py.events, 'discovered'));
            expect(pick(cxx.events, 'done')).toEqual(pick(py.events, 'done'));
            expect(pick(cxx.events, 'desync')).toEqual(pick(py.events, 'desync'));
            const vi = (evs: Array<Record<string, unknown>>) =>
                pick(evs, 'videoinfo').map((e) => ({ ...e, fps: undefined }));
            expect(vi(cxx.events)).toEqual(vi(py.events));
            const fpsOf = (evs: Array<Record<string, unknown>>) =>
                pick(evs, 'videoinfo').map((e) => e.fps as number | undefined);
            const pyFps = fpsOf(py.events);
            fpsOf(cxx.events).forEach((f, i) => {
                if (f === undefined || pyFps[i] === undefined) expect(f).toBe(pyFps[i]);
                else expect(f).toBeCloseTo(pyFps[i]!, 6);
            });
        });
    }

    it('routed subset only: unmatched pid output stays empty', () => {
        expect(readFileSync(join(dir, 'py-1316', 'out_0x999.ts')).length).toBe(0);
        expect(readFileSync(join(dir, 'cxx-1316', 'out_0x999.ts')).length).toBe(0);
    });

    it('fixture actually exercised the interesting paths', () => {
        // Guards against the fixture degrading into a trivial stream: desync
        // must have fired, video output must be non-trivial, and the fixture's
        // codec change must be visible as >1 discovery event.
        const py = run('python3', [
            REF_RUNNER, '--outputs', '0x65', '--chunk', '1316',
            '--out-dir', mkdtempSync(join(dir, 'probe-')), fixture,
        ]);
        const discovered = py.events.filter((e) => e.event === 'discovered');
        expect(discovered.length).toBeGreaterThan(1);
        expect(py.events.some((e) => e.event === 'desync')).toBe(true);
        expect(py.events.some((e) => e.event === 'videoinfo')).toBe(true);
    });
});
