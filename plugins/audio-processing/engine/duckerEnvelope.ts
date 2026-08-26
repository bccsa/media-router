/**
 * Ducker gain envelope — the native `level` → `volume` control loop, kept out
 * of LADSPA entirely (exact floor, independent attack/release/hold, no added
 * latency).
 *
 * Deliberately NOT shared with the superseded PipeWire `audio-dynamics`
 * plugin: that module is queued for deletion with the rest of the PipeWire
 * audio chain, so coupling the two would only make the delete harder.
 *
 * Parameters are read from config on every reading, so a slider move takes
 * effect without restarting the pipeline.
 */

import type { DuckLive, DuckPhase } from './duckLive.js';

export const DUCK_DEFAULTS = {
    threshold: -35,
    duckDepth: -12,
    attack: 5,
    release: 200,
    hold: 250,
} as const;

/** Gain moves smaller than this aren't worth an IPC round trip — a steady
 *  (open or fully-ducked) state costs nothing. */
const GAIN_EPSILON = 0.0005;

/** Largest envelope step a single reading may integrate. A late reading (a
 *  stalled key branch, a blocked event loop) must not slam the gain. */
const MAX_STEP_MS = 100;

export class DuckerEnvelope implements DuckLive {
    /** Current applied gain, dB (0 = unity). */
    private db = 0;
    /** Which leg of the envelope the last reading left it on. */
    private state: DuckPhase = 'idle';
    /** Last time the key was over threshold. */
    private activeMs = -Infinity;
    /** Last envelope tick. */
    private tickMs = 0;
    /** Last gain actually pushed to the element. */
    private setGain = 1;
    /** Key level from the last reading, dB. */
    private key: number | null = null;

    /**
     * Re-seed to unity. Called on every PLAYING, including a crash-restart:
     * the engine's sticky-property replay restores the last written `duckvol`,
     * which a fresh envelope (assuming unity) would never correct while the key
     * stays steady — so the caller pushes 1 to the element alongside this.
     */
    reset(now = Date.now()): void {
        this.db = 0;
        this.activeMs = -Infinity;
        this.tickMs = now;
        this.setGain = 1;
        this.key = null;
        this.state = 'idle';
    }

    /** Current envelope state — for status/badges and tests. */
    get gainDb(): number {
        return this.db;
    }

    /** Key level the last reading carried, dB — null before the first one.
     *  It is what places the live dot on the key-level → gain curve. */
    get keyDb(): number | null {
        return this.key;
    }

    /** Which leg of the envelope is running — what puts the live dot on the
     *  right segment of the time-domain graph, since that x axis is
     *  schematic and cannot be interpolated (docs/research/ducker-visualization.md). */
    get phase(): DuckPhase {
        return this.state;
    }

    /**
     * Advance the envelope by one sidechain level reading (dB per channel, the
     * `level` element's `rms`). Returns the gain to write to `duckvol`, or null
     * when it hasn't moved enough to be worth writing.
     */
    advance(rms: number[], config: Record<string, unknown>, now = Date.now()): number | null {
        if (!rms.length) return null;
        const threshold = Number(config.threshold ?? DUCK_DEFAULTS.threshold);
        const floor = Number(config.duckDepth ?? DUCK_DEFAULTS.duckDepth); // negative dB
        const attack = Math.max(1, Number(config.attack ?? DUCK_DEFAULTS.attack));
        const release = Math.max(1, Number(config.release ?? DUCK_DEFAULTS.release));
        const hold = Math.max(0, Number(config.hold ?? DUCK_DEFAULTS.hold));

        const dt = Math.min(MAX_STEP_MS, Math.max(1, now - this.tickMs));
        this.tickMs = now;

        const keyDb = Math.max(...rms);
        this.key = keyDb;
        if (keyDb > threshold) this.activeMs = now;
        const active = keyDb > threshold || now - this.activeMs < hold;
        const target = active ? floor : 0;

        if (this.db > target) {
            this.db = Math.max(target, this.db - (Math.abs(floor) / attack) * dt);
        } else if (this.db < target) {
            this.db = Math.min(target, this.db + (Math.abs(floor) / release) * dt);
        }
        // Direction of travel, not elapsed time: at the target while the key
        // is live is the hold plateau, walking back to unity is the release.
        this.state =
            target < 0 ? (this.db > target ? 'attack' : 'hold') : this.db < 0 ? 'release' : 'idle';

        const gain = 10 ** (this.db / 20);
        if (Math.abs(gain - this.setGain) <= GAIN_EPSILON) return null;
        this.setGain = gain;
        return Number(gain.toFixed(4));
    }
}
