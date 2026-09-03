import { vi } from 'vitest';

/**
 * Test double for `PythonProcess` — records the command stream instead of
 * spawning `gst-pipeline-runner.py`, and hands the test the callbacks the
 * runner registered so it can play Python's side (`options.onEvent`,
 * `options.onExit`). Install per test file with:
 *
 *     vi.mock('./PythonProcess.js', async (importOriginal) => ({
 *         ...(await importOriginal<typeof import('./PythonProcess.js')>()),
 *         PythonProcess: (await import('./testing/FakePythonProcess.js')).FakePythonProcess,
 *     }));
 *
 * `start()` records `{ cmd: 'start' }` synchronously, mirroring the real
 * class, so command ORDER (start first, then queued attaches) is observable.
 */
export class FakePythonProcess {
    static spawned: FakePythonProcess[] = [];

    static reset(): void {
        FakePythonProcess.spawned = [];
    }

    /** The most recently spawned fake. */
    static last(): FakePythonProcess {
        return FakePythonProcess.spawned.at(-1)!;
    }

    readonly commands: Record<string, unknown>[] = [];
    readonly stop = vi.fn();
    readonly kill = vi.fn();
    readonly emergencyKill = vi.fn();

    constructor(
        readonly options: {
            onEvent: (event: Record<string, unknown>) => void;
            onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
            onSpawnError?: (err: Error) => void;
        },
    ) {
        FakePythonProcess.spawned.push(this);
    }

    get pid(): number {
        return 5000 + FakePythonProcess.spawned.indexOf(this);
    }

    start(): void {
        this.commands.push({ cmd: 'start' });
    }

    sendCommand(cmd: Record<string, unknown>): void {
        this.commands.push(cmd);
    }
}
