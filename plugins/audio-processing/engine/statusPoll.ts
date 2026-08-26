/**
 * Chain meter + latency poll — what the module publishes into the status
 * popup once a second. Pure apart from the injected property reader, so the
 * whole thing is testable without a running pipeline.
 *
 * LSP's global meters are gain FACTORS (linear), not dB, and they are named
 * differently per element family. Verified with `gst-inspect-1.0` on
 * lsp-plugins-ladspa 1.2.5:
 *   - `para-equalizer-x16-stereo` → `input-signal-meter-{left,right}`,
 *     `output-signal-meter-{left,right}`
 *   - `compressor` / `gate` / `expander` / `sc-gate` / `limiter` (stereo) →
 *     `input-level-meter-{left,right}`, `output-level-meter-{left,right}`
 * Re-check on any lsp-plugins version bump: a renamed meter reads back
 * undefined and shows as '—' rather than failing loudly.
 */

import type { ChainStages } from './lspProcessing.js';

/** Reads one property off a named element in the running pipeline. */
export type ReadProperty = (element: string, prop: string) => Promise<unknown>;

/** Element name → the infix LSP uses in that element's meter port names. */
const METER_INFIX: Record<string, string> = { eq: 'signal', dyn: 'level', lim: 'level' };

/** LSP reports `latency` in SAMPLES (measured on lsp-plugins 1.2.5: limiter
 *  lookahead 5 ms → 240, 20 ms → 960) and the whole chain is pinned to
 *  48 kHz, so samples / 48 = ms. */
const SAMPLES_PER_MS = 48;

const toDb = (v: unknown): number | null =>
    typeof v === 'number' && v > 0 ? 20 * Math.log10(v) : null;

const fmtDb = (db: number | null): string => (db === null ? '—' : `${db.toFixed(1)} dB`);

/** Stereo pair as one field: `-12.3 / -12.1 dB`, left first. A dead channel is
 *  visible as '—' on its side rather than hidden behind a max(). */
const fmtPair = (left: number | null, right: number | null): string =>
    left === null && right === null
        ? '—'
        : `${left === null ? '—' : left.toFixed(1)} / ${right === null ? '—' : right.toFixed(1)} dB`;

export interface ChainMeters {
    /** Ready for `setStatusData('meters', …)`. */
    status: Record<string, string>;
    /** Gain reduction in dB (negative), or null when nothing reports it. */
    grDb: number | null;
    /** Chain input level in dB (louder channel), or null when nothing reports
     *  it. Numeric, unlike `status.inputLevel` — it drives the transfer
     *  curve's live operating point. */
    inDb: number | null;
}

/** The LADSPA elements present, in chain order. */
function presentElements(stages: ChainStages): string[] {
    return [
        stages.eqElement ? 'eq' : null,
        stages.dynElement ? 'dyn' : null,
        stages.limiterElement ? 'lim' : null,
    ].filter((n): n is string => n !== null);
}

/** True when there is at least one LADSPA element worth polling — the ducker's
 *  own reduction is already visible on the VU meter. */
export function hasPollableStages(stages: ChainStages): boolean {
    return presentElements(stages).length > 0;
}

export interface MeterPollHooks {
    read: ReadProperty;
    publish: (status: Record<string, string>, levels: ChainMeters) => void;
    /** Gain-reduction badge, or null to clear it. */
    badge: (badge: { icon: string; text: string; color: string } | null) => void;
}

/** Meter poll timer + the gain-reduction badge it drives (1 Hz). Started only
 *  when a LADSPA stage exists to read; a stop is always safe. */
export class MeterPoll {
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastGrDb = 0;

    constructor(private readonly hooks: MeterPollHooks) {}

    start(stages: ChainStages): void {
        this.stop();
        if (!hasPollableStages(stages)) return;
        this.lastGrDb = 0;
        this.timer = setInterval(() => void this.tick(stages), 1000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async tick(stages: ChainStages): Promise<void> {
        const meters = await readChainMeters(stages, this.hooks.read);
        const { status, grDb } = meters;
        this.hooks.publish(status, meters);
        if (grDb !== null && grDb < -1) {
            if (Math.abs(grDb - this.lastGrDb) >= 0.5) this.lastGrDb = grDb;
            this.hooks.badge({ icon: 'activity', text: `${grDb.toFixed(0)} dB`, color: '#f59e0b' });
        } else {
            this.lastGrDb = 0;
            this.hooks.badge(null);
        }
    }
}

async function readPair(
    read: ReadProperty,
    element: string,
    side: 'input' | 'output',
): Promise<[number | null, number | null]> {
    const base = `${side}-${METER_INFIX[element]}-meter`;
    return [toDb(await read(element, `${base}-left`)), toDb(await read(element, `${base}-right`))];
}

/**
 * Poll the chain's reported latency and its meters. Input is read off the
 * FIRST stage in the chain and output off the LAST, so the pair brackets
 * whatever processing is actually enabled instead of one fixed element.
 */
export async function readChainMeters(
    stages: ChainStages,
    read: ReadProperty,
): Promise<ChainMeters> {
    const present = presentElements(stages);
    const status: Record<string, string> = {};

    // Filter slopes/modes and the limiter's lookahead add samples, and the
    // operator has no other way to see it.
    let inDb: number | null = null;
    let latency = 0;
    for (const name of present) {
        const v = await read(name, 'latency');
        if (typeof v === 'number') latency += v;
    }
    status.latency = `${(latency / SAMPLES_PER_MS).toFixed(1)} ms`;

    if (present.length > 0) {
        const [inL, inR] = await readPair(read, present[0], 'input');
        const [outL, outR] = await readPair(read, present[present.length - 1], 'output');
        status.inputLevel = fmtPair(inL, inR);
        inDb = inL === null ? inR : inR === null ? inL : Math.max(inL, inR);
        status.outputLevel = fmtPair(outL, outR);
    }

    let grDb: number | null = null;
    if (stages.dynElement) {
        grDb = toDb(await read('dyn', 'reduction-level-meter'));
        status.keyLevel = fmtDb(toDb(await read('dyn', 'sidechain-level-meter')));
    } else if (stages.limiterElement) {
        grDb = toDb(await read('lim', 'gain-reduction-level-meter-left'));
    }
    status.gainReduction = fmtDb(grDb);

    return { status, grDb, inDb };
}
