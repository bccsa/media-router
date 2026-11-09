// The runners' queue watch (B-170, B-182's shed count grown): every queue that drops at capacity
// (leaky) or holds an output's backlog (the names below) counts each buffer that meets it full;
// each episode is one `queue_overrun` event (mr-gst-runner queue_watch.cpp, its python twin).

import { OUTPUT_PREFILL_NAME } from './outputSink.js';

/** The plugin-event channel of one episode of a queue meeting its bound. */
export const QUEUE_OVERRUN_EVENT = 'queue_overrun';

/** Watched though not leaky: the Video Player's and the Audio Decoder's ES queues, the audio
 *  outputs' prefill. Both runners carry the same list (busRunnerContract.test.ts). */
export const WATCHED_QUEUE_NAMES: readonly string[] = ['vp_esq', 'ad_esq', OUTPUT_PREFILL_NAME];

/** The `queue_overrun` payload. An episode ends after 1 s without an overrun; one still open at
 *  10 s is reported once with `ongoing`, then again at its end, at a stop or at its removal. */
export interface QueueOverrun {
    /** The queue's name. */
    element?: string;
    /** The first `unixfdsrc` upstream of it (the bus input it serves); null: none. */
    input?: string | null;
    /** 0: not leaky (it holds its upstream), 1: drops the newest, 2: drops the oldest. */
    leaky?: number;
    /** Its level when it met its bound, read at most once a second. */
    levelTimeMs?: number;
    levelBytes?: number;
    /** The buffers that met it full in this episode, and in its life so far. */
    overruns?: number;
    totalOverruns?: number;
    /** The episode's length so far, first to last overrun. */
    ms?: number;
    ongoing?: boolean;
}

/** A full queue's warning stands this long after its episode closed (WI-P4-12). */
export const QUEUE_FULL_CLEAR_MS = 30_000;

/** The warning by `leaky` (S15): a leaky queue loses content at its bound; a full non-leaky one
 *  loses nothing itself, it holds its upstream, so the leaky input queue before it loses next.
 *  `input`: the bus input it serves, by its label; none: the queue's own name. */
export function queueFullText(p: QueueOverrun, input?: string): string {
    const ms = p.levelTimeMs ?? 0;
    const name = p.element ?? '?';
    return p.leaky
        ? `Queue ${input ?? name} full at ${ms} ms — content lost at capacity`
        : `${name} holding ${ms} ms at capacity — the input queue loses next`;
}

/** The episode's WARN line: the warning's text (B-182's line folded into the leaky one), then
 *  its counts. */
export function queueOverrunText(p: QueueOverrun, input?: string): string {
    const still = p.ongoing ? ', still open' : '';
    const met = p.leaky ? 'dropped' : 'held back';
    return `${queueFullText(p, input)}: ${p.overruns ?? 0} buffers ${met} in ${p.ms ?? 0} ms${still}`;
}

/** The `queue-full` warning: each queue's last episode, while open and for QUEUE_FULL_CLEAR_MS
 *  after it closed. It warns; nothing drops. */
export class QueueFullWatch {
    private readonly episodes = new Map<string, { p: QueueOverrun; at: number }>();

    take(payload: unknown, now: number): void {
        const p = (payload ?? {}) as QueueOverrun;
        this.episodes.set(p.element ?? '?', { p, at: now });
    }

    /** The standing episodes, in queue-name order; empty once each closed 30 s ago. */
    standing(now: number): QueueOverrun[] {
        for (const [name, e] of this.episodes) {
            if (!e.p.ongoing && now - e.at >= QUEUE_FULL_CLEAR_MS) this.episodes.delete(name);
        }
        return [...this.episodes.keys()].sort().map((k) => this.episodes.get(k)!.p);
    }

    clear(): void {
        this.episodes.clear();
    }
}
