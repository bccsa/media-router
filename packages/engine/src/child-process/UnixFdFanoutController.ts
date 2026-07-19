import type { ManagedProcess } from './ManagedProcess.js';

/**
 * What the BusFanoutCoordinator needs from a producer to manage its
 * per-consumer fan-out branches. `GstChildProcess` satisfies it natively
 * (bus_attach/bus_detach runner commands); non-GStreamer producers expose it
 * via `UnixFdFanoutController` (below). See `PluginModule.getBusAttachTarget`.
 */
export interface BusAttachTarget {
    sendBusAttach(tee: string, socket: string): void;
    sendBusDetach(socket: string): void;
}

/**
 * Bus fan-out control for a non-GStreamer producer (hls-player): bridges the
 * BusFanoutCoordinator's attach/detach calls to the module's
 * `unixfd-fanout.py` sidecar over its stdin (JSON lines, same verbs as the
 * gst runner).
 *
 * Owns the DESIRED edge set so sidecar lifecycle is invisible to the engine:
 * commands sent while the sidecar is down/restarting are recorded, and every
 * `ready` event (first start and each autoRestart respawn — a fresh process
 * has no listeners) replays the full set. Attach is idempotent on the sidecar
 * side, so replays are harmless.
 *
 * The module feeds sidecar stdout lines to `handleLine` (from its
 * spawnRunnerProcess onStdout hook) and keeps using the parsed result for its
 * own stats handling.
 */
export class UnixFdFanoutController implements BusAttachTarget {
    /** Desired fan-out edges: socket path → tee/channel id (opaque here). */
    private readonly desired = new Map<string, string>();

    constructor(
        private readonly getProc: () => ManagedProcess | null,
        /** Called on every sidecar `ready` — the module triggers its
         *  producer-playing reattach path here (connections made while the
         *  module was down are only known to the coordinator). */
        private readonly onReady?: () => void,
    ) {}

    sendBusAttach(tee: string, socket: string): void {
        this.desired.set(socket, tee);
        this.write({ cmd: 'bus_attach', tee, socket });
    }

    sendBusDetach(socket: string): void {
        this.desired.delete(socket);
        this.write({ cmd: 'bus_detach', socket });
    }

    /**
     * Feed one sidecar stdout line. Returns the parsed JSON object (for the
     * module's own stats/event handling) or null for non-JSON noise.
     */
    handleLine(line: string): Record<string, unknown> | null {
        const i = line.indexOf('{');
        if (i < 0) return null;
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(line.slice(i)) as Record<string, unknown>;
        } catch {
            return null;
        }
        if (msg.event === 'ready') {
            for (const [socket, tee] of this.desired) {
                this.write({ cmd: 'bus_attach', tee, socket });
            }
            this.onReady?.();
        }
        return msg;
    }

    private write(obj: Record<string, unknown>): void {
        this.getProc()?.writeLine(JSON.stringify(obj));
    }
}
