// A module's timing summary as status sections and a face badge (ADR-0007: the plugin
// computes, the UI renders). Every row is labelled with its unit, so the operator reads a
// number, not a colour. House-clock plan WI-P0-9.
import type { ModuleBadge, ModuleTimingSummary, StatusValue } from '@media-router/shared-types';

export const TIMING_SECTION = 'timing';
export const TIMING_BADGE = 'lateness';

export interface TimingSection {
    id: string;
    label: string;
    fields: Array<{ key: string; label: string; unit?: string }>;
}

export interface TimingPublication {
    sections: TimingSection[];
    data: Record<string, Record<string, StatusValue>>;
    badge: ModuleBadge | null;
}

const ms = (v: number): number => Math.round(v);
const range = (min: number, max: number): string => `${ms(min)} – ${ms(max)}`;

type Row = [key: string, label: string, value: StatusValue, unit?: string];

function section(id: string, label: string, rows: Row[], pub: TimingPublication): void {
    pub.sections.push({
        id,
        label,
        fields: rows.map(([key, l, , unit]) =>
            unit ? { key, label: l, unit } : { key, label: l },
        ),
    });
    pub.data[id] = Object.fromEntries(rows.map(([key, , value]) => [key, value]));
}

export function timingPublication(s: ModuleTimingSummary): TimingPublication {
    const pub: TimingPublication = { sections: [], data: {}, badge: null };
    const rows: Row[] = [];
    if (!s.instrument) rows.push(['instrument', 'Lateness', 'lateness instrument missing']);
    if (s.output) {
        rows.push(['outputMs', 'Output lateness', ms(s.output.meanMs), 'ms']);
        rows.push([
            'outputRange',
            'Output lateness min – max',
            range(s.output.minMs, s.output.maxMs),
            'ms',
        ]);
    }
    const waitedOn = s.inputs.find((i) => i.label === s.slowest) ?? s.inputs[0];
    if (waitedOn?.addedMs !== undefined) {
        rows.push(['addedMs', 'Added latency', ms(waitedOn.addedMs), 'ms']);
    }
    if (s.slowest) rows.push(['slowest', 'Slowest input', s.slowest]);
    if (s.decodeMs !== undefined) rows.push(['decodeMs', 'Decode', ms(s.decodeMs), 'ms']);
    if (s.presentationDelayMs !== undefined) {
        rows.push(['presentationDelayMs', 'Presentation delay', ms(s.presentationDelayMs), 'ms']);
    }
    if (s.deviceLatencyMs !== undefined) {
        rows.push(['deviceLatencyMs', 'Device latency', ms(s.deviceLatencyMs), 'ms']);
    }
    if (s.renderMs !== undefined) rows.push(['renderMs', 'Render lateness', ms(s.renderMs), 'ms']);
    if (s.pipeWireLatencyMs !== undefined) {
        rows.push(['pipeWireLatencyMs', 'PipeWire latency', ms(s.pipeWireLatencyMs), 'ms']);
    }
    if (rows.length) section(TIMING_SECTION, 'Timing', rows, pub);

    s.inputs.forEach((input, n) => {
        const inRows: Row[] = [
            ['latenessMs', 'Lateness', ms(input.lateness.meanMs), 'ms'],
            [
                'latenessRange',
                'Lateness min – max',
                range(input.lateness.minMs, input.lateness.maxMs),
                'ms',
            ],
        ];
        if (input.addedMs !== undefined) inRows.push(['addedMs', 'Added', ms(input.addedMs), 'ms']);
        section(
            `${TIMING_SECTION}-in-${n + 1}`,
            `Input ${n + 1} timing: ${input.label}`,
            inRows,
            pub,
        );
    });

    // Grey, never coloured: Phase 0 shows the number and sets no threshold (OQ-8).
    const face = s.renderMs ?? s.output?.meanMs ?? s.pipeWireLatencyMs;
    if (face !== undefined) {
        pub.badge = { id: TIMING_BADGE, icon: 'timer', text: `${ms(face)} ms`, color: '#6b7280' };
    }
    return pub;
}

/** The displayed numbers, unrounded, for the change test. */
function values(s: ModuleTimingSummary): Map<string, number | string> {
    const v = new Map<string, number | string>([['instrument', String(s.instrument)]]);
    const put = (k: string, x: number | string | undefined): void => {
        if (x !== undefined) v.set(k, x);
    };
    put('out.mean', s.output?.meanMs);
    put('out.min', s.output?.minMs);
    put('out.max', s.output?.maxMs);
    put('slowest', s.slowest);
    put('decode', s.decodeMs);
    put('d', s.presentationDelayMs);
    put('device', s.deviceLatencyMs);
    put('render', s.renderMs);
    put('pw', s.pipeWireLatencyMs);
    for (const i of s.inputs) {
        put(`${i.tap}.label`, i.label);
        put(`${i.tap}.mean`, i.lateness.meanMs);
        put(`${i.tap}.min`, i.lateness.minMs);
        put(`${i.tap}.max`, i.lateness.maxMs);
        put(`${i.tap}.added`, i.addedMs);
    }
    return v;
}

/** True when a displayed value moved by ≥ `minMs` or a row came or went: the throttle that
 *  bounds manager traffic with many modules (R-P0-6). */
export function timingChanged(
    prev: ModuleTimingSummary | null,
    next: ModuleTimingSummary,
    minMs = 1,
): boolean {
    if (!prev) return true;
    const a = values(prev);
    const b = values(next);
    if (a.size !== b.size) return true;
    for (const [k, x] of b) {
        const y = a.get(k);
        if (y === undefined) return true;
        if (typeof x === 'number' && typeof y === 'number') {
            if (Math.abs(x - y) >= minMs) return true;
        } else if (x !== y) return true;
    }
    return false;
}
