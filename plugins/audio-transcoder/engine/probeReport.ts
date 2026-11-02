/**
 * What the transcoder's probes found, logged once per change (B-201): a warning per miss every
 * 10 s from idle transcoders pushed real errors out of the engine's 1000-line log in minutes.
 */

import type { ProbeResult } from '@media-router/engine';
import { FALLBACK_DECODER_WARNING, REPROBE_INTERVAL_MS } from './reprobeLoop.js';

/** What one probe found: no audio caps, audio caps no classifier knows, or a codec. */
type Outcome = 'none' | 'unrecognised' | 'codec';

function outcomeOf(result: ProbeResult): Outcome {
    if (result.codec !== 'unknown') return 'codec';
    return result.rawCaps ? 'unrecognised' : 'none';
}

/** The fallback build's status: no audio at all reads as no source, named by its producer. */
export function degradedText(result: ProbeResult | null, producer: string): string {
    if (result && outcomeOf(result) === 'unrecognised') return FALLBACK_DECODER_WARNING;
    return `No source — waiting for audio from ${producer} (checked every ${REPROBE_INTERVAL_MS / 1000} s)`;
}

/** The wired input a probe read (an entry of `MediaRouter.getModuleBusSources`). */
export interface ProbedSource {
    sourceModuleId: string;
    port: number;
    socketPath?: string;
}

interface ReportLog {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
}

export interface ProbeReportHooks {
    /** The module's logger, read at each report (`onInit` replaces it). */
    log: () => ReportLog;
    /** A module's display name (its id when it has none). */
    name: (moduleId: string) => string;
    /** This module's id. */
    self: () => string;
}

/** One module's probe results. Kept across its own restarts, so the self-heal cycle's probe
 *  of a source just identified logs nothing more. */
export class ProbeReport {
    private last: { producer: string; outcome: Outcome; codec: string } | null = null;

    constructor(private readonly hooks: ProbeReportHooks) {}

    /** Log `result` if it differs from the last one reported; otherwise nothing. */
    note(result: ProbeResult, source: ProbedSource): void {
        const outcome = outcomeOf(result);
        const producer = source.sourceModuleId;
        const prev = this.last;
        if (
            prev?.producer === producer &&
            prev.outcome === outcome &&
            prev.codec === result.codec
        ) {
            return;
        }
        this.last = { producer, outcome, codec: result.codec };
        const self = this.hooks.name(this.hooks.self());
        const from = this.hooks.name(producer);
        const fields = { source: producer, port: source.port, socket: source.socketPath };
        const log = this.hooks.log();
        if (outcome === 'codec') {
            const n = result.channels;
            const channels = n ? `, ${n} channel${n === 1 ? '' : 's'}` : '';
            log.info(
                {
                    ...fields,
                    codec: result.codec,
                    channels: n,
                    rawCaps: result.rawCaps || undefined,
                },
                `${self}: audio from ${from} is ${result.codec}${channels}`,
            );
        } else if (outcome === 'unrecognised') {
            log.warn(
                { ...fields, rawCaps: result.rawCaps },
                `${self}: audio from ${from} has a codec the probe does not know — using the generic decoder`,
            );
        } else if (prev?.producer === producer) {
            // Audio from this producer was seen before: a loss, not a wait.
            log.warn(fields, `${self}: no audio from ${from} any more — waiting for it`);
        } else {
            log.info(fields, `${self}: no audio from ${from} yet — waiting for it`);
        }
    }
}
