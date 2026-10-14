// IngestTimingReporter (house-clock plan WI-P1-9): the restamp's and the ASRC's element messages
// as an ingest's card (ingestTimingView.ts), published every stats interval through the module
// and only when it changed, the way Phase 0's LatenessReporter throttles.
import type { ModuleBadge, StatusValue } from '@media-router/shared-types';
import {
    ASRC_ELEMENT,
    ASRC_EVENT,
    ASRC_STATS,
    RESTAMP_ELEMENT,
    RESTAMP_EVENT,
    RESTAMP_PID,
    RESTAMP_STATS,
    type RestampMode,
} from './ingestTiming.js';
import { IngestClock, str } from './ingestTimingState.js';
import {
    CLOCK_BADGE,
    EMPTY_VIEW,
    PIDS_OPTIONS,
    ingestView,
    viewChanged,
    type View,
} from './ingestTimingView.js';
import type { TimingSection } from './timingSections.js';

export { CLOCK_BADGE, CLOCK_SECTION, PIDS_OPTIONS } from './ingestTimingView.js';

/** This reporter's section ids, for a module merging them with its own dynamic sections. */
export function isIngestTimingSection(id: string): boolean {
    return /^(clock(-\d+)?|pid-\d+)$/.test(id);
}

/** The module side, bound by the module to GstPluginBase's methods. */
export interface IngestTimingHost {
    /** This reporter's sections, replacing the ones it sent before. GstPluginBase replaces the
     *  whole list, so the module merges: its own sections stay (`isIngestTimingSection`). */
    setDynamicSections(sections: TimingSection[]): void;
    setStatusData(sectionId: string, data: Record<string, StatusValue>): void;
    setBadge(id: string, badge: Omit<ModuleBadge, 'id'>): void;
    /** Withdraw it: no program reports any more. */
    clearBadge(id: string): void;
    setFieldOptions(key: string, options: Array<{ value: string; label: string }>): void;
    /** The module's own warning: raise it, or replace its text. */
    warn(text: string): void;
    /** Withdraw it, leaving any other health text alone. */
    clearWarning(): void;
    /** The element events, as JSON lines in the module's log (part 10). */
    log(level: 'info' | 'warn', obj: Record<string, unknown>, msg: string): void;
}

export interface IngestTimingReporterOptions {
    /** The restamp's `clock-mode`: `stc` shows a network ingest's card, `fixed` a capture's. */
    mode: RestampMode;
    restamp?: string;
    asrc?: string;
    /** The elements' stats interval: the publication tick; three missed reports are stale. */
    intervalMs?: number;
}

const STALE_REPORTS = 3;
const WARN_EVENTS = new Set(['degraded', 'lead-clamp', 'ratio-out-of-bounds']);

type Payload = Record<string, unknown>;

export class IngestTimingReporter {
    private readonly mode: RestampMode;
    private readonly intervalMs: number;
    private readonly channels: Map<string, (p: Payload, now: number) => void>;
    private clock = new IngestClock();
    private shown: View = EMPTY_VIEW;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly host: IngestTimingHost,
        opts: IngestTimingReporterOptions,
    ) {
        this.mode = opts.mode;
        this.intervalMs = opts.intervalMs ?? 2000;
        const restamp = opts.restamp ?? RESTAMP_ELEMENT;
        const asrc = opts.asrc ?? ASRC_ELEMENT;
        this.channels = new Map([
            [`${RESTAMP_STATS}:${restamp}`, (p, now) => this.clock.stats(p, now)],
            [`${RESTAMP_PID}:${restamp}`, (p, now) => this.clock.pid(p, now)],
            [
                `${RESTAMP_EVENT}:${restamp}`,
                (p, now) => {
                    this.logEvent(RESTAMP_EVENT, p);
                    this.clock.event(p, now);
                },
            ],
            [`${ASRC_STATS}:${asrc}`, (p, now) => this.clock.asrcStats(p, now)],
            [`${ASRC_EVENT}:${asrc}`, (p) => this.logEvent(ASRC_EVENT, p)],
        ]);
    }

    /** The restamp's and the ASRC's plugin events; false for any other channel. */
    onEvent(channel: string, payload: unknown, now = Date.now()): boolean {
        const take = this.channels.get(channel);
        if (!take) return false;
        take((payload ?? {}) as Payload, now);
        return true;
    }

    /** From the module's start: publish every stats interval. */
    start(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
    }

    /** From the module's stop: forget everything. GstPluginBase's stop clears what was shown. */
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.clock = new IngestClock();
        this.shown = EMPTY_VIEW;
    }

    /** From `onPipelinePlaying`: every PLAYING sets health ok, so put the warning back. */
    reassert(): void {
        if (this.shown.warnings.length) this.host.warn(this.shown.warnings.join('; '));
    }

    tick(now = Date.now()): void {
        const staleMs = STALE_REPORTS * this.intervalMs;
        this.clock.expire(now, staleMs);
        const view = ingestView(this.clock, this.mode, now, staleMs);
        if (viewChanged(this.shown, view)) this.publish(view);
    }

    private logEvent(structure: string, p: Payload): void {
        const kind = str(p, 'kind');
        const reason = str(p, 'reason');
        const level = WARN_EVENTS.has(kind) ? 'warn' : 'info';
        // Nested: pino's own `pid` field would collide with the event's.
        this.host.log(
            level,
            { [structure]: p },
            `${structure} ${kind}${reason ? ` (${reason})` : ''}`,
        );
    }

    /** Sections and their data go whole: another writer of the module's dynamic sections (its
     *  stop or error handler) may have replaced them. The rest only when it changed. */
    private publish(view: View): void {
        const prev = this.shown;
        this.shown = view;
        this.host.setDynamicSections(
            view.sections.map(({ id, label, rows }) => ({
                id,
                label,
                fields: rows.map(({ key, label: l, unit }) =>
                    unit ? { key, label: l, unit } : { key, label: l },
                ),
            })),
        );
        for (const { id, rows } of view.sections) {
            this.host.setStatusData(id, Object.fromEntries(rows.map((r) => [r.key, r.value])));
        }
        if (JSON.stringify(view.badge) !== JSON.stringify(prev.badge)) {
            if (view.badge) this.host.setBadge(CLOCK_BADGE, view.badge);
            else this.host.clearBadge(CLOCK_BADGE);
        }
        if (this.mode === 'stc' && JSON.stringify(view.options) !== JSON.stringify(prev.options)) {
            this.host.setFieldOptions(PIDS_OPTIONS, view.options);
        }
        const warning = view.warnings.join('; ');
        if (warning !== prev.warnings.join('; ')) {
            if (warning) this.host.warn(warning);
            else this.host.clearWarning();
        }
    }
}
