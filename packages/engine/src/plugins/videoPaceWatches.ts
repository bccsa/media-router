// The video outputs' `mrvideopace` messages (house-clock WI-P4-12): the presented frame's
// lateness, the rate match and its drops, late releases, the pace's hold, and whether the
// display presents at all (S31). They warn; nothing drops. And the drain back to the latency
// target (WI-P4-18): its fields and its drops per minute.
import type { RateMatch } from '@media-router/shared-types';
import { drainFieldsOf, type DrainFields } from './asrcWatches.js';

/** The structure name; the runners forward it as `mrvideopace:<element>`. */
export const VIDEO_PACE_EVENT = 'mrvideopace';

/** The display stopped presenting (0008's `not-presented` or `present-timeouts` rising). */
export const DISPLAY_NOT_PRESENTING_TEXT = 'Display not presenting (output off?)';

/** Counter rates are read over this much of the latest reports. */
const RATE_WINDOW_MS = 60_000;
const NS_PER_MS = 1_000_000;

type Payload = Record<string, unknown>;
const num = (p: Payload, k: string): number => {
    const v = Number(p[k]);
    return Number.isFinite(v) ? v : 0;
};

/** One pace on display. */
export interface VideoPaceWatch {
    name: string;
    /** The presented (or kept) frame's lateness; absent before the first release. */
    presentLatenessMs?: number;
    rateMatch: RateMatch;
    lateReleasesPerMin: number;
    meanHoldMs: number;
    presenting: boolean;
    /** The drain (B-179), and the frames it skipped per minute. */
    drain?: DrainFields;
    drainDropsPerMin?: number;
    /** No display rate known: nothing drains. */
    rateKnown: boolean;
    /** Changes at every gap the pace collapsed, a display outage and a new element. */
    gapMark: string;
}

interface Sample {
    at: number;
    late: number;
    drops: number;
    drainDrops: number;
}

interface Entry {
    at: number;
    p: Payload;
    samples: Sample[];
    /** New elements under this name (a runner respawn): each restarts the counts. */
    generation: number;
}

/** Per minute over the samples kept: the newest against the oldest; 0 over no span. */
function perMin(samples: Sample[], k: 'late' | 'drops' | 'drainDrops'): number {
    const a = samples[0];
    const b = samples[samples.length - 1];
    const span = b.at - a.at;
    return span > 0 ? ((b[k] - a[k]) * 60_000) / span : 0;
}

function displayRate(p: Payload): Pick<RateMatch, 'displayHz' | 'displaySource'> {
    const achieved = num(p, 'achieved-ns');
    if (achieved > 0) return { displayHz: 1e9 / achieved, displaySource: 'achieved' };
    const refresh = num(p, 'refresh-ns');
    const source = p['refresh-source'];
    if (refresh > 0 && (source === 'measured' || source === 'nominal')) {
        return { displayHz: 1e9 / refresh, displaySource: source };
    }
    return { displayHz: 0, displaySource: 'none' };
}

export class VideoPaceWatches {
    private readonly entries = new Map<string, Entry>();

    /** One `mrvideopace` message from element `name`: whether its display warning changed. */
    take(name: string, payload: unknown, now: number): { changed: boolean } {
        const p = (payload ?? {}) as Payload;
        const old = this.entries.get(name);
        const released = num(p, 'released');
        const again = !!old && released < num(old.p, 'released');
        const sample: Sample = {
            at: now,
            late: num(p, 'late'),
            drops: num(p, 'rate-drops') + num(p, 'display-behind'),
            drainDrops: num(p, 'drain-drops'),
        };
        const kept = old && !again ? old.samples.filter((s) => now - s.at <= RATE_WINDOW_MS) : [];
        const generation = (old?.generation ?? 0) + (again ? 1 : 0);
        this.entries.set(name, { at: now, p, samples: [...kept, sample], generation });
        const was = old ? old.p['display-presenting'] !== false : true;
        return { changed: was !== (p['display-presenting'] !== false) };
    }

    /** Forget paces that stopped reporting (pipeline gone). */
    expire(now: number, staleMs: number): void {
        for (const [name, e] of this.entries) if (now - e.at > staleMs) this.entries.delete(name);
    }

    list(): VideoPaceWatch[] {
        return [...this.entries].map(([name, e]) => {
            const { p } = e;
            const presenting = p['display-presenting'] !== false;
            const w: VideoPaceWatch = {
                name,
                rateMatch: {
                    contentFps: num(p, 'content-fps-x100') / 100,
                    ...displayRate(p),
                    dropsPerMin: perMin(e.samples, 'drops'),
                },
                lateReleasesPerMin: perMin(e.samples, 'late'),
                meanHoldMs: num(p, 'mean-hold-ns') / NS_PER_MS,
                presenting,
                rateKnown: p['drain-rate-known'] !== false,
                gapMark: `${e.generation}/${num(p, 'gaps-collapsed')}/${presenting}`,
            };
            const drain = drainFieldsOf(p);
            if (drain) {
                w.drain = drain;
                w.drainDropsPerMin = perMin(e.samples, 'drainDrops');
            }
            if (num(p, 'released') > 0) {
                w.presentLatenessMs = num(p, 'present-lateness-ns') / NS_PER_MS;
            }
            return w;
        });
    }

    clear(): void {
        this.entries.clear();
    }
}

/** `50.00 fps → 50.00 Hz measured, 0 drops/min`; with the drain's (B-179) `, 15 drain drops/min`. */
export function rateMatchText(r: RateMatch, drainDropsPerMin?: number): string {
    const fps = r.contentFps > 0 ? `${r.contentFps.toFixed(2)} fps` : 'content rate unknown';
    const hz =
        r.displayHz > 0
            ? `${r.displayHz.toFixed(2)} Hz ${r.displaySource}`
            : 'display rate unknown';
    const drain =
        drainDropsPerMin === undefined ? '' : `, ${Math.round(drainDropsPerMin)} drain drops/min`;
    return `${fps} → ${hz}, ${Math.round(r.dropsPerMin)} drops/min${drain}`;
}
