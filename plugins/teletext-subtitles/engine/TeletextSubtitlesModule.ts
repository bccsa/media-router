import { GstPluginBase, type PipelineDescription } from '@media-router/engine';
import { subtitleRunnerHook } from '@media-router/plugin-subtitle-core';
import { buildPipeline } from './teletextPipeline.js';
import {
    INPUT_PORT_ID,
    buildDynamicPorts,
    outputPortId,
    pageLabel,
    readPages,
    type DynamicPort,
    type TeletextPage,
} from './teletextPorts.js';

/** How long the module waits for a first cue before flagging the source. */
const NO_CUE_WARNING_MS = 30_000;

interface CueEvent {
    label?: string;
    text?: string;
    count?: number;
}

/**
 * Teletext subtitle decoder: one MPEG-TS input carrying DVB teletext, one
 * subtitle output (KLV-wrapped WebVTT on the bus) per configured page.
 *
 * The pipeline is assembled in `teletextPipeline.ts`; the runner's subtitle
 * bridge does the per-cue work and reports every cue on the `subtitle:cue`
 * plugin-event channel, which is all this module needs for status.
 */
export class TeletextSubtitlesModule extends GstPluginBase {
    private pages: TeletextPage[] = [];
    private cueCounts = new Map<string, number>();
    private lastCue = '';
    private noCueTimer: ReturnType<typeof setTimeout> | null = null;
    private noCueWarned = false;

    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(readPages(config));
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
        const pages = readPages(config);
        if (pages.length === 0) {
            this.setHealth('warning', 'No teletext pages configured — add at least one');
            return null;
        }
        const outputs = [];
        for (let i = 0; i < pages.length; i++) {
            const portId = outputPortId(i);
            const ep = router.assignBusChannel(instanceId, portId);
            if (!ep) {
                this.setHealth('error', `Bus channel pool exhausted while allocating ${portId}`);
                return null;
            }
            outputs.push({ portId, port: ep.port, page: pages[i] });
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
        if (!result) return null;

        this.pages = pages;
        this.cueCounts = new Map(pages.map((p) => [pageLabel(p), 0]));
        this.lastCue = '';
        this.noCueWarned = false;
        this.setStatusData('input', { channel: upstream.port });
        this.publishCueStatus();
        this.setHealth('ok');
        return {
            pipeline: result.pipeline,
            restartOnError: true,
            runnerHooks: [subtitleRunnerHook({ pay: result.subtitlePay })],
        };
    }

    protected onPipelinePlaying(): void {
        this.clearNoCueTimer();
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

    private publishCueStatus(): void {
        const total = [...this.cueCounts.values()].reduce((a, b) => a + b, 0);
        this.setStatusData('cues', {
            pages: this.pages
                .map((p) => `${pageLabel(p)} (${this.cueCounts.get(pageLabel(p)) ?? 0})`)
                .join(', '),
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
