import { connect } from 'node:net';

/**
 * Connect-probe gate for unixfd bus consumers.
 *
 * unixfdsrc has no retry: g_socket_connect() runs once in start(), so a
 * missing producer socket is a hard pipeline-start failure that burns a full
 * start/timeout/backoff cycle (~10s). The runner instead waits here — an
 * actual connect() probe, NOT a file-existence check, because a crashed
 * producer leaves a stale socket file behind that refuses connections — and
 * only launches the pipeline once every producer socket accepts.
 */

/** Socket paths of every unixfdsrc in a pipeline string. */
export function unixFdSrcSocketPaths(pipeline: string): string[] {
    return [...pipeline.matchAll(/unixfdsrc[^!]*?socket-path=(\S+)/g)].map((m) => m[1]);
}

/** True when a unix socket at `path` currently accepts a connection. */
export function probeUnixSocket(path: string, timeoutMs = 300): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = connect({ path });
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
    });
}

export interface WaitForBusSocketsOpts {
    deadlineMs?: number;
    intervalMs?: number;
    /** Called once, with the not-yet-ready paths, when waiting actually begins. */
    onWait?: (pending: string[]) => void;
}

/**
 * Resolve true once every path accepts connections, false at the deadline.
 * The deadline is advisory — callers are expected to attempt the start
 * anyway and let the existing error/backoff path handle a still-dead
 * producer, so behaviour degrades to the ungated one.
 */
export async function waitForBusSockets(
    paths: string[],
    opts: WaitForBusSocketsOpts = {},
): Promise<boolean> {
    const { deadlineMs = 10_000, intervalMs = 250, onWait } = opts;
    const deadline = Date.now() + deadlineMs;
    let waitReported = false;
    for (;;) {
        const up = await Promise.all(paths.map((p) => probeUnixSocket(p)));
        if (up.every(Boolean)) return true;
        if (Date.now() >= deadline) return false;
        if (!waitReported) {
            waitReported = true;
            onWait?.(paths.filter((_, i) => !up[i]));
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
