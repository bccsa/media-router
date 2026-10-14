// Test fixtures for the ingest timing card: the element messages of plan ch. 5 part 10 as the
// runners forward them, and a host that keeps what a module's card would show.
import type { RestampMode } from '../ingestTiming.js';
import { IngestTimingReporter, type IngestTimingHost } from '../ingestTimingReporter.js';
import type { TimingSection } from '../timingSections.js';

export const MS = 1_000_000;

export const CH = {
    stats: 'mrtsrestamp-stats:restamp',
    pid: 'mrtsrestamp-pid:restamp',
    event: 'mrtsrestamp-event:restamp',
    asrc: 'mrasrc-stats:asrc',
    asrcEvent: 'mrasrc-event:asrc',
};

type Fields = Record<string, unknown>;

/** Every `mrtsrestamp-stats` field of part 10, plus `cadence-warning`, `cc-lost` and
 *  `desync-bytes` that the reporter reads too. */
export const stats = (o: Fields = {}) => ({
    program: 1,
    state: 'locked',
    reason: 'none',
    ppb: 1234,
    'offset-drift-ns': 0,
    'residual-min-ns': 0,
    'residual-p50-ns': 2 * MS,
    'residual-p99-ns': 4.2 * MS,
    'residual-max-ns': 6 * MS,
    'pcr-interval-max-ns': 40 * MS,
    relocks: 0,
    gaps: 0,
    'gap-ns-total': 0,
    'dropped-pes': 0,
    'dropped-ns-total': 0,
    'cadence-warning': false,
    'cc-lost': 0,
    'desync-bytes': 0,
    ...o,
});

export const pidMsg = (pid: number, type: number, lead: number[], o: Fields = {}) => ({
    program: 1,
    pid,
    'stream-type': type,
    'lead-min-ns': lead[0] * MS,
    'lead-median-ns': lead[1] * MS,
    'lead-max-ns': lead[2] * MS,
    'trim-ns': 0,
    'shift-ns': 0,
    'dropped-pes': 0,
    ...o,
});

export const event = (kind: string, o: Fields = {}) => ({
    kind,
    program: 1,
    pid: -1,
    reason: '',
    'gap-ns': 0,
    'dropped-ns': 0,
    'house-ns': 0,
    epoch: 1,
    ...o,
});

/** `mrasrc-stats` (WI-P1-8). */
export const asrcStats = (o: Fields = {}) => ({
    state: 'locked',
    'ratio-ppb': 0,
    'phase-err-ns': 0,
    relocks: 0,
    'in-frames': 0,
    'out-frames': 0,
    'discont-in': 0,
    ...o,
});

/** What the module's card shows after the host calls, and how often it emitted state. */
export interface Card {
    sections: TimingSection[];
    data: Record<string, Record<string, unknown>>;
    badges: Record<string, unknown>;
    options: Record<string, unknown>;
    warning: string | null;
    warns: number;
    clears: number;
    emits: number;
    logs: Array<[level: string, obj: Record<string, unknown>, msg: string]>;
}

export function fakeHost(): { host: IngestTimingHost; card: Card } {
    const card: Card = {
        sections: [],
        data: {},
        badges: {},
        options: {},
        warning: null,
        warns: 0,
        clears: 0,
        emits: 0,
        logs: [],
    };
    const host: IngestTimingHost = {
        setDynamicSections: (s) => void ((card.sections = s), card.emits++),
        setStatusData: (id, d) => void ((card.data[id] = d), card.emits++),
        setBadge: (id, b) => void ((card.badges[id] = b), card.emits++),
        clearBadge: (id) => void (delete card.badges[id], card.emits++),
        setFieldOptions: (k, o) => void ((card.options[k] = o), card.emits++),
        warn: (t) => void ((card.warning = t), card.warns++, card.emits++),
        clearWarning: () => void ((card.warning = null), card.clears++, card.emits++),
        log: (level, obj, msg) => void card.logs.push([level, obj, msg]),
    };
    return { host, card };
}

export function setup(mode: RestampMode = 'stc') {
    const { host, card } = fakeHost();
    return { rep: new IngestTimingReporter(host, { mode }), card };
}
