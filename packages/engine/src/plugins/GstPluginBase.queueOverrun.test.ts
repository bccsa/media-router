import { describe, it, expect, vi, afterEach } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import { QUEUE_OVERRUN_EVENT, type QueueOverrun } from './queueOverrun.js';
import type { PipelineDescription } from './PluginModule.js';

// A queue's overruns (B-170, B-182's line): the runner reports one event per episode, the base
// class writes one WARN line for it and warns `queue-full` (WI-P4-12), for every module, and the
// subclass hook still sees the event.
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
            'Queue ingestq full at 1140 ms — content lost at capacity: 4559 buffers dropped in 1203 ms',
        );
        expect(module.seen).toEqual([QUEUE_OVERRUN_EVENT]);
    });

    it('says when the episode is still open', () => {
        const { module, log } = makeModule();
        module.deliver(QUEUE_OVERRUN_EVENT, { ...episode, ongoing: true });
        expect(log.warn.mock.calls[0][1]).toMatch(/dropped in 1203 ms, still open$/);
    });

    it('survives a payload without fields, and leaves other channels alone', () => {
        const { module, log } = makeModule();
        module.deliver(QUEUE_OVERRUN_EVENT, null);
        module.deliver('tsprobe:videoinfo', { codec: 'h265' });
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][1]).toBe(
            '? holding 0 ms at capacity — the input queue loses next: 0 buffers held back in 0 ms',
        );
    });
});

afterEach(() => vi.useRealTimers());

describe('GstPluginBase queue-full warning (WI-P4-12)', () => {
    const held: QueueOverrun = {
        element: 'vp_esq',
        input: 'busin',
        leaky: 0,
        levelTimeMs: 5000,
        levelBytes: 19200,
        overruns: 6,
        ms: 900,
        totalOverruns: 6,
        ongoing: false,
    };
    const LEAKY = 'Queue ingestq full at 1140 ms — content lost at capacity';
    const HELD = 'vp_esq holding 5000 ms at capacity — the input queue loses next';

    function running() {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const { module, log } = makeModule();
        const m = module as unknown as {
            health: string;
            error?: string;
            timing: { tick(now?: number): void };
        };
        m.health = 'ok';
        const at = (s: number) => m.timing.tick(1_000_000 + s * 1000);
        return { module, m, log, at };
    }

    it('one text by leaky: content lost at a leaky queue, the input queue loses next at a held one', () => {
        const { module, m } = running();
        module.deliver(QUEUE_OVERRUN_EVENT, episode);
        expect([m.health, m.error]).toEqual(['warning', LEAKY]);
        module.deliver(QUEUE_OVERRUN_EVENT, held);
        expect(m.error).toBe(`${LEAKY}; ${HELD}`);
    });

    it('clears 30 s after the episode closed; an open one stands until it closes', () => {
        const { module, m, at } = running();
        module.deliver(QUEUE_OVERRUN_EVENT, { ...held, ongoing: true });
        at(60);
        expect(m.error).toBe(HELD);
        vi.setSystemTime(1_000_000 + 61_000);
        module.deliver(QUEUE_OVERRUN_EVENT, held);
        at(61 + 29);
        expect([m.health, m.error]).toEqual(['warning', HELD]);
        at(61 + 30);
        expect([m.health, m.error]).toEqual(['ok', undefined]);
    });

    it('warns only; a later episode of the same queue restarts its 30 s', () => {
        const { module, m, at } = running();
        module.deliver(QUEUE_OVERRUN_EVENT, episode);
        vi.setSystemTime(1_000_000 + 20_000);
        module.deliver(QUEUE_OVERRUN_EVENT, { ...episode, levelTimeMs: 1200 });
        at(45);
        expect(m.error).toBe('Queue ingestq full at 1200 ms — content lost at capacity');
        at(50);
        expect(m.health).toBe('ok');
        expect(module.seen).toEqual([QUEUE_OVERRUN_EVENT, QUEUE_OVERRUN_EVENT]);
    });
});
