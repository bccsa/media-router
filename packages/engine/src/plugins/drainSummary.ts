// The drain's summary and its rows (house-clock WI-P4-18, B-179): an output's built-up latency
// played back down to its target at up to 0.5 %, in sync with its A/V group. No setting, no alarm.
import type { DrainSummary } from '@media-router/shared-types';
import type { DrainFields } from './asrcWatches.js';
import type { DrainGroupView } from './drainGroups.js';

/** The drain's cap (ppm) and the law's time constant and saturation (design part 5). */
export const DRAIN_MAX_PPM = 5000;
const TAU_S = 30;
const SATURATED_MS = 150;
const NEAR_MS = 20;

/** The summary from an element's fields, its render lateness, its group as the engine set it. */
export function drainSummary(
    f: DrainFields,
    nowMs: number,
    group: DrainGroupView | undefined,
    video?: { rateKnown: boolean; drainDropsPerMin?: number },
): DrainSummary {
    const own = nowMs - f.excessMs;
    const following = f.groupTargetMs > 0 && f.state !== 'warm-up' && !!group?.with?.length;
    const d: DrainSummary = {
        targetMs: following ? Math.min(f.groupTargetMs, own + 1000) : own,
        nowMs,
        excessMs: f.excessMs,
        ppm: f.ppm,
        marginMs: f.marginMs,
        drainedMs: f.drainedMs,
        underruns: f.underruns,
        raises: f.raises,
        state: f.state,
    };
    if (f.publishedMs !== undefined) d.publishedMs = f.publishedMs;
    if (video && !video.rateKnown) d.notMeasured = true;
    if (f.capped) d.capped = true;
    if (group?.with?.length) d.groupWith = group.with;
    if (group?.neither?.length) d.neither = true;
    if (video?.drainDropsPerMin !== undefined) d.drainDropsPerMin = video.drainDropsPerMin;
    return d;
}

/** Part 5's time to within 20 ms of the target at the cap: (E - 150 ms) / 5 ms/s + 30 s ln(150 / 20),
 *  an exponential approach alone below 150 ms. */
export function drainSeconds(excessMs: number): number {
    if (excessMs <= NEAR_MS) return 0;
    const tail = TAU_S * Math.log(Math.min(excessMs, SATURATED_MS) / NEAR_MS);
    return Math.max(0, excessMs - SATURATED_MS) / (DRAIN_MAX_PPM / 1000) + tail;
}

function msOrS(ms: number): string {
    return Math.abs(ms) >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function about(seconds: number): string {
    return seconds < 90
        ? `about ${Math.max(1, Math.round(seconds))} s`
        : `about ${Math.round(seconds / 60)} min`;
}

/** `95 ms (measured), now 2.41 s · draining at 0.50 % (about 7 min) · in sync with Video Player`. */
export function latencyTargetText(d: DrainSummary): string {
    if (d.notMeasured) return 'not measured (no display rate)';
    const parts = [`${msOrS(d.targetMs)} (measured), now ${msOrS(d.nowMs)}`];
    const pct = (Math.abs(d.ppm) / 10000).toFixed(2);
    if (d.state === 'warm-up') parts.push('measuring');
    else if (d.ppm > 0)
        parts.push(`draining at ${pct} % (${about(drainSeconds(d.nowMs - d.targetMs))})`);
    if (d.capped) parts.push('1 s behind its group: held there');
    else if (d.ppm < 0) parts.push(`rising to its group at ${pct} %`);
    if (d.neither) parts.push('in sync with neither (two programmes)');
    else if (d.groupWith?.length) parts.push(`in sync with ${d.groupWith.join(', ')}`);
    return parts.join(' · ');
}

/** `2.30 s`, `340 ms`. */
export function drainedText(d: DrainSummary): string {
    return msOrS(d.drainedMs);
}

/** `3, 3 raised the target`; `0`. */
export function underrunsText(d: DrainSummary): string {
    return d.underruns ? `${d.underruns}, ${d.raises} raised the target` : '0';
}

/** `Draining 2.30 s of built-up latency at up to 0.5 % (about 8 min)`. */
export function drainStartText(d: DrainSummary): string {
    const e = Math.max(d.nowMs - d.targetMs, d.excessMs);
    return `Draining ${msOrS(e)} of built-up latency at up to 0.5 % (${about(drainSeconds(e))})`;
}

/** `Back at its latency target (95 ms): drained 2.30 s`. */
export function drainDoneText(d: DrainSummary): string {
    return `Back at its latency target (${msOrS(d.targetMs)}): drained ${msOrS(d.drainedMs)}`;
}
