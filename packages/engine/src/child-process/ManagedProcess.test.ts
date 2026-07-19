import { describe, it, expect, afterEach, vi } from 'vitest';
import { ManagedProcess } from './ManagedProcess.js';

describe('ManagedProcess', () => {
    const procs: ManagedProcess[] = [];

    afterEach(async () => {
        for (const p of procs) {
            await p.destroy().catch(() => {});
        }
        procs.length = 0;
    });

    function create(
        opts: Partial<Parameters<typeof ManagedProcess.prototype.start>[0]> & {
            command: string;
            label: string;
        },
    ): ManagedProcess {
        const proc = new ManagedProcess(
            {
                autoRestart: false,
                ...opts,
            },
            'test-owner',
        );
        procs.push(proc);
        return proc;
    }

    it('starts a process and reports running', async () => {
        const proc = create({ label: 'echo', command: 'sleep', args: ['10'] });
        proc.start();
        // Small delay for spawn
        await new Promise((r) => setTimeout(r, 100));
        expect(proc.isRunning).toBe(true);
        expect(proc.pid).toBeGreaterThan(0);
        expect(proc.uptime).toBeGreaterThan(0);
    });

    it('captures stdout line by line', async () => {
        const lines: string[] = [];
        const proc = create({
            label: 'echo',
            command: '/bin/sh',
            args: ['-c', 'echo "line1"; echo "line2"'],
            onStdout: (line) => lines.push(line),
        });
        proc.start();
        await new Promise<void>((resolve) => proc.on('stopped', () => resolve()));
        expect(lines).toContain('line1');
        expect(lines).toContain('line2');
    });

    it('captures stderr line by line', async () => {
        const lines: string[] = [];
        const proc = create({
            label: 'stderr-test',
            command: '/bin/sh',
            args: ['-c', 'echo "err1" >&2; echo "err2" >&2'],
            onStderr: (line) => lines.push(line),
        });
        proc.start();
        await new Promise<void>((resolve) => proc.on('stopped', () => resolve()));
        expect(lines).toContain('err1');
        expect(lines).toContain('err2');
    });

    it('emits started event with pid', async () => {
        const proc = create({ label: 'started-test', command: 'sleep', args: ['10'] });
        const startedPid = await new Promise<number>((resolve) => {
            proc.on('started', (pid: number) => resolve(pid));
            proc.start();
        });
        expect(startedPid).toBeGreaterThan(0);
    });

    it('emits stopped event on exit', async () => {
        const proc = create({ label: 'stop-test', command: '/bin/sh', args: ['-c', 'exit 0'] });
        const result = await new Promise<{ code: number | null; signal: string | null }>(
            (resolve) => {
                proc.on('stopped', (code: number | null, signal: string | null) =>
                    resolve({ code, signal }),
                );
                proc.start();
            },
        );
        expect(result.code).toBe(0);
    });

    it('reports not running after exit', async () => {
        const proc = create({ label: 'exit-test', command: '/bin/sh', args: ['-c', 'exit 0'] });
        proc.start();
        await new Promise<void>((resolve) => proc.on('stopped', () => resolve()));
        expect(proc.isRunning).toBe(false);
        expect(proc.exitCode).toBe(0);
    });

    it('graceful stop sends SIGTERM', async () => {
        const proc = create({ label: 'sigterm', command: 'sleep', args: ['60'] });
        proc.start();
        await new Promise((r) => setTimeout(r, 100));
        expect(proc.isRunning).toBe(true);

        await proc.stop();
        expect(proc.isRunning).toBe(false);
    });

    it('destroy prevents further restarts', async () => {
        let startCount = 0;
        const proc = create({
            label: 'no-restart',
            command: '/bin/sh',
            args: ['-c', 'exit 1'],
            autoRestart: true,
            backoff: { baseDelayMs: 200, maxDelayMs: 200, maxAttempts: 5, stabilityMs: 1000 },
        });
        proc.on('started', () => startCount++);
        proc.on('error', () => {}); // Prevent unhandled error
        proc.start();

        // Wait for first exit + destroy before restart timer fires
        await new Promise<void>((resolve) => proc.once('stopped', () => resolve()));
        const countAfterFirstExit = startCount;
        await proc.destroy();

        // Wait to confirm no additional restarts happen
        await new Promise((r) => setTimeout(r, 500));
        expect(startCount).toBe(countAfterFirstExit); // no more starts
        expect(proc.destroyed).toBe(true);
    });

    it('auto-restarts on non-zero exit when enabled', async () => {
        let startCount = 0;
        const proc = create({
            label: 'restart-test',
            command: '/bin/sh',
            args: ['-c', 'exit 1'],
            autoRestart: true,
            backoff: { baseDelayMs: 100, maxDelayMs: 100, maxAttempts: 3, stabilityMs: 1000 },
        });
        proc.on('started', () => startCount++);
        proc.on('error', () => {}); // Prevent unhandled error from max retries
        proc.start();

        // Wait for a couple restarts
        await new Promise((r) => setTimeout(r, 500));
        await proc.destroy();

        expect(startCount).toBeGreaterThanOrEqual(2);
    });

    it('does not restart on exit code 0', async () => {
        let restartCount = 0;
        const proc = create({
            label: 'clean-exit',
            command: '/bin/sh',
            args: ['-c', 'exit 0'],
            autoRestart: true,
        });
        proc.on('restarting', () => restartCount++);
        proc.start();

        await new Promise<void>((resolve) => proc.on('stopped', () => resolve()));
        await new Promise((r) => setTimeout(r, 200));
        expect(restartCount).toBe(0);
    });

    it('start is safe when already running', async () => {
        const proc = create({ label: 'double-start', command: 'sleep', args: ['10'] });
        proc.start();
        await new Promise((r) => setTimeout(r, 100));
        proc.start(); // should be a no-op
        expect(proc.isRunning).toBe(true);
    });

    it('start is safe when destroyed', () => {
        const proc = create({ label: 'destroyed-start', command: 'sleep', args: ['10'] });
        proc['_destroyed'] = true;
        proc.start();
        expect(proc.isRunning).toBe(false);
    });

    it('writeLine feeds stdin when the pipe is enabled', async () => {
        const lines: string[] = [];
        const proc = create({
            label: 'stdin-echo',
            command: 'cat',
            stdin: true,
            onStdout: (line) => lines.push(line),
        });
        proc.start();
        await new Promise((r) => setTimeout(r, 100));
        expect(proc.writeLine('{"cmd":"bus_attach"}')).toBe(true);
        await vi.waitFor(() => expect(lines).toContain('{"cmd":"bus_attach"}'));
    });

    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
        const proc = create({
            label: 'term-ignorer',
            command: '/bin/sh',
            args: ['-c', 'trap "" TERM; sleep 60'],
        });
        proc.start();
        await new Promise((r) => setTimeout(r, 150));
        expect(proc.isRunning).toBe(true);

        // Without the exitCode-based liveness check, stop() returned with the
        // TERM-ignoring child still alive (child.killed is true the moment the
        // signal is DELIVERED, so the old `!child.killed` guard never fired).
        await proc.stop();
        expect(proc.isRunning).toBe(false);
    }, 10000);

    it('a second stop still kills a child that survived the first', async () => {
        const proc = create({
            label: 'term-ignorer-twice',
            command: '/bin/sh',
            args: ['-c', 'trap "" TERM; sleep 60'],
        });
        proc.start();
        await new Promise((r) => setTimeout(r, 150));

        // First stop is abandoned mid-flight (SIGTERM delivered, child alive).
        // The entry guard used to read `child.killed` — true from that signal —
        // so every later stop returned instantly claiming success while the
        // process kept running, untracked.
        const abandoned = proc.stop();
        await new Promise((r) => setTimeout(r, 100));

        await proc.stop();
        expect(proc.isRunning).toBe(false);
        await abandoned;
    }, 15000);

    it('writeLine returns false without a stdin pipe or when not running', async () => {
        const noPipe = create({ label: 'no-stdin', command: 'sleep', args: ['10'] });
        noPipe.start();
        await new Promise((r) => setTimeout(r, 100));
        expect(noPipe.writeLine('x')).toBe(false);

        const dead = create({ label: 'dead-stdin', command: 'cat', stdin: true });
        expect(dead.writeLine('x')).toBe(false); // never started
    });
});
