import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Never drop on lateness (ADR-0005 amendment 2026-10-08), the module ends. The
 * LEG turns a runner `playout_reanchor` into a request to the engine and shows
 * what it asked; the HEAD shows the raise it carries (section, badge, warning).
 * Both live in the base class, so every leg and head gets them free. Pinned:
 * the request, the exact texts, ADR-0010 rule 2 (taken only over `ok` or our
 * own text), the PLAYING re-assert, and that `null` clears all three.
 */
// `vi.hoisted` runs before the imports, so the fake carries its own emitter.
const h = vi.hoisted(() => {
    class FakeChildProcess {
        static instances: FakeChildProcess[] = [];
        isRunning = false;
        private readonly handlers = new Map<string, Array<(data: unknown) => void>>();
        constructor() {
            FakeChildProcess.instances.push(this);
        }
        on(event: string, fn: (data: unknown) => void): this {
            const list = this.handlers.get(event) ?? [];
            list.push(fn);
            this.handlers.set(event, list);
            return this;
        }
        emit(event: string, data?: unknown): void {
            for (const fn of this.handlers.get(event) ?? []) fn(data);
        }
        async start(): Promise<void> {
            this.isRunning = true;
        }
        async stop(): Promise<void> {
            this.isRunning = false;
        }
        async destroy(): Promise<void> {
            this.isRunning = false;
        }
        async updatePipelineDesc(): Promise<void> {}
    }
    return { FakeChildProcess };
});

vi.mock('../child-process/GstChildProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../child-process/GstChildProcess.js')>()),
    GstChildProcess: h.FakeChildProcess,
}));

import { GstPluginBase } from './GstPluginBase.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';
import { PLAYOUT_REANCHOR_EVENT, type PlayoutRaise } from './playoutReanchor.js';
import {
    ceilingWarning,
    raiseWarningHead,
    rebaseWarningHead,
    rebaseWarningLeg,
} from './playoutReanchorText.js';

class TestModule extends GstPluginBase {
    buildPipeline(): PipelineDescription | null {
        return { pipeline: 'fakesrc ! fakesink' };
    }
    /** What GstChildProcess's `pluginEvent` handler calls. */
    deliver(channel: string, payload: unknown): void {
        (
            this as unknown as { dispatchPluginEvent(c: string, p: unknown): void }
        ).dispatchPluginEvent(channel, payload);
    }
}

const RAISE = {
    kind: 'raise',
    element: 'vdec',
    excessMs: 112.4,
    worstMs: 171,
    cause: 'timeline',
    queuedMs: 0,
    budgetMs: 300,
    tsOffsetMs: 300,
    latencyMs: 0,
    holdMs: 15000,
};
const REBASE = {
    kind: 'rebase',
    element: 'vdec',
    latenessMs: 21340.2,
    appliedOffsetNs: 21340200000,
    padOffsetNs: 21340200000,
    flushed: false,
    sanityMs: 10000,
    budgetMs: 300,
    count: 1,
};

/** The engine's MediaRouter, as far as a module sees it: one route, head D 300. */
function makeRouter(outcome: 'raised' | 'covered' | 'ceiling' | 'off' = 'raised') {
    const state = { raiseMs: 0 };
    return {
        state,
        getRoutePlayoutHead: vi.fn(() => ({
            headId: 'srt-1',
            label: 'srt-input-1',
            declaredMs: 300,
        })),
        getRoutePlayoutOffsetMs: vi.fn(() => 300),
        getRoutePlayoutRaiseMs: vi.fn(() => state.raiseMs),
        requestPlayoutRaise: vi.fn(async () => {
            if (outcome === 'raised') state.raiseMs = 180;
            if (outcome === 'ceiling') state.raiseMs = 2000;
            return outcome;
        }),
        notePlayoutRebase: vi.fn(),
        onProducerPlaying: vi.fn(),
    };
}

async function makeStarted(id: string, router = makeRouter()) {
    h.FakeChildProcess.instances = [];
    const module = new TestModule();
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await module.onInit({}, {
        instanceId: id,
        timeSyncContract: true,
        playoutOffsetMs: 60,
        mediaRouter: router,
    } as unknown as ModuleServices);
    (module as unknown as { log: unknown }).log = log;
    await module.onStart();
    const child = h.FakeChildProcess.instances[0]!;
    child.emit('stateChange', { state: 'playing' });
    return { module, child, router, log };
}

/** Let the leg's async request settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const headRaise = (over: Partial<PlayoutRaise> = {}): PlayoutRaise => ({
    headId: 'srt-1',
    baseMs: 300,
    raiseMs: 180,
    since: Date.UTC(2026, 9, 8, 12, 0, 0),
    lastRaiseAt: Date.UTC(2026, 9, 8, 12, 0, 0),
    requests: 1,
    lastBy: {
        moduleId: 'vp-1',
        label: 'video-player-1',
        element: 'vdec',
        cause: 'timeline',
        excessMs: 112,
        queuedMs: 0,
        holdMs: 15000,
    },
    atCeiling: false,
    ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('GstPluginBase — the leg asks', () => {
    it('turns the runner event into a request for ITS route, and says what it asked', async () => {
        const { module, router, log } = await makeStarted('vp-1');
        module.deliver(PLAYOUT_REANCHOR_EVENT, RAISE);
        await settle();
        expect(router.requestPlayoutRaise).toHaveBeenCalledWith('vp-1', undefined, RAISE);
        const state = module.getState();
        expect(state.health).toBe('warning');
        expect(state.error).toBe(
            'Arrived 112 ms past the playout budget for 15 s — asked route head srt-input-1 ' +
                'to raise the playout offset 300 → 480 ms; nothing dropped.',
        );
        expect(state.dynamicStatusSections.map((s) => s.id)).toEqual(['playout']);
        expect(state.statusData.playout).toEqual({
            budget: 300,
            lateBy: 112,
            cause: 'hop transit or late timeline',
            head: 'srt-input-1',
            raisedTo: 480,
        });
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'raised', raisedToMs: 480 }),
            expect.stringContaining('nothing dropped'),
        );
    });

    it('at the ceiling it shows the ceiling text', async () => {
        const { module } = await makeStarted('vp-1', makeRouter('ceiling'));
        module.deliver(PLAYOUT_REANCHOR_EVENT, RAISE);
        await settle();
        expect(module.getState().error).toBe(ceilingWarning(2000, 300));
    });

    it('re-anchor off: nothing shown, nothing kept', async () => {
        const { module } = await makeStarted('vp-1', makeRouter('off'));
        module.deliver(PLAYOUT_REANCHOR_EVENT, RAISE);
        await settle();
        expect(module.getState().health).toBe('ok');
        expect(module.getState().dynamicStatusSections).toEqual([]);
    });

    it('a failing request is logged — never an unhandled rejection in the engine', async () => {
        const router = makeRouter();
        router.requestPlayoutRaise.mockRejectedValueOnce(new Error('router down'));
        const { module, log } = await makeStarted('vp-1', router);
        module.deliver(PLAYOUT_REANCHOR_EVENT, RAISE);
        await settle();
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            'Playout re-anchor request failed',
        );
        expect(module.getState().health).toBe('ok');
    });

    it('a malformed payload is dropped before it reaches the engine', async () => {
        const { module, router } = await makeStarted('vp-1');
        module.deliver(PLAYOUT_REANCHOR_EVENT, { kind: 'raise', excessMs: 'lots' });
        await settle();
        expect(router.requestPlayoutRaise).not.toHaveBeenCalled();
    });

    it('rule 2: it never takes over someone else’s warning — and is back after PLAYING', async () => {
        const { module, child } = await makeStarted('vp-1');
        module.setHealth('warning', 'Device missing');
        module.deliver(PLAYOUT_REANCHOR_EVENT, RAISE);
        await settle();
        expect(module.getState().error).toBe('Device missing');
        // The section is still there to read.
        expect(module.getState().statusData.playout).toMatchObject({ raisedTo: 480 });
        // PLAYING sets health ok directly; the re-anchor is re-asserted on it.
        child.emit('stateChange', { state: 'playing' });
        expect(module.getState().health).toBe('warning');
        expect(module.getState().error).toContain('asked route head srt-input-1');
    });

    it('an edit of the head’s D (a zero raise) clears the leg’s warning and section', async () => {
        const { module } = await makeStarted('vp-1');
        module.deliver(PLAYOUT_REANCHOR_EVENT, RAISE);
        await settle();
        module.onRoutePlayoutRaised(headRaise({ raiseMs: 0 }));
        expect(module.getState().health).toBe('ok');
        expect(module.getState().dynamicStatusSections).toEqual([]);
    });

    it('a rebase: warns on the leg, tells the head, asks for nothing', async () => {
        const { module, router, child } = await makeStarted('vp-1');
        module.deliver(PLAYOUT_REANCHOR_EVENT, REBASE);
        await settle();
        expect(module.getState().error).toBe(rebaseWarningLeg(REBASE, 'srt-input-1'));
        expect(router.notePlayoutRebase).toHaveBeenCalledWith('vp-1', undefined, REBASE);
        expect(router.requestPlayoutRaise).not.toHaveBeenCalled();
        // The rebase lived in the old pipeline's pad offset: a new PLAYING ends it.
        child.emit('stateChange', { state: 'playing' });
        expect(module.getState().health).toBe('ok');
        expect(module.getState().dynamicStatusSections).toEqual([]);
    });
});

describe('GstPluginBase — the head carries the raise', () => {
    it('section, badge and warning from onRoutePlayoutRaised', async () => {
        const { module } = await makeStarted('srt-1');
        module.onRoutePlayoutRaised(headRaise());
        const state = module.getState();
        expect(state.error).toBe(raiseWarningHead(headRaise()));
        expect(state.badges).toEqual([
            { id: 'reanchor', icon: 'clock-alert', text: 're-anchored +180 ms', color: '#f59e0b' },
        ]);
        expect(state.statusData.playout).toEqual({
            configured: 300,
            raisedTo: 480,
            raisedBy: 'video-player-1 (vdec)',
            reason: 'hop transit or late timeline',
            since: '2026-10-08T12:00:00Z',
            requests: 1,
        });
    });

    it('the ceiling is the head’s text too', async () => {
        const { module } = await makeStarted('srt-1');
        module.onRoutePlayoutRaised(headRaise({ raiseMs: 2000, atCeiling: true }));
        expect(module.getState().error).toBe(ceilingWarning(2000, 300));
    });

    it('is re-asserted after a PLAYING edge (which sets health ok directly)', async () => {
        const { module, child } = await makeStarted('srt-1');
        module.onRoutePlayoutRaised(headRaise());
        child.emit('stateChange', { state: 'playing' });
        expect(module.getState().health).toBe('warning');
        expect(module.getState().error).toBe(raiseWarningHead(headRaise()));
        // …and survives a deliberate stop/start, which wipes badges and sections.
        await module.onStop();
        await module.onStart();
        h.FakeChildProcess.instances.at(-1)!.emit('stateChange', { state: 'playing' });
        expect(module.getState().badges.map((b) => b.id)).toEqual(['reanchor']);
        expect(module.getState().statusData.playout).toMatchObject({ raisedTo: 480 });
    });

    it('null clears all three', async () => {
        const { module } = await makeStarted('srt-1');
        module.onRoutePlayoutRaised(headRaise());
        module.onRoutePlayoutRaised(null);
        const state = module.getState();
        expect(state.health).toBe('ok');
        expect(state.badges).toEqual([]);
        expect(state.dynamicStatusSections).toEqual([]);
        expect(state.statusData.playout).toBeUndefined();
    });

    it('a rebase below it is a producer fault: shown until the producer restarts', async () => {
        const { module, child } = await makeStarted('srt-1');
        module.onRoutePlayoutRaised(headRaise());
        const note = {
            moduleId: 'vp-1',
            label: 'video-player-1',
            element: 'vdec',
            latenessMs: -21340,
            at: Date.UTC(2026, 9, 8, 12, 5, 0),
        };
        module.onRoutePlayoutRebased(note);
        expect(module.getState().error).toBe(rebaseWarningHead(note));
        expect(module.getState().statusData.playout).toMatchObject({
            reason: 'video-player-1 rebased: stamps 21.3 s off the house clock',
        });
        // A restarted producer is the fix: the note goes, the raise stays.
        child.emit('stateChange', { state: 'playing' });
        expect(module.getState().error).toBe(raiseWarningHead(headRaise()));
    });

    it('a module that never re-anchored is untouched by its PLAYING edges', async () => {
        const { module, child } = await makeStarted('plain-1');
        const emitted = vi.fn();
        module.on('stateChange', emitted);
        child.emit('stateChange', { state: 'playing' });
        // One stateChange: the PLAYING edge's own.
        expect(emitted).toHaveBeenCalledTimes(1);
        expect(module.getState().badges).toEqual([]);
        expect(module.getState().dynamicStatusSections).toEqual([]);
    });
});
