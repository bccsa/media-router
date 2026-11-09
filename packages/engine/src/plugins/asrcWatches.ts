// The consumer ASRCs' `mrasrc-stats` and `mrasrc-event` messages (house-clock WI-P3-6): a decode
// term's clock correction, an output's device clock, the out-of-bounds warning, and the events
// for the log; a device term's render lateness, relocks and stalls (WI-P4-12). A capture ASRC (an
// ingest's: neither term) is its ingest card's alone.
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
    /** A device term: the lateness of what its device plays (absent while unknown), its
     *  relocks and stalls, and whether it stands stalled (`device-stalled` to `device-resumed`). */
    renderLatenessMs?: number;
    deviceRelocks?: number;
    deviceStalls?: number;
    stalled?: boolean;
    /** Changes at every relock, gap and stall the element counts, and at a new element. */
    gapMark: string;
}

/** An `mrasrc-event` of a consumer ASRC, for the module's log. */
export interface AsrcLogEvent {
    name: string;
    kind: string;
    reason: string;
    payload: Record<string, unknown>;
    /** `engaged`: the source's rate (ppm, positive fast), once measured. */
    sourcePpm?: number;
    /** `engaged` before the rate is measured (B-148): how far the PTS ran off the sample count (ms). */
    offMs?: number;
}

interface Entry {
    at: number;
    mode: AsrcMode;
    state: string;
    sourcePpb: number;
    devicePpb: number;
    inFrames: number;
    relocks: number;
    /** The lock has measured the source's rate (`rate-known`; true where a run does not say). */
    rateKnown: boolean;
    /** The out-of-bounds fit as a rate (ppb), while it stands. */
    outOfBoundsPpb?: number;
    gaps: number;
    deviceRelocks: number;
    deviceStalls: number;
    /** 0 while the device term does not know it (the element's rule). */
    renderLatenessNs: number;
    stalled: boolean;
    generation: number;
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
        if (kind === 'engaged' && p['rate-known'] === false) {
            event.offMs = Math.abs(num(p, 'phase-ns')) / 1e6;
        } else if (kind === 'engaged') {
            event.sourcePpm = num(p, 'source-ppb') / 1000;
        }
        if ((kind === 'device-stalled' || kind === 'device-resumed') && e) {
            const was = e.stalled;
            e.stalled = kind === 'device-stalled';
            return { changed: was !== e.stalled, event };
        }
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
        const again = !!old && (inFrames < old.inFrames || relocks < old.relocks);
        const kept = old && !again;
        const e: Entry = {
            at: now,
            mode: mode as AsrcMode,
            state: str(p, 'state'),
            sourcePpb: num(p, 'source-ppb'),
            devicePpb: num(p, 'device-ppb'),
            inFrames,
            relocks,
            rateKnown: p['rate-known'] !== false,
            ...(kept && old.outOfBoundsPpb !== undefined
                ? { outOfBoundsPpb: old.outOfBoundsPpb }
                : {}),
            gaps: num(p, 'gaps'),
            deviceRelocks: num(p, 'device-relocks'),
            deviceStalls: num(p, 'device-stalls'),
            renderLatenessNs: num(p, 'render-lateness-ns'),
            stalled: kept ? old.stalled : false,
            generation: (old?.generation ?? 0) + (again ? 1 : 0),
        };
        // Back in bounds once the locked source rate is below the element's hysteresis.
        if (e.state === 'locked' && Math.abs(e.sourcePpb) < BACK_PPB) e.outOfBoundsPpb = undefined;
        this.entries.set(name, e);
        return {
            changed:
                (old?.outOfBoundsPpb !== undefined) !== (e.outOfBoundsPpb !== undefined) ||
                !!old?.stalled !== e.stalled,
        };
    }

    /** Forget ASRCs that stopped reporting (input removed, pipeline gone). */
    expire(now: number, staleMs: number): void {
        for (const [name, e] of this.entries) if (now - e.at > staleMs) this.entries.delete(name);
    }

    list(): AsrcWatch[] {
        const out: AsrcWatch[] = [];
        for (const [name, e] of this.entries) {
            const mark = [e.generation, e.relocks, e.gaps, e.deviceRelocks, e.deviceStalls];
            const w: AsrcWatch = { name, gapMark: mark.join('/') };
            const engaged = e.mode === 'decode' || e.mode === 'decode+device';
            // `device` from a decode + device element: its source still passes at house rate.
            const decode =
                engaged ||
                e.mode === 'bypass' ||
                (e.mode === 'device' && this.configs.get(name)?.decode);
            // Engaged before the rate is measured (B-148): `measuring`, not a 0.0 ppm source.
            if (decode && engaged) {
                w.correction = e.rateKnown
                    ? { sourcePpm: e.sourcePpb / 1000 }
                    : { measuring: true };
            } else if (decode) {
                w.correction = {};
            }
            if (e.mode === 'device' || e.mode === 'decode+device') {
                w.devicePpm = e.devicePpb / 1000;
                if (e.renderLatenessNs !== 0) w.renderLatenessMs = e.renderLatenessNs / 1e6;
                w.deviceRelocks = e.deviceRelocks;
                w.deviceStalls = e.deviceStalls;
                w.stalled = e.stalled;
            }
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

/** A device term that stopped taking audio (B-166's stall rule: skip, then play live). */
export const DEVICE_STALLED_TEXT =
    'Audio device stalled — nothing plays until it takes audio again, then it plays live';

/** `+23.4 ppm`, `−12.1 ppm` (one decimal, a true minus sign), `0.0 ppm`. */
export function signedPpm(ppm: number): string {
    const tenths = Math.round(ppm * 10);
    const sign = tenths > 0 ? '+' : tenths < 0 ? '−' : '';
    return `${sign}${(Math.abs(tenths) / 10).toFixed(1)} ppm`;
}

/** A row's text: `none (house rate)`, the source's rate while it is rate-matched, or `measuring`
 *  while it resamples before that rate is measured. */
export function clockCorrectionText(c: ClockCorrection): string {
    if (c.measuring) return 'measuring';
    return c.sourcePpm === undefined ? 'none (house rate)' : `${signedPpm(c.sourcePpm)} (source)`;
}
