// The drain's summary and its rows (house-clock WI-P4-18, B-179): an output's built-up latency
// played back down to its target at up to 0.5 %, in sync with its A/V group. No setting, no alarm.
import type { DrainSummary, UnderrunReason } from '@media-router/shared-types';
import type { DrainFields } from './asrcWatches.js';
import type { DrainGroupView } from './drainGroups.js';

/** The group target that means alone (`group-target-ns`' minimum, -1 h); any other groups, below 0
 *  included: an output fed from a network ingest plays early (B-177). */
export const DRAIN_GROUP_ALONE_NS = -3_600_000_000_000;

/** The drain's cap (ppm) and the law's time constant and saturation (design part 5). */
export const DRAIN_MAX_PPM = 5000;
const TAU_S = 30;
const SATURATED_MS = 150;
const NEAR_MS = 20;
/** V-P4-5: members within this of each other in render lateness are in sync (B-241). */
export const GROUP_SYNC_MS = 45;

/** The summary from an element's fields, its render lateness, its group as the engine set it. */
export function drainSummary(
    f: DrainFields,
    nowMs: number,
    group: DrainGroupView | undefined,
    video?: { rateKnown: boolean; drainDropsPerMin?: number },
): DrainSummary {
    const own = nowMs - Math.max(f.excessMs, 0); // as the element: T = L - max(E, 0)
    const grouped = f.groupTargetMs !== undefined && !!group?.with?.length;
    const following = grouped && f.state !== 'warm-up';
    const d: DrainSummary = {
        targetMs: following ? Math.min(f.groupTargetMs!, own + 1000) : own,
        nowMs,
        excessMs: f.excessMs,
        ppm: f.ppm,
        marginMs: f.marginMs,
        drainedMs: f.drainedMs,
        underruns: f.underruns,
        raises: f.raises,
        state: f.state,
    };
    if (f.reasons) d.underrunReasons = f.reasons;
    if (f.publishedMs !== undefined) d.publishedMs = f.publishedMs;
    if (video && !video.rateKnown) d.notMeasured = true;
    if (f.capped) d.capped = true;
    if (grouped) Object.assign(d, groupSync(nowMs, group!));
    if (group?.neither?.length) d.neither = true;
    if (video?.drainDropsPerMin !== undefined) d.drainDropsPerMin = video.drainDropsPerMin;
    return d;
}

/** The group's members against this one's render lateness: the furthest past 45 ms, or unjudged
 *  while one is unknown (B-241). */
function groupSync(
    nowMs: number,
    g: DrainGroupView,
): Pick<DrainSummary, 'groupWith' | 'groupApart' | 'groupUnjudged'> {
    const out: Pick<DrainSummary, 'groupWith' | 'groupApart' | 'groupUnjudged'> = {
        groupWith: g.with,
    };
    let unknown = !g.withRenderMs;
    g.with!.forEach((name, i) => {
        const theirs = g.withRenderMs?.[i];
        if (theirs === undefined || theirs === null) {
            unknown = true;
            return;
        }
        const ms = nowMs - theirs;
        if (Math.abs(ms) > GROUP_SYNC_MS && Math.abs(ms) > Math.abs(out.groupApart?.ms ?? 0))
            out.groupApart = { name, ms };
    });
    if (!out.groupApart && unknown) out.groupUnjudged = true;
    return out;
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

/** `95 ms (measured), now 2.41 s · draining at 0.50 % (about 7 min) · in sync with Video Player`;
 *  out of sync (B-241): `4.50 s ahead of Video Player (held 1 s above its own target)`,
 *  `rising to Video Player's latency at 0.20 %`, `2.10 s behind Audio Decoder`. */
export function latencyTargetText(d: DrainSummary): string {
    if (d.notMeasured) return 'not measured (no display rate)';
    const parts = [`${msOrS(d.targetMs)} (measured), now ${msOrS(d.nowMs)}`];
    const pct = (Math.abs(d.ppm) / 10000).toFixed(2);
    if (d.state === 'warm-up') parts.push('measuring');
    else if (d.ppm > 0)
        parts.push(`draining at ${pct} % (${about(drainSeconds(d.nowMs - d.targetMs))})`);
    const apart = d.groupApart;
    // Behind: it plays later than the member; ahead of: earlier.
    const off =
        apart &&
        `${msOrS(Math.abs(apart.ms))} ${apart.ms > 0 ? 'behind' : 'ahead of'} ${apart.name}`;
    if (apart && apart.ms < 0 && d.ppm < 0 && !d.capped)
        parts.push(`rising to ${apart.name}'s latency at ${pct} %`);
    else if (d.capped)
        parts.push(
            off ? `${off} (held 1 s above its own target)` : 'held 1 s above its own target',
        );
    else {
        // Rising with an earlier member the furthest: that member rises to the group too.
        if (d.ppm < 0) parts.push(`rising to its group at ${pct} %`);
        if (off) parts.push(off);
    }
    if (d.neither) parts.push('in sync with neither (two programmes)');
    else if (d.groupWith?.length && !apart)
        parts.push(
            `${d.groupUnjudged ? 'grouped with' : 'in sync with'} ${d.groupWith.join(', ')}`,
        );
    return parts.join(' · ');
}

/** `2.30 s`, `340 ms`. */
export function drainedText(d: DrainSummary): string {
    return msOrS(d.drainedMs);
}

/** The reasons an underrun did not raise (B-240) in the row's words, in the row's order. */
const REASON_WORDS: readonly [string, readonly UnderrunReason[]][] = [
    ['while catching up', ['drain', 'after-drain']],
    ['while settling', ['warm-up']],
    ['after an input break', ['input']],
    ['under load', ['load']],
    ['not short of margin', ['not-margin']],
    ['on a steady stream', ['video']],
];

/** `15, 1 raised the target, 12 while catching up, 2 under load`; `3, 3 raised the target`; `0`. */
export function underrunsText(d: DrainSummary): string {
    if (!d.underruns) return '0';
    const parts = [`${d.underruns}, ${d.raises} raised the target`];
    for (const [words, reasons] of REASON_WORDS) {
        const n = reasons.reduce((a, r) => a + (d.underrunReasons?.[r] ?? 0), 0);
        if (n) parts.push(`${n} ${words}`);
    }
    return parts.join(', ');
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
