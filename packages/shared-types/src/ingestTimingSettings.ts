// Ingest timing settings (house-clock design §5.5, plan WI-P1-9). The engine's PluginLoader and
// the manager's PluginRegistry inject them into every manifest declaring
// `"timing": { "role": "ingest", "pidTrims", "pcrLock", "trust" }` (each true|false), so their
// bounds are written once.

/** The ingest offset O in ms: shifts everything the ingest carries on the house timeline. */
export const INGEST_OFFSET_KEY = 'ingestOffsetMs';
/** Per-PID trims in ms on top of O, keyed by decimal PID. */
export const PID_TRIMS_KEY = 'pidTrimsMs';
/** How long a burst-raised clock line holds before it may come down (B-95's hold), in minutes. */
export const SMOOTHING_COOLDOWN_KEY = 'smoothingCooldownMin';
/** Restamp or Trust at a network ingest (plan ch. 9 part 4.8, WI-P5-11). */
export const TIMING_MODE_KEY = 'timingMode';
/** τ: how far transit may pass L before Trust falls back, in ms (§13.1 Q12). */
export const TRUST_TOLERANCE_KEY = 'trustToleranceMs';
export const TRUST_TOLERANCE_DEFAULT_MS = 200;
export const TRUST_TOLERANCE_MAX_MS = 10_000;
/** Ch. 9 part 8: O and the trims are greyed, values kept, while Trust is selected (Q13). */
export const TRUST_DISABLES_OFFSET_REASON =
    "Trust keeps the sender's timeline. Switch Timing Mode to Restamp to set an offset.";
/** OQ-14. */
export const INGEST_OFFSET_MAX_MS = 10_000;
/** §5.5 (Q6). */
export const PID_TRIM_MAX_MS = 2_000;
/** B-95's 300 s (the owner, 2026-10-23); 0 turns smoothing off. */
export const SMOOTHING_COOLDOWN_DEFAULT_MIN = 5;
export const SMOOTHING_COOLDOWN_MAX_MIN = 60;

/** A manifest's `"timing"` field. */
export interface ManifestTiming {
    role: 'ingest';
    /** Network ingests trim per PID; a capture has one PID, where O does the same (OQ-15). */
    pidTrims: boolean;
    /** The restamp locks a clock to the stream's PCR (`clock-mode=stc`): the network ingests. A
     *  capture keeps PES − 1 h and has no clock lock to smooth. */
    pcrLock: boolean;
    /** Timing Mode and Trust Tolerance: the network ingests, whose sender may declare house time. */
    trust: boolean;
}

/** An egress declares itself a house-time writer (plan ch. 9 WI-P5-10, S34): for the manager's
 *  timing view and the sender map, never for the ingest settings. */
export interface EgressManifestTiming {
    role: 'egress';
}

/** The manifest's `"timing"` field when it declares an ingest or an egress, else null. */
export function parseManifestTiming(value: unknown): ManifestTiming | EgressManifestTiming | null {
    const timing = value as
        | { role?: unknown; pidTrims?: unknown; pcrLock?: unknown; trust?: unknown }
        | null
        | undefined;
    if (timing?.role === 'egress') return { role: 'egress' };
    if (timing?.role !== 'ingest') return null;
    return {
        role: 'ingest',
        pidTrims: timing.pidTrims === true,
        pcrLock: timing.pcrLock === true,
        trust: timing.trust === true,
    };
}

/** A copy of `schema` with Timing Mode and Trust Tolerance when `trust` is set, Ingest Offset,
 *  Per-PID Trim when `pidTrims` is set and Smoothing Cooldown when `pcrLock` is. */
export function withIngestTimingSettings(
    schema: Record<string, unknown>,
    { pidTrims, pcrLock, trust }: Pick<ManifestTiming, 'pidTrims' | 'pcrLock' | 'trust'>,
): Record<string, unknown> {
    const properties: Record<string, unknown> = {
        ...(schema.properties as Record<string, unknown> | undefined),
    };
    // Ch. 9 part 8. Greyed in Trust (WI-P5-12 renders the two keys), never removed.
    const disabled = trust
        ? {
              'x-disabledWhen': `${TIMING_MODE_KEY}=trust`,
              'x-disabledReason': TRUST_DISABLES_OFFSET_REASON,
          }
        : {};
    if (trust) {
        properties[TIMING_MODE_KEY] = {
            type: 'string',
            enum: ['restamp', 'trust'],
            'x-enumLabels': ['Restamp', 'Trust'],
            default: 'restamp',
            'x-live': true,
            title: 'Timing Mode',
            description:
                "Restamp lands the stream on arrival; Trust keeps the sender's timeline after checking it.",
        };
        properties[TRUST_TOLERANCE_KEY] = {
            type: 'number',
            minimum: 0,
            maximum: TRUST_TOLERANCE_MAX_MS,
            default: TRUST_TOLERANCE_DEFAULT_MS,
            'x-unit': 'ms',
            'x-live': true,
            'x-showWhen': `${TIMING_MODE_KEY}=trust`,
            title: 'Trust Tolerance',
            description:
                'How far transit may exceed the link latency before Trust falls back to Restamp.',
        };
    }
    properties[INGEST_OFFSET_KEY] = {
        type: 'number',
        default: 0,
        minimum: -INGEST_OFFSET_MAX_MS,
        maximum: INGEST_OFFSET_MAX_MS,
        'x-unit': 'ms',
        'x-live': true,
        title: 'Ingest Offset',
        description:
            'Moves this input on the house timeline: positive later, negative earlier. A live edit leaves a gap or drops overlap.',
        ...disabled,
    };
    if (pidTrims) {
        properties[PID_TRIMS_KEY] = {
            type: 'object',
            additionalProperties: {
                type: 'number',
                minimum: -PID_TRIM_MAX_MS,
                maximum: PID_TRIM_MAX_MS,
            },
            default: {},
            'x-widget': 'pidTrim',
            'x-optionsFrom': 'pids',
            'x-live': true,
            'x-unit': 'ms',
            title: 'Per-PID Trim',
            description:
                "Shifts one stream against the others, on top of Ingest Offset, to correct a source's fixed A/V error.",
            ...disabled,
        };
    }
    if (pcrLock) {
        properties[SMOOTHING_COOLDOWN_KEY] = {
            type: 'number',
            default: SMOOTHING_COOLDOWN_DEFAULT_MIN,
            minimum: 0,
            maximum: SMOOTHING_COOLDOWN_MAX_MIN,
            'x-unit': 'min',
            'x-live': true,
            title: 'Smoothing Cooldown',
            // The owner's text (2026-10-23): it says plainly that only a bursty stream gets latency,
            // so it runs past the popover's 120 characters (manifestHelpText.test.ts's rule). It acts
            // wherever the STC mapping runs, not in Trust itself (WI-P5-11, S6).
            description:
                "While restamping, adds latency only when this input's stream is bursty (packets arriving in bursts, as through some relays). The input then runs at its bursts' height and comes back down no sooner than this long after the last burst, instead of skipping and re-syncing after every burst. A steady stream gets no added latency. Set it longer than the time between bursts; 0 turns smoothing off.",
        };
    }
    return { ...schema, properties };
}
