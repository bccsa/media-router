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
    RESTAMP_TRUST,
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
import { TRUST_BADGE } from './ingestTrust.js';
import type { TimingSection } from './timingSections.js';

export { CLOCK_BADGE, CLOCK_SECTION, PIDS_OPTIONS } from './ingestTimingView.js';
export { TRUST_BADGE, TRUST_SECTION } from './ingestTrust.js';

/** This reporter's section ids, for a module merging them with its own dynamic sections. */
export function isIngestTimingSection(id: string): boolean {
    return /^(clock(-\d+)?|trust(-\d+)?|pid-\d+)$/.test(id);
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
const WARN_EVENTS = new Set(['degraded', 'lead-clamp', 'ratio-out-of-bounds', 'trust-fallback']);

type Payload = Record<string, unknown>;

export class IngestTimingReporter {
    private readonly mode: RestampMode;
    private readonly intervalMs: number;
    private readonly channels: Map<string, (p: Payload, now: number) => void>;
    private clock = new IngestClock();
    private shown: View = EMPTY_VIEW;
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Where L comes from, for the Trust section ("SRT negotiated"); the module sets it. */
    private lSource = '';
    /** The last MPTS disagreement logged, so each change is logged once. */
    private disagreeLogged = '';

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
            [`${RESTAMP_TRUST}:${restamp}`, (p, now) => this.clock.trustReport(p, now)],
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

    /** Where the module's L comes from, as the Trust section names it: "SRT negotiated". */
    setLatencySource(source: string): void {
        this.lSource = source;
    }

    /** p5-20's drain key (WI-P5-11): the sender's timeline id, 16 hex digits, while every program
     *  is on the Trust timeline with one non-zero id; else undefined. Moves on the Trust events. */
    drainOriginKey(): string | undefined {
        return this.clock.trust.originKey();
    }

    /** From the module's start: publish every stats interval. */
    start(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
    }

    /** From the module's stop: the card goes at once, as the base clears it only once the runner
     *  is down, seconds later, and a restart showed the last run's Locked (B-117); its warning
     *  stays to the base's stop. Then forget everything. */
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        const { sections, badge, trustBadge, options } = this.shown;
        if (sections.length || badge || trustBadge || options.length) {
            this.publish({ ...EMPTY_VIEW, warnings: this.shown.warnings });
        }
        this.clock = new IngestClock();
        this.shown = EMPTY_VIEW;
        this.disagreeLogged = '';
    }

    /** The transport dropped, its runner down: No PCR at once, the last values kept (B-118). */
    down(now = Date.now()): void {
        this.clock.down();
        this.tick(now);
    }

    /** From `onPipelinePlaying`: every PLAYING sets health ok, so put the warning back. */
    reassert(): void {
        if (this.shown.warnings.length) this.host.warn(this.shown.warnings.join('; '));
    }

    tick(now = Date.now()): void {
        const staleMs = STALE_REPORTS * this.intervalMs;
        this.clock.expire(now, staleMs);
        const view = ingestView(this.clock, this.mode, now, staleMs, this.lSource);
        if (viewChanged(this.shown, view)) this.publish(view);
        const { disagree = '' } = this.clock.trust.origin();
        if (disagree !== this.disagreeLogged) {
            this.disagreeLogged = disagree;
            if (disagree) {
                this.host.log(
                    'info',
                    { trustPrograms: disagree },
                    `drain origin: programs disagree (${disagree}); grouped by module`,
                );
            }
        }
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
        if (JSON.stringify(view.trustBadge) !== JSON.stringify(prev.trustBadge)) {
            if (view.trustBadge) this.host.setBadge(TRUST_BADGE, view.trustBadge);
            else this.host.clearBadge(TRUST_BADGE);
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
