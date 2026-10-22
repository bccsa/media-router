import { readFileSync } from 'node:fs';

/**
 * Hold this thread (libuv cannot reap) until child `pid` is dead but unreaped, as systemd's cgroup
 * SIGTERM leaves a sidecar while the engine's stop still writes to it (B-87). Dead: a zombie
 * leader with no thread left, so every pipe end it held is closed (Linux /proc).
 */
export function holdUntilZombie(pid: number, timeoutMs = 2000): void {
    const slot = new Int32Array(new SharedArrayBuffer(4));
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // From field 3 (state) on; field 20 is num_threads.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[0] === 'Z' && fields[17] === '1') return;
        Atomics.wait(slot, 0, 0, 2);
    }
    throw new Error(`pid ${pid} still alive after ${timeoutMs} ms`);
}

/** Uncaught exceptions while `fn` runs: an 'error' event nobody hears surfaces as one. */
export async function uncaughtDuring(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const hear = (err: unknown) => seen.push(err);
    process.on('uncaughtException', hear);
    try {
        await fn();
    } finally {
        process.off('uncaughtException', hear);
    }
    return seen;
}
