import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import { BACKLOG_SHED_EVENT } from './backlogShed.js';
import type { PipelineDescription } from './PluginModule.js';

/**
 * A backlog shed drops frames (or samples) ON PURPOSE. That has to leave a
 * journal line wherever it happens, with the before/after retained latency
 * beside it — without those numbers a shed is indistinguishable from the glitch
 * it repaired, and the fleet would have no way to tell a leg that shed once
 * from one shedding every minute because its render chain cannot keep up.
 *
 * The logging lives in the BASE class because the shedder is a contract-layer
 * guard armed on every clock-paced leg, so this pins that a plugin gets it
 * without writing anything, and that a subclass hook still sees the event.
 */
class TestModule extends GstPluginBase {
    seen: Array<[string, unknown]> = [];
    buildPipeline(): PipelineDescription | null {
        return null;
    }
    protected onPluginEvent(channel: string, payload: unknown): void {
        this.seen.push([channel, payload]);
    }
    /** What GstChildProcess's `pluginEvent` handler calls. */
    deliver(channel: string, payload: unknown): void {
        (this as unknown as { dispatchPluginEvent(c: string, p: unknown): void }).dispatchPluginEvent(
            channel,
            payload,
        );
    }
    useLog(log: unknown): void {
        (this as unknown as { log: unknown }).log = log;
    }
}

function makeModule() {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const module = new TestModule();
    module.useLog(log);
    return { module, log };
}

const recovered = {
    element: 'vpdec',
    outcome: 'recovered',
    budgetMs: 300,
    retainedBeforeMs: 1350,
    retainedAfterMs: 260,
    excessBeforeMs: 1050,
    excessAfterMs: -40,
    droppedBuffers: 62,
    durationMs: 118,
    shedCount: 1,
};

beforeEach(() => vi.clearAllMocks());

describe('GstPluginBase backlog-shed logging', () => {
    it('logs a real shed at WARN with the whole payload', () => {
        const { module, log } = makeModule();
        module.deliver(BACKLOG_SHED_EVENT, recovered);
        expect(log.warn).toHaveBeenCalledWith(
            { backlogShed: recovered },
            'Backlog shed — retained latency returned to the playout budget',
        );
    });

    it('distinguishes the two outcomes that shed nothing', () => {
        const { module, log } = makeModule();
        module.deliver(BACKLOG_SHED_EVENT, { ...recovered, outcome: 'implausible' });
        expect(log.warn.mock.calls[0][1]).toContain('timeline mismatch');
        module.deliver(BACKLOG_SHED_EVENT, { ...recovered, outcome: 'awaiting_keyframe' });
        expect(log.warn.mock.calls[1][1]).toContain('holding for the next keyframe');
    });

    it('still delivers the event to the subclass hook', () => {
        // The module may want to do more with it (health, status, a rebuild);
        // logging must not consume the event.
        const { module } = makeModule();
        module.deliver(BACKLOG_SHED_EVENT, recovered);
        expect(module.seen).toEqual([[BACKLOG_SHED_EVENT, recovered]]);
    });

    it('leaves every other channel exactly as it was', () => {
        const { module, log } = makeModule();
        module.deliver('tsprobe:videoinfo', { codec: 'h265' });
        module.deliver('renderwatch:lag', { achievedFps: 1 });
        expect(log.warn).not.toHaveBeenCalled();
        expect(module.seen.map(([c]) => c)).toEqual(['tsprobe:videoinfo', 'renderwatch:lag']);
    });

    it('survives a payload with no outcome (older runner)', () => {
        const { module, log } = makeModule();
        module.deliver(BACKLOG_SHED_EVENT, null);
        expect(log.warn).toHaveBeenCalledTimes(1);
    });
});
