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

/** The episode's WARN line, in B-182's words. */
export function queueOverrunText(p: QueueOverrun): string {
    const still = p.ongoing ? ', still dropping' : '';
    return (
        `Queue ${p.element ?? '?'} full: ${p.overruns ?? 0} buffers dropped in ` +
        `${p.ms ?? 0} ms (its output stopped draining${still})`
    );
}
