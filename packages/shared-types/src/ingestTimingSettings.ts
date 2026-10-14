// Ingest timing settings (house-clock design §5.5, plan WI-P1-9). The engine's PluginLoader and
// the manager's PluginRegistry inject them into every manifest declaring
// `"timing": { "role": "ingest", "pidTrims": true|false }`, so their bounds are written once.

/** The ingest offset O in ms: shifts everything the ingest carries on the house timeline. */
export const INGEST_OFFSET_KEY = 'ingestOffsetMs';
/** Per-PID trims in ms on top of O, keyed by decimal PID. */
export const PID_TRIMS_KEY = 'pidTrimsMs';
/** OQ-14. */
export const INGEST_OFFSET_MAX_MS = 10_000;
/** §5.5 (Q6). */
export const PID_TRIM_MAX_MS = 2_000;

/** A manifest's `"timing"` field. */
export interface ManifestTiming {
    role: 'ingest';
    /** Network ingests trim per PID; a capture has one PID, where O does the same (OQ-15). */
    pidTrims: boolean;
}

/** The manifest's `"timing"` field when it declares an ingest, else null. */
export function parseManifestTiming(value: unknown): ManifestTiming | null {
    const timing = value as { role?: unknown; pidTrims?: unknown } | null | undefined;
    if (timing?.role !== 'ingest') return null;
    return { role: 'ingest', pidTrims: timing.pidTrims === true };
}

/** A copy of `schema` with Ingest Offset, and Per-PID Trim when `pidTrims` is set. */
export function withIngestTimingSettings(
    schema: Record<string, unknown>,
    { pidTrims }: { pidTrims: boolean },
): Record<string, unknown> {
    const properties: Record<string, unknown> = {
        ...(schema.properties as Record<string, unknown> | undefined),
        [INGEST_OFFSET_KEY]: {
            type: 'number',
            default: 0,
            minimum: -INGEST_OFFSET_MAX_MS,
            maximum: INGEST_OFFSET_MAX_MS,
            'x-unit': 'ms',
            'x-live': true,
            title: 'Ingest Offset',
            // R-P1-15: told apart from Playout Offset while both exist on development builds.
            description:
                'Moves this input on the house timeline: positive later, negative earlier. A live edit leaves a gap or drops overlap.',
        },
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
        };
    }
    return { ...schema, properties };
}
