import { describe, it, expect, vi } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import { QUEUE_SHED_EVENT } from './tsHelpers.js';
import type { PipelineDescription } from './PluginModule.js';

// An ingest queue's sheds (B-182): the runner reports one event per episode, the base class writes
// one WARN line for it, for every module, and the subclass hook still sees the event.
class TestModule extends GstPluginBase {
    seen: string[] = [];
    buildPipeline(): PipelineDescription | null {
        return null;
    }
    protected onPluginEvent(channel: string): void {
        this.seen.push(channel);
    }
    deliver(channel: string, payload: unknown): void {
        (this as unknown as { dispatchPluginEvent(c: string, p: unknown): void }).dispatchPluginEvent(
            channel,
            payload,
        );
    }
}

function makeModule() {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const module = new TestModule();
    (module as unknown as { log: unknown }).log = log;
    return { module, log };
}

const episode = {
    element: 'ingestq',
    overruns: 4559,
    durationMs: 1203,
    totalOverruns: 4559,
    maxSizeBytes: 4000000,
    ongoing: false,
};

describe('GstPluginBase queue-shed logging (B-182)', () => {
    it('writes one WARN line per episode, with its count, its length and the payload', () => {
        const { module, log } = makeModule();
        module.deliver(QUEUE_SHED_EVENT, episode);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(
            { queueShed: episode },
            'Queue ingestq full: 4559 buffers dropped in 1203 ms (its output stopped draining)',
        );
        expect(module.seen).toEqual([QUEUE_SHED_EVENT]);
    });

    it('says when the episode is still open', () => {
        const { module, log } = makeModule();
        module.deliver(QUEUE_SHED_EVENT, { ...episode, ongoing: true });
        expect(log.warn.mock.calls[0][1]).toMatch(/\(its output stopped draining, still dropping\)$/);
    });

    it('survives a payload without fields, and leaves other channels alone', () => {
        const { module, log } = makeModule();
        module.deliver(QUEUE_SHED_EVENT, null);
        module.deliver('tsprobe:videoinfo', { codec: 'h265' });
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][1]).toBe(
            'Queue ? full: 0 buffers dropped in 0 ms (its output stopped draining)',
        );
    });
});
