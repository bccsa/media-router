/**
 * Rate limiter for the ducker's live gain readings.
 *
 * The envelope advances on the sidechain `level` element's messages (~15 Hz)
 * and every graph publish rebroadcasts the module's whole runtime state, so the
 * raw tick rate is far too fast a channel for status (ADR-0007: "a graph that
 * needs a faster channel than status is a signal to revisit this"). What an
 * operator actually needs to see is *that* the programme is being pulled down
 * and roughly how far — so this publishes the onset immediately, then at most
 * 4 Hz while the gain is moving, and goes quiet the moment the ducker settles
 * back to unity.
 *
 * Settling publishes `null` rather than a reading at 0 dB: a dot frozen at the
 * last key level it happened to see would be a lie about a chain that is no
 * longer ducking, and the contract prefers the dot to disappear.
 */

import { round } from './dynamicsCurve.js';

/** Which leg of the gain envelope is running. */
export type DuckPhase = 'idle' | 'attack' | 'hold' | 'release';

/**
 * One reading of the ducker's state. `DuckerEnvelope` implements it directly,
 * so the module hands its envelope straight to the throttle; what gets stored
 * and published is always a copy.
 */
export interface DuckLive {
    /** Programme gain the envelope is currently applying, dB (negative). */
    gainDb: number;
    /**
     * Key level that produced it, dB — null when the reading carried none.
     * Nothing plots it today (the envelope's x axis is time, and the ducker no
     * longer draws a key-level curve); it rides along because it is the one
     * number that explains WHY the gain moved, and the envelope is where a key
     * indicator would go if one is ever wanted.
     */
    keyDb: number | null;
    /** Which leg of the envelope produced it — it places the live dot. */
    phase: DuckPhase;
}

/** How far the gain must move before a new reading is worth a broadcast. */
const DELTA_DB = 0.5;
/** Fastest publish rate: 4 Hz. */
const MIN_INTERVAL_MS = 250;
/** Gains this close to unity count as idle — the ducker is not ducking. */
const IDLE_DB = 0.05;

export class DuckLiveThrottle {
    /** Last published gain, dB. null = nothing published (idle, or quiet). */
    private lastDb: number | null = null;
    private lastMs = -Infinity;

    constructor(private readonly publish: (live: DuckLive | null) => void) {}

    /**
     * Offer one envelope tick. Publishes the first duck of a run at once, then
     * only on a ≥0.5 dB move and never faster than 4 Hz; a tick that arrives
     * too soon is simply dropped, and the next one carries the newer value.
     */
    offer(reading: DuckLive, now = Date.now()): void {
        const idle = reading.gainDb > -IDLE_DB;
        // Idle and already quiet: the common case, and it costs nothing.
        if (idle && this.lastDb === null) return;
        const db = round(reading.gainDb, 1);
        if (!idle && this.lastDb !== null && Math.abs(db - this.lastDb) < DELTA_DB) return;
        if (now - this.lastMs < MIN_INTERVAL_MS) return;
        this.lastMs = now;
        this.lastDb = idle ? null : db;
        this.publish(
            idle
                ? null
                : {
                      gainDb: db,
                      keyDb: reading.keyDb === null ? null : round(reading.keyDb, 1),
                      phase: reading.phase,
                  },
        );
    }

    /** Forget the run — the chain stopped, nothing is being ducked. */
    reset(): void {
        this.lastDb = null;
        this.lastMs = -Infinity;
    }
}
