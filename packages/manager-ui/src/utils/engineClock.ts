import type { TimeSyncState } from '@media-router/shared-types';
import type { EngineState } from '@/stores/engines';

export type ClockLevel = 'ok' | 'warning' | 'error';

export interface ClockIndicator {
    level: ClockLevel;
    /** Short state, also the icon's aria-label. */
    label: string;
    /** Source, error, TAI−UTC and the epoch: the tooltip text. */
    detail: string;
    colorClass: string;
}

const COLOR: Record<ClockLevel, string> = {
    ok: 'text-ok',
    warning: 'text-warning',
    error: 'text-error',
};

function errorText(us: number): string {
    return us >= 1000 ? `±${(us / 1000).toFixed(1)} ms` : `±${us} µs`;
}

function levelAndLabel(t: TimeSyncState): [ClockLevel, string] {
    if (t.traceable) return ['ok', 'Time traceable'];
    if (t.waitingForSync) return ['warning', `Waiting for time sync (${t.waitRemainingS ?? 0} s)`];
    if (!t.sidecar) return ['error', 'No clock state (mr-clockstate missing)'];
    if (t.synced) return ['warning', 'Time synced, TAI offset unset — untraceable'];
    return ['error', 'Time not synchronised'];
}

/**
 * The engine's time-sync indicator (house-clock design §10.3), or null for an
 * engine that does not announce `house-clock`: older engines show nothing.
 */
export function engineClockIndicator(engine: EngineState): ClockIndicator | null {
    const t = engine.system?.timeSync;
    if (!t || !engine.features?.includes('house-clock')) return null;
    const [level, label] = levelAndLabel(t);
    const error = t.chrony ? t.chrony.estErrorUs : t.estErrorUs;
    const parts = [
        label,
        `source ${t.source}`,
        `error ${errorText(error)}`,
        `TAI−UTC ${t.taiOffsetS} s`,
    ];
    if (t.chrony) parts.push(`ref ${t.chrony.reference} (stratum ${t.chrony.stratum})`);
    parts.push(
        t.epochSeq > 0
            ? `epoch #${t.epochSeq} (${t.epochReason}) at ${t.epochLatchedAt ?? '?'}`
            : 'no epoch yet',
    );
    return { level, label, detail: parts.join(' · '), colorClass: COLOR[level] };
}
