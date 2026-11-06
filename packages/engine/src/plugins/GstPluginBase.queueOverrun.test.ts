import { describe, it, expect, vi } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import { QUEUE_OVERRUN_EVENT, type QueueOverrun } from './queueOverrun.js';
import type { PipelineDescription } from './PluginModule.js';

// A queue's overruns (B-170, B-182's line): the runner reports one event per episode, the base
// class writes one WARN line for it, for every module, and the subclass hook still sees the event.
class TestModule extends GstPluginBase {
    seen: string[] = [];
    buildPipeline(): PipelineDescription | null {
        return null;
    }
    protected onPluginEvent(channel: string): void {
        this.seen.push(channel);
    }
    deliver(channel: string, payload: unknown): void {
        (
            this as unknown as { dispatchPluginEvent(c: string, p: unknown): void }
        ).dispatchPluginEvent(channel, payload);
    }
}

function makeModule() {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const module = new TestModule();
    (module as unknown as { log: unknown }).log = log;
    return { module, log };
}

const episode: QueueOverrun = {
    element: 'ingestq',
    input: null,
    leaky: 2,
    levelTimeMs: 1140,
    levelBytes: 3998720,
    overruns: 4559,
    ms: 1203,
    totalOverruns: 4559,
    ongoing: false,
};

describe('GstPluginBase queue-overrun logging (B-170)', () => {
    it('writes one WARN line per episode, with its count, its length and the payload', () => {
        const { module, log } = makeModule();
        module.deliver(QUEUE_OVERRUN_EVENT, episode);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(
            { queueOverrun: episode },
            'Queue ingestq full: 4559 buffers dropped in 1203 ms (its output stopped draining)',
        );
        expect(module.seen).toEqual([QUEUE_OVERRUN_EVENT]);
    });

    it('says when the episode is still open', () => {
        const { module, log } = makeModule();
        module.deliver(QUEUE_OVERRUN_EVENT, { ...episode, ongoing: true });
        expect(log.warn.mock.calls[0][1]).toMatch(
            /\(its output stopped draining, still dropping\)$/,
        );
    });

    it('survives a payload without fields, and leaves other channels alone', () => {
        const { module, log } = makeModule();
        module.deliver(QUEUE_OVERRUN_EVENT, null);
        module.deliver('tsprobe:videoinfo', { codec: 'h265' });
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][1]).toBe(
            'Queue ? full: 0 buffers dropped in 0 ms (its output stopped draining)',
        );
    });
});
