import * as path from 'path';
import { createLogger } from '@media-router/shared-types';
import type { ProcessManager } from './ProcessManager.js';
import type { ManagedProcess } from './ManagedProcess.js';
import type { ClockConfig } from '../plugins/PluginModule.js';

export type { ClockConfig };

const log = createLogger('ClockAuthority');


/**
 * Owns the single net-clock daemon (`gst-net-clock.py`) that lets independent
 * GStreamer pipelines share one clock for cross-pipeline A/V sync.
 *
 * Lazily spawned on first request and kept alive for the engine's lifetime
 * (it's tiny — just serves time). Hands out only where to reach the clock
 * (`{host, port}`); each pipeline anchors base-time naturally on that shared
 * clock. Sharing the clock removes the drift (same rate); the residual is a
 * small constant per-pipeline start offset (trim with a sink ts-offset). No
 * base-time is round-tripped — coordinating one across processes in this
 * clock's time domain is fragile and unnecessary for drift-free sync.
 */
export class ClockAuthority {
    private proc: ManagedProcess | null = null;
    private port: number | null = null;
    private pending: Promise<ClockConfig | null> | null = null;

    constructor(private readonly processManager: ProcessManager) {}

    /**
     * Resolve the shared clock config, spawning the daemon on first call.
     * Returns null if the daemon can't be brought up (caller then runs the
     * pipeline unsynced — sync is best-effort, never blocks playback).
     */
    async getClockConfig(): Promise<ClockConfig | null> {
        if (this.port !== null) {
            return { host: '127.0.0.1', port: this.port };
        }
        if (!this.pending) this.pending = this.spawn();
        return this.pending;
    }

    private spawn(): Promise<ClockConfig | null> {
        const daemonPath = path.resolve(__dirname, 'gst-net-clock.py');
        return new Promise((resolve) => {
            let settled = false;
            const done = (cfg: ClockConfig | null): void => {
                if (settled) return;
                settled = true;
                resolve(cfg);
            };
            // 5 s ceiling: if the daemon never reports a port, fall back to
            // unsynced rather than hanging the module's start.
            const timer = setTimeout(() => {
                if (!settled) log.warn('clock daemon did not report a port — pipelines run unsynced');
                done(null);
            }, 5000);
            this.proc = this.processManager.spawn('__clock_authority__', {
                label: 'gst-net-clock',
                command: 'python3',
                args: [daemonPath],
                autoRestart: true,
                onStdout: (line) => {
                    const port = parseClockReady(line);
                    if (port === null) return;
                    clearTimeout(timer);
                    this.port = port;
                    // No explicit base-time: pipelines anchor naturally on the
                    // shared clock (kills drift, leaves a small constant offset).
                    log.info({ port }, 'clock authority ready');
                    done({ host: '127.0.0.1', port });
                },
                onStderr: (line) => log.debug({ line }, 'clock daemon'),
            });
        });
    }
}

/** Parse the served port from the daemon's `clock_ready` line, or null. */
export function parseClockReady(line: string): number | null {
    const idx = line.indexOf('GST_JSON:');
    if (idx < 0) return null;
    try {
        const evt = JSON.parse(line.slice(idx + 'GST_JSON:'.length));
        if (evt?.event === 'clock_ready' && typeof evt.port === 'number' && evt.port > 0) {
            return evt.port;
        }
    } catch {
        /* not a JSON event line */
    }
    return null;
}
