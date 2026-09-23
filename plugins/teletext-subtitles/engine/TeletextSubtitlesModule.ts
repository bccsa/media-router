import { GstPluginBase, type PipelineDescription } from '@media-router/engine';
import { subtitleRunnerHook } from '@media-router/plugin-subtitle-core';
import {
    announcedLabel,
    announcedPages,
    pageOptions,
    sameAnnounced,
    type AnnouncedPage,
} from './teletextDescriptor.js';
import { PROBE_SINK_NAME, buildPipeline } from './teletextPipeline.js';
import {
    INPUT_PORT_ID,
    MAX_PAGES,
    buildDynamicPorts,
    outputPortId,
    pageLabel,
    readDiscoveredPages,
    resolvePages,
    type DynamicPort,
    type TeletextPage,
} from './teletextPorts.js';

/** How long the module waits for a first cue before flagging the source. */
const NO_CUE_WARNING_MS = 30_000;
/** `x-optionsFrom` key of the manifest's `detectedPages` field. */
const ANNOUNCED_OPTIONS_KEY = 'announcedPages';
const NO_PAGES_WARNING =
    'No pages selected — pick from Detected Pages once the stream is announced, or add a manual page';

interface CueEvent {
    label?: string;
    text?: string;
    count?: number;
}

interface PmtEvent {
    streams?: Array<{ streamType?: number; esInfo?: string }>;
}

/**
 * Teletext subtitle decoder: one MPEG-TS input carrying DVB teletext, one
 * subtitle output (KLV-wrapped WebVTT on the bus) per selected page.
 *
 * Pages come from two places: the list the stream ANNOUNCES (PMT teletext
 * descriptor, read off the engine's `tsprobe:pmt` event and offered as the
 * `detectedPages` pick list) and the manual `pages` array. The announced
 * list is persisted as `discoveredPages` so labels and the pick list survive
 * an engine restart; the pipeline is assembled in `teletextPipeline.ts` and
 * the runner's subtitle bridge reports every cue on `subtitle:cue`.
 */
export class TeletextSubtitlesModule extends GstPluginBase {
    private pages: TeletextPage[] = [];
    private cueCounts = new Map<string, number>();
    private lastCue = '';
    private noCueTimer: ReturnType<typeof setTimeout> | null = null;
    private noCueWarned = false;
    private sawPmt = false;
    /** Pages past the MAX_PAGES cap, not decoded. */
    private overflow = 0;

    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(resolvePages(config).slice(0, MAX_PAGES));
    }

    async onStop(): Promise<void> {
        this.clearNoCueTimer();
        await super.onStop();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;
        const upstream = router.getModuleBusSource(instanceId, INPUT_PORT_ID);
        if (!upstream) {
            this.setHealth('warning', 'No MPEG-TS source connected');
            return null;
        }
        const wanted = resolvePages(config);
        const pages = wanted.slice(0, MAX_PAGES);
        const outputs = [];
        for (const page of pages) {
            const portId = outputPortId(page.page);
            const ep = router.assignBusChannel(instanceId, portId);
            if (!ep) {
                this.setHealth('error', `Bus channel pool exhausted while allocating ${portId}`);
                return null;
            }
            outputs.push({ portId, port: ep.port, page });
        }
        const holdSeconds = Number(config.cueHoldSeconds);
        const cueHoldMs = Math.round(
            1000 * (Number.isFinite(holdSeconds) ? Math.min(30, Math.max(1, holdSeconds)) : 8),
        );
        const result = buildPipeline({
            input: { port: upstream.port, socketPath: upstream.socketPath },
            outputs,
            cueHoldMs,
        });

        this.pages = pages;
        this.overflow = wanted.length - pages.length;
        this.cueCounts = new Map(pages.map((p) => [pageLabel(p), 0]));
        this.lastCue = '';
        this.noCueWarned = false;
        this.sawPmt = false;
        this.setStatusData('input', { channel: upstream.port });
        this.publishDetected(readDiscoveredPages(config));
        this.publishCueStatus();
        if (pages.length === 0) this.setHealth('warning', NO_PAGES_WARNING);
        else this.setHealth('ok');
        return {
            pipeline: result.pipeline,
            restartOnError: true,
            tsProbe: { appsink: PROBE_SINK_NAME },
            ...(result.subtitlePay.length
                ? { runnerHooks: [subtitleRunnerHook({ pay: result.subtitlePay })] }
                : {}),
        };
    }

    protected onPipelinePlaying(): void {
        this.clearNoCueTimer();
        if (this.pages.length === 0) {
            // The base class flips health to ok on PLAYING; the probe-only
            // pipeline is healthy but useless until a page is picked.
            this.setHealth('warning', NO_PAGES_WARNING);
            return;
        }
        this.noCueTimer = setTimeout(() => {
            this.noCueTimer = null;
            if (!this.running) return;
            const total = [...this.cueCounts.values()].reduce((a, b) => a + b, 0);
            if (total === 0) {
                this.noCueWarned = true;
                this.setHealth(
                    'warning',
                    'No teletext subtitles decoded yet — check the source carries teletext and the page numbers',
                );
            }
        }, NO_CUE_WARNING_MS);
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel === 'tsprobe:pmt') {
            this.onPmt((payload ?? {}) as PmtEvent);
            return;
        }
        if (channel !== 'subtitle:cue') return;
        const ev = (payload ?? {}) as CueEvent;
        if (!ev.label) return;
        this.cueCounts.set(ev.label, (this.cueCounts.get(ev.label) ?? 0) + 1);
        if (ev.text) this.lastCue = `${ev.label}: ${ev.text.replace(/\n/g, ' / ')}`;
        if (this.noCueWarned) {
            this.noCueWarned = false;
            this.setHealth('ok');
        }
        this.publishCueStatus();
    }

    /** The whole PMT on every change: re-derive the announced page list and
     *  persist it when it differs (labels + pick list survive a restart). */
    private onPmt(ev: PmtEvent): void {
        this.sawPmt = true;
        const fresh = announcedPages(ev.streams);
        if (!sameAnnounced(readDiscoveredPages(this.config), fresh)) {
            // Persists + re-resolves dynamic ports (labels may gain a
            // language); the pipeline is NOT rebuilt — the decoded set only
            // changes when the operator picks pages.
            this.emitConfigUpdate({ discoveredPages: fresh });
        }
        this.publishDetected(fresh);
    }

    private publishDetected(pages: AnnouncedPage[]): void {
        this.setFieldOptions(ANNOUNCED_OPTIONS_KEY, pageOptions(pages));
        const list = pages.map(announcedLabel).join(', ');
        this.setStatusData('detected', {
            pages: list || (this.sawPmt ? 'none announced in the PMT' : 'waiting for the PMT'),
        });
    }

    private publishCueStatus(): void {
        const total = [...this.cueCounts.values()].reduce((a, b) => a + b, 0);
        const listed = this.pages
            .map((p) => `${pageLabel(p)} (${this.cueCounts.get(pageLabel(p)) ?? 0})`)
            .join(', ');
        const capped = this.overflow ? ` — limit ${MAX_PAGES}, ${this.overflow} not decoded` : '';
        this.setStatusData('cues', {
            pages: (listed || '—') + capped,
            total,
            last: this.lastCue || '—',
        });
    }

    private clearNoCueTimer(): void {
        if (this.noCueTimer) {
            clearTimeout(this.noCueTimer);
            this.noCueTimer = null;
        }
    }
}

export default TeletextSubtitlesModule;
