import { EventEmitter } from 'events';
import { createLogger } from '@media-router/shared-types';
import type {
    ChronyTracking,
    HouseEpoch,
    TimeSyncSource,
    TimeSyncState,
} from '@media-router/shared-types';
import type { ProcessManager } from '../child-process/ProcessManager.js';
import type { ManagedProcess } from '../child-process/ManagedProcess.js';
import { resolveNativeBinary } from '../child-process/nativeBinaries.js';
import { pollClockSource, type ExecStdout } from './clockSource.js';
import {
    START_WAIT_MS,
    decide,
    deltaNs,
    parseClockLine,
    qualifies,
    type ClockSample,
    type Decision,
} from './houseClockPolicy.js';

const log = createLogger('clock');

const OWNER = '__house_clock__';
const SOURCE_POLL_MS = 10_000;

export interface HouseClockOptions {
    processManager: Pick<ProcessManager, 'spawn' | 'kill'>;
    /** Path to mr-clockstate, or null when it is not built/installed. */
    resolveBinary?: () => string | null;
    exec?: ExecStdout;
    startWaitMs?: number;
    sourcePollMs?: number;
    /** Sidecar restart backoff; tests shorten it. */
    restartDelayMs?: number;
}

const ms = (ns: bigint): string => (Number(ns) / 1e6).toFixed(3);

/** The engine's one owner of the house epoch E = TAI − MONOTONIC and its time-sync state
 *  (design §4.2, §10.3): mr-clockstate measures, this decides, so a sidecar restart never
 *  re-epochs on its own. Emits `epoch` on every (re-)latch and `state` on any change. */
export class HouseClock extends EventEmitter {
    private proc: ManagedProcess | null = null;
    private current: HouseEpoch | null = null;
    private last: ClockSample | null = null;
    private stepped = false;
    private waitExpired = false;
    private startedAt = 0;
    private source: TimeSyncSource = 'none';
    private chrony: ChronyTracking | undefined;
    private sidecar = true;
    private latchedAt: string | undefined;
    private waitTimer: ReturnType<typeof setTimeout> | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private resolveReady!: (e: HouseEpoch | null) => void;
    private readonly readyPromise = new Promise<HouseEpoch | null>((r) => (this.resolveReady = r));
    private isReady = false;
    /** Lines held until the first source poll, so the first latch names its source. */
    private held: string[] | null = [];

    constructor(private readonly opts: HouseClockOptions) {
        super();
    }

    /** Starts the sidecar and the 30 s wait. The wait runs from here, not from module start. */
    start(): void {
        if (this.startedAt) return;
        this.startedAt = Date.now();
        this.pollTimer = setInterval(
            () => void this.pollSource(),
            this.opts.sourcePollMs ?? SOURCE_POLL_MS,
        );
        void this.pollSource().then(() => {
            const held = this.held ?? [];
            this.held = null;
            for (const line of held) this.onLine(line);
        });

        const bin = (
            this.opts.resolveBinary ?? (() => resolveNativeBinary('mr-clockstate', 'engine'))
        )();
        if (!bin) {
            this.sidecar = false;
            log.error('clock: mr-clockstate missing — no epoch, modules start at once');
            this.markReady();
            return;
        }
        this.waitTimer = setTimeout(
            () => this.onWaitExpired(),
            this.opts.startWaitMs ?? START_WAIT_MS,
        );
        const delay = this.opts.restartDelayMs ?? 1000;
        this.proc = this.opts.processManager.spawn(OWNER, {
            label: 'mr-clockstate',
            command: bin,
            autoRestart: true,
            backoff: { baseDelayMs: delay, maxDelayMs: 30 * delay, maxAttempts: 0 },
            onStdout: (line) => (this.held ? this.held.push(line) : this.onLine(line)),
        });
        this.proc.on('error', (message: string) =>
            log.error({ message }, 'clock: mr-clockstate failed'),
        );
    }

    async stop(): Promise<void> {
        if (this.waitTimer) clearTimeout(this.waitTimer);
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.waitTimer = this.pollTimer = null;
        if (this.proc) await this.opts.processManager.kill(OWNER, this.proc);
        this.proc = null;
    }

    /** Resolves after the start wait: with the latched epoch, or null when there is none. */
    ready(): Promise<HouseEpoch | null> {
        return this.readyPromise;
    }

    epoch(): HouseEpoch | null {
        return this.current;
    }

    state(): TimeSyncState {
        const s = this.last;
        const e = this.current;
        const waiting = !this.isReady && this.startedAt > 0;
        const waitMs = this.opts.startWaitMs ?? START_WAIT_MS;
        return {
            source: this.source,
            synced: s?.synced ?? false,
            traceable: e?.traceable ?? false,
            taiOffsetS: s?.taiOffsetS ?? 0,
            estErrorUs: s?.estErrorUs ?? 0,
            maxErrorUs: s?.maxErrorUs ?? 0,
            freqPpm: s?.freqPpm ?? 0,
            waitingForSync: waiting,
            ...(waiting
                ? {
                      waitRemainingS: Math.max(
                          0,
                          Math.ceil((this.startedAt + waitMs - Date.now()) / 1000),
                      ),
                  }
                : {}),
            epochSeq: e?.seq ?? 0,
            ...(e
                ? { epochLatchedAt: this.latchedAt, epochReason: e.reason, eNs: String(e.eNs) }
                : {}),
            sidecar: this.sidecar,
            ...(this.chrony ? { chrony: this.chrony } : {}),
        };
    }

    private onLine(line: string): void {
        const msg = parseClockLine(line);
        if (!msg) return;
        if (msg.type === 'step') {
            this.stepped = true;
            return;
        }
        const prev = this.last;
        this.last = msg.sample;
        const stepped = this.stepped;
        this.stepped = false;
        this.apply(
            decide(this.current, msg.sample, { waitExpired: this.waitExpired, stepped }),
            msg.sample,
        );
        if (!prev || prev.synced !== msg.sample.synced || prev.taiOffsetS !== msg.sample.taiOffsetS)
            this.emit('state', this.state());
    }

    private onWaitExpired(): void {
        this.waitTimer = null;
        this.waitExpired = true;
        const s = this.last;
        log.warn(
            `clock: no time sync after ${Math.round((this.opts.startWaitMs ?? START_WAIT_MS) / 1000)} s ` +
                `(source=${this.source}, synced=${s?.synced ?? 'unknown'}, tai=${s?.taiOffsetS ?? 'unknown'}) ` +
                '— starting untraceable',
        );
        this.apply(decide(this.current, s, { waitExpired: true, stepped: false }), s);
        this.markReady(); // no sample yet: modules still go, the first sample latches
    }

    private apply(d: Decision, s: ClockSample | null): void {
        if (d.kind === 'none') {
            if (d.stepIgnored && s && this.current)
                log.info(
                    `clock: realtime step, E unchanged (ΔE=${(Number(deltaNs(s.eNs, this.current.eNs)) / 1e3).toFixed(1)} µs)`,
                );
            return;
        }
        if (!s) return;
        if (d.kind === 'traceable') {
            this.current = { ...this.current!, traceable: d.traceable, taiOffsetS: s.taiOffsetS };
            if (d.traceable)
                log.info(`clock: sync arrived, E unchanged — traceable (source=${this.source})`);
            else log.warn(`clock: sync lost (source=${this.source})`);
            this.emit('state', this.state());
            return;
        }
        const prev = this.current;
        this.current = {
            eNs: s.eNs,
            seq: (prev?.seq ?? 0) + 1,
            latchedAtMonoNs: s.monoNs,
            traceable: qualifies(s),
            reason: d.reason,
            source: this.source,
            taiOffsetS: s.taiOffsetS,
        };
        this.latchedAt = new Date().toISOString();
        const err = `±${(s.estErrorUs / 1000).toFixed(1)} ms`;
        if (d.kind === 'latch') {
            log.info(
                `clock: epoch latched seq=${this.current.seq} reason=${d.reason} source=${this.source} tai=${s.taiOffsetS} est=${err}`,
            );
        } else {
            const text = `clock: re-epoch seq=${this.current.seq} reason=${d.reason} ΔE=${ms(s.eNs - prev!.eNs)} ms source=${this.source} est=${err}`;
            if (d.reason === 'sync') log.info(text);
            else log.warn(text);
        }
        this.markReady();
        this.emit('epoch', this.current);
        this.emit('state', this.state());
    }

    private markReady(): void {
        if (this.isReady) return;
        this.isReady = true;
        if (this.waitTimer) clearTimeout(this.waitTimer);
        this.waitTimer = null;
        this.resolveReady(this.current);
        this.emit('state', this.state());
    }

    private async pollSource(): Promise<void> {
        try {
            const { source, chrony } = await pollClockSource(this.opts.exec);
            const changed = source !== this.source;
            this.source = source;
            this.chrony = chrony;
            if (changed) this.emit('state', this.state());
        } catch (err) {
            log.debug({ err }, 'clock: source poll failed');
        }
    }
}
