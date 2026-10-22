// A module's timing summary as status sections and a face badge (ADR-0007: the plugin
// computes, the UI renders). Every row is labelled with its unit, so the operator reads a
// number, not a colour. House-clock plan WI-P0-9; the aligner rows WI-P2-13.
import type {
    LatenessStatsMs,
    ModuleBadge,
    ModuleTimingInput,
    ModuleTimingSummary,
    StatusValue,
} from '@media-router/shared-types';

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

/** The rows an input or output section opens with. */
const latenessRows = (l: LatenessStatsMs): Row[] => [
    ['latenessMs', 'Lateness', ms(l.meanMs), 'ms'],
    ['latenessRange', 'Lateness min – max', range(l.minMs, l.maxMs), 'ms'],
];

/** An input's rows: its tap's lateness, then what its aligner watch reports. */
function inputRows(input: ModuleTimingInput): Row[] {
    const rows = input.lateness ? latenessRows(input.lateness) : [];
    if (input.addedMs !== undefined) rows.push(['addedMs', 'Added', ms(input.addedMs), 'ms']);
    if (input.state !== undefined) rows.push(['state', 'State', input.state]);
    if (input.silenceLimitMs !== undefined) {
        rows.push(['silenceLimitMs', 'Silence limit', ms(input.silenceLimitMs), 'ms']);
    }
    if (input.absences !== undefined) rows.push(['absences', 'Absences', input.absences]);
    if (input.staleMs !== undefined) {
        rows.push(['staleMs', 'Discarded on rejoin', ms(input.staleMs), 'ms']);
    }
    return rows;
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
    const waitedOn =
        s.inputs.find((i) => i.label === s.slowest) ?? s.inputs.find((i) => i.lateness);
    if (waitedOn?.addedMs !== undefined) {
        rows.push(['addedMs', 'Added latency', ms(waitedOn.addedMs), 'ms']);
    }
    if (s.paceMs !== undefined) rows.push(['paceMs', 'Pace', ms(s.paceMs), 'ms']);
    if (s.processingLatencyMs !== undefined) {
        rows.push(['processingLatencyMs', 'Processing latency', ms(s.processingLatencyMs), 'ms']);
    }
    // Phase 0's stand-in for what the module waits for gives way to the aligners' answer.
    if (s.waitingFor !== undefined) rows.push(['waitingFor', 'Waiting for', s.waitingFor]);
    else if (s.slowest) rows.push(['slowest', 'Slowest input', s.slowest]);
    if (s.decodeMs !== undefined) rows.push(['decodeMs', 'Decode', ms(s.decodeMs), 'ms']);
    if (s.presentationDelayMs !== undefined) {
        rows.push(['presentationDelayMs', 'Presentation delay', ms(s.presentationDelayMs), 'ms']);
    }
    if (s.deviceLatencyMs !== undefined) {
        const note = s.deviceLatencyNote ? ` (${s.deviceLatencyNote})` : '';
        rows.push(['deviceLatencyMs', `Device latency${note}`, ms(s.deviceLatencyMs), 'ms']);
    }
    if (s.renderMs !== undefined) rows.push(['renderMs', 'Render lateness', ms(s.renderMs), 'ms']);
    if (s.pipeWireLatencyMs !== undefined) {
        rows.push(['pipeWireLatencyMs', 'PipeWire latency', ms(s.pipeWireLatencyMs), 'ms']);
    }
    if (rows.length) section(TIMING_SECTION, 'Timing', rows, pub);

    // Numbered by the input's fixed place, so one going dark never renumbers the rest.
    for (const input of s.inputs) {
        const label = `Input ${input.n} timing: ${input.label}`;
        section(`${TIMING_SECTION}-in-${input.n}`, label, inputRows(input), pub);
    }
    s.outputs?.forEach((output, n) => {
        const label = `Output ${n + 1} timing: ${output.port}`;
        section(`${TIMING_SECTION}-out-${n + 1}`, label, latenessRows(output.lateness), pub);
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
    put('pace', s.paceMs);
    put('waitingFor', s.waitingFor);
    put('decode', s.decodeMs);
    put('d', s.presentationDelayMs);
    put('device', s.deviceLatencyMs);
    put('device.note', s.deviceLatencyNote);
    put('render', s.renderMs);
    put('pw', s.pipeWireLatencyMs);
    put('proc', s.processingLatencyMs);
    for (const i of s.inputs) {
        put(`${i.tap}.n`, i.n);
        put(`${i.tap}.label`, i.label);
        put(`${i.tap}.mean`, i.lateness?.meanMs);
        put(`${i.tap}.min`, i.lateness?.minMs);
        put(`${i.tap}.max`, i.lateness?.maxMs);
        put(`${i.tap}.added`, i.addedMs);
        put(`${i.tap}.state`, i.state);
        put(`${i.tap}.w`, i.silenceLimitMs);
        put(`${i.tap}.absences`, i.absences); // a count: each new absence moves it by 1
        put(`${i.tap}.stale`, i.staleMs);
    }
    for (const o of s.outputs ?? []) {
        put(`${o.tap}.mean`, o.lateness.meanMs);
        put(`${o.tap}.min`, o.lateness.minMs);
        put(`${o.tap}.max`, o.lateness.maxMs);
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
