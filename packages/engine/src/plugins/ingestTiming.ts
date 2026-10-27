// Ingest timing (house-clock plan WI-P1-9; WI-P3-5): the `mrtsrestamp` and `mrasrc` fragments,
// their bus reports and the live edits of O, the per-PID trims and the smoothing cooldown, for the
// seven ingest modules. The card is IngestTimingReporter; the settings are injected from shared-types.
import {
    INGEST_OFFSET_KEY,
    INGEST_OFFSET_MAX_MS,
    PID_TRIMS_KEY,
    PID_TRIM_MAX_MS,
    SMOOTHING_COOLDOWN_DEFAULT_MIN,
    SMOOTHING_COOLDOWN_KEY,
    SMOOTHING_COOLDOWN_MAX_MIN,
} from '@media-router/shared-types';
import { quoteGstString } from './busHelpers.js';
import type { BusReport } from './PluginModule.js';

export { INGEST_OFFSET_KEY, PID_TRIMS_KEY, SMOOTHING_COOLDOWN_KEY };

export const RESTAMP_ELEMENT = 'restamp';
export const ASRC_ELEMENT = 'asrc';
/** Element messages (plan ch. 5 part 10); a bus report forwards each as `<structure>:<element>`. */
export const RESTAMP_STATS = 'mrtsrestamp-stats';
export const RESTAMP_PID = 'mrtsrestamp-pid';
export const RESTAMP_EVENT = 'mrtsrestamp-event';
export const ASRC_STATS = 'mrasrc-stats';
export const ASRC_EVENT = 'mrasrc-event';

/** `stc`: a network ingest locks a virtual STC to the PCR. `fixed`: a capture keeps PES − 1 h. */
export type RestampMode = 'stc' | 'fixed';

const NS_PER_MS = 1_000_000;
const NS_PER_MIN = 60_000_000_000;
const MAX_PID = 0x1fff;
const clampMs = (ms: number, max: number): number => Math.min(max, Math.max(-max, ms));

/** O as `offset-ns`; anything but a finite number is 0. Clamped here because a live edit skips
 *  the engine's schema check and the element applies whatever it is given. */
function ingestOffsetNs(ms: unknown): number {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 0;
    return Math.round(clampMs(ms, INGEST_OFFSET_MAX_MS) * NS_PER_MS);
}

/** The cooldown as `smoothing-cooldown-ns`, clamped to 0-60 min as O is; anything but a finite
 *  number is the default 5 min (B-95's 300 s, the element's own default). */
function smoothingCooldownNs(min: unknown): number {
    if (typeof min !== 'number' || !Number.isFinite(min)) {
        return SMOOTHING_COOLDOWN_DEFAULT_MIN * NS_PER_MIN;
    }
    return Math.round(Math.min(SMOOTHING_COOLDOWN_MAX_MIN, Math.max(0, min)) * NS_PER_MIN);
}

/** The trims as `pid-trims`: `<pid>=<ns>;…` in PID order, each clamped to ±2 s. Keys that are
 *  not a PID as the card writes it (plain decimal, so no two keys name one PID), values that
 *  are not numbers and zero trims are left out. */
function pidTrimsProperty(trims: unknown): string {
    if (!trims || typeof trims !== 'object' || Array.isArray(trims)) return '';
    const out: Array<[pid: number, ns: number]> = [];
    for (const [key, ms] of Object.entries(trims)) {
        const pid = /^(0|[1-9]\d{0,3})$/.test(key) ? Number(key) : -1;
        if (pid < 0 || pid > MAX_PID || typeof ms !== 'number' || !Number.isFinite(ms)) continue;
        const ns = Math.round(clampMs(ms, PID_TRIM_MAX_MS) * NS_PER_MS);
        if (ns !== 0) out.push([pid, ns]);
    }
    return out
        .sort(([a], [b]) => a - b)
        .map(([pid, ns]) => `${pid}=${ns}`)
        .join(';');
}

export interface RestampOptions {
    mode: RestampMode;
    /** `fixed` only: add the pipeline's base time (video-encoder's live capture clock, part 4.6). */
    addBaseTime?: boolean;
    /** The module's `ingestOffsetMs` as configured. */
    offsetMs?: unknown;
    /** The module's `pidTrimsMs` as configured. */
    pidTrimsMs?: unknown;
    /** `stc` only: the module's `smoothingCooldownMin` as configured. */
    smoothingCooldownMin?: unknown;
    name?: string;
}

/** The restamp goes right after the transport element, before any queue: it reads arrival
 *  itself (part 4.1). No trims leaves `pid-trims` at its empty default; a capture (`fixed`) has
 *  no clock lock, so no cooldown. */
export function buildRestamp({
    mode,
    addBaseTime = false,
    offsetMs,
    pidTrimsMs,
    smoothingCooldownMin,
    name = RESTAMP_ELEMENT,
}: RestampOptions): string {
    const props = [`name=${name}`, `clock-mode=${mode}`];
    if (addBaseTime) props.push('add-base-time=true');
    if (mode === 'stc') {
        props.push(`smoothing-cooldown-ns=${smoothingCooldownNs(smoothingCooldownMin)}`);
    }
    props.push(`offset-ns=${ingestOffsetNs(offsetMs)}`);
    const trims = pidTrimsProperty(pidTrimsMs);
    if (trims) props.push(`pid-trims=${quoteGstString(trims)}`);
    return `mrtsrestamp ${props.join(' ')}`;
}

/** The element's bound on `bypass-below-ppm`. */
const BYPASS_MAX_PPM = 1000;

export interface AsrcOptions {
    name?: string;
    /** Unset or 0: the rate the caps after it negotiate (B-22). */
    outRate?: number;
    /** Decode mode above 0 (WI-P3-5): buffers pass unchanged while their source measures within
     *  this many ppm of house time; resampled once it does not. Unset or 0: capture mode. */
    bypassBelowPpm?: number;
    /** The `GstAudioBaseSink` downstream (with `slave-method=custom`) whose clock the output
     *  follows; with no bypass, that device term alone (S17). */
    deviceSink?: string;
    /** A `pipewiresrc` capture, one buffer per graph cycle, so lost cycles are a gap and no
     *  relock (B-180); capture mode only. */
    cycleInput?: boolean;
}

/** `mrasrc` with its mode: capture (no option), decode (`bypassBelowPpm`), device (`deviceSink`). */
export function buildAsrc({
    name = ASRC_ELEMENT,
    outRate,
    bypassBelowPpm,
    deviceSink,
    cycleInput = false,
}: AsrcOptions = {}): string {
    const props = [`name=${name}`];
    if (
        typeof bypassBelowPpm === 'number' &&
        Number.isFinite(bypassBelowPpm) &&
        bypassBelowPpm > 0
    ) {
        props.push(`bypass-below-ppm=${Math.min(bypassBelowPpm, BYPASS_MAX_PPM)}`);
    }
    if (deviceSink) {
        props.push(
            `device-sink=${/^[\w.-]+$/.test(deviceSink) ? deviceSink : quoteGstString(deviceSink)}`,
        );
    }
    if (outRate && outRate > 0) props.push(`out-rate=${Math.round(outRate)}`);
    if (cycleInput) props.push('cycle-input=true');
    return `mrasrc ${props.join(' ')}`;
}

export function restampBusReports(name = RESTAMP_ELEMENT): BusReport[] {
    return [RESTAMP_STATS, RESTAMP_PID, RESTAMP_EVENT].map((structure) => ({
        element: name,
        structure,
    }));
}

export function asrcBusReports(name = ASRC_ELEMENT): BusReport[] {
    return [ASRC_STATS, ASRC_EVENT].map((structure) => ({ element: name, structure }));
}

/** GstPluginBase keeps `setElementProperty` protected, so a module passes
 *  `{ setElementProperty: (e, p, v) => this.setElementProperty(e, p, v) }`. */
export interface RestampControl {
    setElementProperty(element: string, property: string, value: unknown): Promise<void>;
}

/** Live edits of O, the trims and the cooldown, from `onLiveConfigUpdate`; other keys are ignored.
 *  The restamp applies O and the trims from each PID's next PES: a gap, or a dropped overlap
 *  (§5.5); the cooldown from each clock's next 1 s close. */
export async function applyIngestTimingLiveUpdate(
    module: RestampControl,
    changes: Record<string, unknown>,
    name = RESTAMP_ELEMENT,
): Promise<void> {
    if (INGEST_OFFSET_KEY in changes) {
        await module.setElementProperty(
            name,
            'offset-ns',
            ingestOffsetNs(changes[INGEST_OFFSET_KEY]),
        );
    }
    if (PID_TRIMS_KEY in changes) {
        await module.setElementProperty(
            name,
            'pid-trims',
            pidTrimsProperty(changes[PID_TRIMS_KEY]),
        );
    }
    if (SMOOTHING_COOLDOWN_KEY in changes) {
        await module.setElementProperty(
            name,
            'smoothing-cooldown-ns',
            smoothingCooldownNs(changes[SMOOTHING_COOLDOWN_KEY]),
        );
    }
}
