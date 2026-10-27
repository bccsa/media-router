// The consumer ASRCs' `mrasrc-stats` and `mrasrc-event` messages (house-clock WI-P3-6): a decode
// term's clock correction, an output's device clock, the out-of-bounds warning, and the events
// for the log. A capture ASRC (an ingest's: neither term) is its ingest card's alone.
import type { ClockCorrection } from '@media-router/shared-types';
import { ASRC_EVENT, ASRC_STATS } from './ingestTiming.js';
import { launchElements } from './launchElements.js';

export { ASRC_EVENT, ASRC_STATS };

export type AsrcMode = 'capture' | 'bypass' | 'decode' | 'device' | 'decode+device';
const MODES: ReadonlySet<string> = new Set([
    'capture',
    'bypass',
    'decode',
    'device',
    'decode+device',
]);

// The element's clamp on the source fit (asrc_servo.h `ratio_max_ppm`) and its hysteresis: out of
// bounds past 1000 ppm, in again below 900.
const BOUND_PPB = 1_000_000;
const BACK_PPB = 900_000;
const E9 = 1_000_000_000;

/** A rate as `mrasrc-stats` gives it (asrc_rate_of): positive when the clock runs fast. */
export function ratePpbOf(epsPpb: number): number {
    return Math.round((-epsPpb * E9) / (E9 + epsPpb)) || 0;
}

/** What a description built an ASRC with. */
interface AsrcConfig {
    decode: boolean;
    device: boolean;
}

/** One ASRC on display. */
export interface AsrcWatch {
    name: string;
    /** A decode term: none while it passes at house rate, else the source's rate. */
    correction?: ClockCorrection;
    /** A device term: the device clock against house time (ppm, positive fast). */
    devicePpm?: number;
    /** The source fit past the bound (ppm, positive fast), while it stands. */
    outOfBoundsPpm?: number;
}

/** An `mrasrc-event` of a consumer ASRC, for the module's log. */
export interface AsrcLogEvent {
    name: string;
    kind: string;
    reason: string;
    payload: Record<string, unknown>;
    /** `engaged`: the source's rate (ppm, positive fast). */
    sourcePpm?: number;
}

interface Entry {
    at: number;
    mode: AsrcMode;
    state: string;
    sourcePpb: number;
    devicePpb: number;
    inFrames: number;
    relocks: number;
    /** The out-of-bounds fit as a rate (ppb), while it stands. */
    outOfBoundsPpb?: number;
}

type Payload = Record<string, unknown>;
const num = (p: Payload, k: string): number => {
    const v = Number(p[k]);
    return Number.isFinite(v) ? v : 0;
};
const str = (p: Payload, k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');

export class AsrcWatches {
    private readonly entries = new Map<string, Entry>();
    private configs = new Map<string, AsrcConfig>();

    /** The run's ASRCs as its description builds them: a decode term where `bypass-below-ppm` is
     *  above 0, a device term where `device-sink` is set (a live branch's is known by its mode). */
    configure(pipeline: string | undefined): void {
        this.configs = new Map();
        for (const [name, p] of launchElements(pipeline ?? '', 'mrasrc')) {
            const decode = Number(p['bypass-below-ppm'] ?? 0) > 0;
            this.configs.set(name, { decode, device: !!p['device-sink'] });
        }
    }

    /** A decode or device term by its configuration, or by a mode other than capture. */
    private consumer(name: string): boolean {
        const c = this.configs.get(name);
        if (c) return c.decode || c.device;
        const e = this.entries.get(name);
        return !!e && e.mode !== 'capture';
    }

    /** One message from element `name` (`structure` is `mrasrc-stats` or `mrasrc-event`):
     *  whether its out-of-bounds warning changed, and an event to log. Null for a capture
     *  ASRC's message, or one that is neither structure. */
    take(
        structure: string,
        name: string,
        payload: unknown,
        now: number,
    ): { changed: boolean; event?: AsrcLogEvent } | null {
        const p = (payload ?? {}) as Payload;
        if (structure === ASRC_STATS) return this.stats(name, p, now);
        if (structure !== ASRC_EVENT || !this.consumer(name)) return null;
        const e = this.entries.get(name);
        const kind = str(p, 'kind');
        const event: AsrcLogEvent = { name, kind, reason: str(p, 'reason'), payload: p };
        if (kind === 'engaged') event.sourcePpm = num(p, 'source-ppb') / 1000;
        if (kind !== 'ratio-out-of-bounds' || !e) return { changed: false, event };
        const was = e.outOfBoundsPpb;
        e.outOfBoundsPpb = ratePpbOf(num(p, 'fit-ppb'));
        return { changed: was === undefined, event };
    }

    private stats(name: string, p: Payload, now: number): { changed: boolean } | null {
        const mode = str(p, 'mode');
        if (!MODES.has(mode) || mode === 'capture') return null;
        const old = this.entries.get(name);
        const inFrames = num(p, 'in-frames');
        const relocks = num(p, 'relocks');
        // A new element under an old name (a runner respawn) starts with nothing standing.
        const again = old && (inFrames < old.inFrames || relocks < old.relocks);
        const e: Entry = {
            at: now,
            mode: mode as AsrcMode,
            state: str(p, 'state'),
            sourcePpb: num(p, 'source-ppb'),
            devicePpb: num(p, 'device-ppb'),
            inFrames,
            relocks,
            ...(old && !again && old.outOfBoundsPpb !== undefined
                ? { outOfBoundsPpb: old.outOfBoundsPpb }
                : {}),
        };
        // Back in bounds once the locked source rate is below the element's hysteresis.
        if (e.state === 'locked' && Math.abs(e.sourcePpb) < BACK_PPB) e.outOfBoundsPpb = undefined;
        this.entries.set(name, e);
        return {
            changed: (old?.outOfBoundsPpb !== undefined) !== (e.outOfBoundsPpb !== undefined),
        };
    }

    /** Forget ASRCs that stopped reporting (input removed, pipeline gone). */
    expire(now: number, staleMs: number): void {
        for (const [name, e] of this.entries) if (now - e.at > staleMs) this.entries.delete(name);
    }

    list(): AsrcWatch[] {
        const out: AsrcWatch[] = [];
        for (const [name, e] of this.entries) {
            const w: AsrcWatch = { name };
            const engaged = e.mode === 'decode' || e.mode === 'decode+device';
            // `device` from a decode + device element: its source still passes at house rate.
            const decode =
                engaged ||
                e.mode === 'bypass' ||
                (e.mode === 'device' && this.configs.get(name)?.decode);
            if (decode) w.correction = engaged ? { sourcePpm: e.sourcePpb / 1000 } : {};
            if (e.mode === 'device' || e.mode === 'decode+device') w.devicePpm = e.devicePpb / 1000;
            if (e.outOfBoundsPpb !== undefined) w.outOfBoundsPpm = e.outOfBoundsPpb / 1000;
            out.push(w);
        }
        return out;
    }

    clear(): void {
        this.entries.clear();
    }
}

/** The out-of-bounds warning's text, on the input it names (none: the module's own ASRC). */
export function asrcWarningText(ppm: number, label?: string): string {
    const who = label ? `Input ${label}: source clock` : 'Source clock';
    return (
        `${who} ${signedPpm(ppm)} off house time, past the ASRC's ${BOUND_PPB / 1000} ppm` +
        " — check the source's sample rate"
    );
}

/** `+23.4 ppm`, `−12.1 ppm` (one decimal, a true minus sign), `0.0 ppm`. */
export function signedPpm(ppm: number): string {
    const tenths = Math.round(ppm * 10);
    const sign = tenths > 0 ? '+' : tenths < 0 ? '−' : '';
    return `${sign}${(Math.abs(tenths) / 10).toFixed(1)} ppm`;
}

/** A row's text: `none (house rate)`, or the source's rate while it is rate-matched. */
export function clockCorrectionText(c: ClockCorrection): string {
    return c.sourcePpm === undefined ? 'none (house rate)' : `${signedPpm(c.sourcePpm)} (source)`;
}
