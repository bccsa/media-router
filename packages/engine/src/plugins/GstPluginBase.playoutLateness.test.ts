import { describe, it, expect, vi } from 'vitest';

/**
 * `playout_lateness` (both runners, sink-point legs) → the 'timing' section and
 * an owned 'late' warning, wired in the BASE class because the shed probe that
 * measures it is armed on every contract audio leg. .24 (2026-10-04): a 302M
 * headphone lost 23.7 % of its audio as silence with health "ok".
 */
vi.mock('../child-process/GstChildProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../child-process/GstChildProcess.js')>()),
    GstChildProcess: (await import('./testing/FakeGstChildProcess.js')).FakeGstChildProcess,
}));

import { GstPluginBase } from './GstPluginBase.js';
import { PLAYOUT_LATENESS_EVENT, type LatenessWindow } from './playoutLateness.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';
import { FakeGstChildProcess } from './testing/FakeGstChildProcess.js';

class TestModule extends GstPluginBase {
    seen: string[] = [];
    buildPipeline(): PipelineDescription | null {
        return { pipeline: 'audiotestsrc ! pulsesink name=sink' };
    }
    protected onPluginEvent(channel: string): void {
        this.seen.push(channel);
    }
}

const win = (o: Partial<LatenessWindow> = {}): LatenessWindow => ({
    mediaMs: 10_000,
    lateMs: 0,
    maxLatenessMs: -62,
    minLatenessMs: -95,
    budgetMs: 80,
    latencyMs: 80,
    ...o,
});
const LATE = win({ lateMs: 2370, maxLatenessMs: 118.6, minLatenessMs: -70 });
const CLEAN = win();
/** What the runners send for a muted (all-GAP) leg: a window with no audio. */
const MUTED = win({ mediaMs: 0, maxLatenessMs: 0, minLatenessMs: 0 });

async function makeStarted() {
    FakeGstChildProcess.instances = [];
    const module = new TestModule();
    await module.onInit({}, { instanceId: 'hp1' } as unknown as ModuleServices);
    await module.onStart();
    const child = FakeGstChildProcess.instances[0]!;
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    (module as unknown as { log: unknown }).log = log;
    const deliver = (payload: unknown, times = 1): void => {
        for (let i = 0; i < times; i++)
            child.emit('pluginEvent', { channel: PLAYOUT_LATENESS_EVENT, payload });
    };
    return { module, child, log, deliver };
}

describe('GstPluginBase playout lateness → status + health', () => {
    it('shows every window in a dynamic timing section', async () => {
        const { module, deliver } = await makeStarted();
        deliver(LATE);
        const state = module.getState();
        expect(state.statusData?.timing).toEqual({
            latePct: 23.7,
            worstMs: 119,
            budgetMs: 80,
            latencyMs: 80,
        });
        expect(state.dynamicStatusSections?.map((s) => s.id)).toEqual(['timing']);
        expect(state.health).toBe('ok'); // one late window is not a fault
        expect(module.seen).toEqual([PLAYOUT_LATENESS_EVENT]); // the subclass hook still sees it
    });

    it('warns on the second late window, journals once, and a clean minute clears it', async () => {
        const { module, log, deliver } = await makeStarted();
        deliver(LATE, 4);
        expect(module.getState().health).toBe('warning');
        expect(module.getState().error).toContain('needs ≥ 159 ms more budget');
        expect(log.warn).toHaveBeenCalledTimes(1);
        deliver(CLEAN, 5);
        expect(module.getState().health).toBe('warning');
        deliver(CLEAN);
        expect(module.getState()).toMatchObject({ health: 'ok', error: null });
        expect(log.info).toHaveBeenCalledTimes(1);
    });

    it('never masks an error, and never clears a warning it does not own (ADR-0010 rule 2)', async () => {
        const { module, deliver } = await makeStarted();
        module.setHealth('error', 'Audio device gone');
        deliver(LATE, 3);
        expect(module.getState()).toMatchObject({ health: 'error', error: 'Audio device gone' });
        module.setHealth('warning', 'someone else');
        deliver(CLEAN, 6);
        expect(module.getState()).toMatchObject({ health: 'warning', error: 'someone else' });
    });

    it('takes the warning once health is free again', async () => {
        const { module, deliver } = await makeStarted();
        module.setHealth('warning', 'someone else');
        deliver(LATE, 2);
        expect(module.getState().error).toBe('someone else');
        module.setHealth('ok');
        deliver(LATE);
        expect(module.getState().health).toBe('warning');
        expect(module.getState().error).toContain('plays as silence');
    });

    it('a muted leg drops the section and its warning at the first window with no audio', async () => {
        // .24, 2026-10-05: Headphone1 muted while tripped kept the warning (and
        // its "last 10 s" figures) for the whole 58 s mute.
        const { module, log, deliver } = await makeStarted();
        deliver(LATE, 2);
        expect(module.getState().health).toBe('warning');
        deliver(MUTED);
        expect(module.getState()).toMatchObject({ health: 'ok', error: null });
        expect(module.getState().statusData?.timing).toBeUndefined();
        expect(module.getState().dynamicStatusSections).toEqual([]);
        expect(log.info).toHaveBeenCalledWith(
            { playoutLateness: MUTED },
            'Late audio cleared — no audio in the last 10 s (muted or no source)',
        );
        deliver(LATE); // unmuted and still starved: one window is not a fault
        expect(module.getState().health).toBe('ok');
        expect(module.getState().statusData?.timing).toMatchObject({ latePct: 23.7 });
        deliver(LATE);
        expect(module.getState().health).toBe('warning');
    });

    it('a PLAYING transition makes the new incarnation earn it again', async () => {
        const { module, child, deliver } = await makeStarted();
        deliver(LATE);
        child.emit('stateChange', { state: 'playing' });
        deliver(LATE);
        expect(module.getState().health).toBe('ok');
        deliver(LATE);
        expect(module.getState().health).toBe('warning');
    });

    it('ignores a malformed payload, and onStop drops the section', async () => {
        const { module, deliver } = await makeStarted();
        deliver({ lateMs: 5 }, 3);
        expect(module.getState().statusData?.timing).toBeUndefined();
        expect(module.getState().health).toBe('ok');
        deliver(CLEAN);
        await module.onStop();
        expect(module.getState().statusData).toEqual({});
        expect(module.getState().dynamicStatusSections).toEqual([]);
    });
});
