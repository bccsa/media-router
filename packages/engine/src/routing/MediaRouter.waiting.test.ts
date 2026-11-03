import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLogTap } from '@media-router/shared-types';
import { MediaRouter } from './MediaRouter.js';
import { busEdgeSocketPath } from '../plugins/busHelpers.js';

/**
 * B-194 (MR-005, ZA-SCC-SWA01): a bus connection whose producer is there but has no channel
 * yet (starting, waiting for its device, idle until its own inputs come) used to fail three
 * times at level 50 and be dropped, and nothing applied it when the producer started by itself.
 * It now waits, quietly, and runs when the producer's channel is assigned, however late.
 */

type Line = { level: number; name: string; msg: string };

let lines: Line[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, budgetMs = 3000): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await sleep(5);
    }
    return cond();
}

/** A module as the router sees it; `start` and `stop` take a little time, as a runner's do. */
function fakeModule(running = true) {
    let active = 0;
    const m = {
        running,
        config: {},
        maxConcurrent: 0,
        stop: vi.fn(async () => {
            m.running = false;
        }),
        start: vi.fn(async () => {
            active++;
            m.maxConcurrent = Math.max(m.maxConcurrent, active);
            await sleep(10);
            active--;
            m.running = true;
        }),
        getChildProcess: () => null,
    };
    return m;
}

const NAMES: Record<string, string> = { mic: 'Mic 1', mic2: 'Mic 2', mixer: 'Audio Mixer' };

describe('MediaRouter: a connection waits for its producer (B-194)', () => {
    let router: MediaRouter;
    let modules: Record<string, ReturnType<typeof fakeModule>>;

    /** Two mics and a mixer; `checkMs` is how long a wait goes before its check (B-196). */
    function makeRouter(checkMs?: number): MediaRouter {
        const r = new MediaRouter(checkMs);
        for (const id of ['mic', 'mic2']) {
            r.registerPorts(id, [
                { id: 'audio-out', direction: 'output', streamType: 'audio/302m', label: 'Out' },
            ]);
        }
        r.registerPorts('mixer', [
            {
                id: 'audio-in',
                direction: 'input',
                streamType: 'audio/302m',
                label: 'In',
                maxConnections: -1,
            },
        ]);
        r.setDependencies(
            {} as never,
            (id) => modules[id] as never,
            (id) => NAMES[id] ?? id,
        );
        return r;
    }

    beforeEach(() => {
        lines = [];
        setLogTap((l) => lines.push(JSON.parse(l) as Line));
        modules = { mic: fakeModule(), mic2: fakeModule(), mixer: fakeModule() };
        router = makeRouter();
    });

    afterEach(() => setLogTap(null));

    const connect = (src = 'mic') => router.createConnection(src, 'audio-out', 'mixer', 'audio-in');
    const ID = 'mic:audio-out-mixer:audio-in';

    it('waits without an error, says so once naming both modules, and runs when the channel comes', async () => {
        expect(await connect()).toBe(ID);
        expect(router.getConnections()).toEqual([]);
        expect(router.isConnectionWaiting(ID)).toBe(true);
        expect(modules.mixer.start).not.toHaveBeenCalled();
        // A re-apply while it still waits (a restart of the mixer, say) says nothing new.
        await connect();
        const waits = lines.filter((l) => l.name === 'MediaRouter' && /waits for/.test(l.msg));
        expect(waits).toHaveLength(1);
        expect(waits[0]).toMatchObject({ level: 30 });
        expect(waits[0].msg).toBe(
            'Connection [Mic 1 → Audio Mixer] waits for Mic 1: its output is not up yet',
        );

        // However late: the mic's device is plugged in and its build takes a channel.
        await sleep(50);
        router.assignBusChannel('mic');
        const connected = 'Connected [Mic 1 → Audio Mixer]: its producer is up';
        expect(await waitUntil(() => lines.some((l) => l.msg === connected))).toBe(true);
        expect(router.getConnections().map((c) => c.id)).toEqual([ID]);
        expect(router.isConnectionWaiting(ID)).toBe(false);
        expect(modules.mixer.start).toHaveBeenCalledTimes(1);
        expect(router.getModuleBusSources('mixer').map((s) => s.sourceModuleId)).toEqual(['mic']);
        expect(lines.filter((l) => l.level >= 50)).toEqual([]);
    });

    it('a producer that takes its channel by port (a mixer, a transcoder) wakes the wait on that port', async () => {
        // SWA01's waits were on audio-mixer:audio-out and audio-transcoder:out-0.
        await connect();
        router.assignBusChannel('mic', 'audio-out');
        expect(router.getBusChannel('mic')).toBeUndefined();
        expect(await waitUntil(() => router.getConnections().length === 1)).toBe(true);
        expect(router.isConnectionWaiting(ID)).toBe(false);
        expect(modules.mixer.start).toHaveBeenCalledTimes(1);
        expect(lines.filter((l) => l.level >= 50)).toEqual([]);
    });

    it('a channel of another module, or of another port of the producer, wakes nothing', async () => {
        await connect();
        router.assignBusChannel('mixer');
        router.assignBusChannel('mic', 'other-port');
        router.assignBusChannel('mic', 'other-port');
        await sleep(30);
        expect(router.isConnectionWaiting(ID)).toBe(true);
        expect(modules.mixer.start).not.toHaveBeenCalled();
    });

    it('a removed connection, an unregistered module and an engine stop end the wait', async () => {
        await connect();
        expect(await router.removeConnection(ID)).toBe(true);
        expect(router.isConnectionWaiting(ID)).toBe(false);

        await connect();
        await router.unregisterPorts('mixer');
        expect(router.isConnectionWaiting(ID)).toBe(false);
        router.registerPorts('mixer', [
            { id: 'audio-in', direction: 'input', streamType: 'audio/302m', label: 'In' },
        ]);

        await connect();
        await router.removeAllConnections(true);
        expect(router.isConnectionWaiting(ID)).toBe(false);

        router.assignBusChannel('mic');
        await sleep(30);
        expect(router.getConnections()).toEqual([]);
        expect(modules.mixer.start).not.toHaveBeenCalled();
    });

    it('a sink that is not running when the channel comes keeps the wait; its own start applies it', async () => {
        modules.mixer.running = false;
        await connect();
        router.assignBusChannel('mic');
        await sleep(30);
        expect(router.isConnectionWaiting(ID)).toBe(true);
        expect(modules.mixer.start).not.toHaveBeenCalled();

        // ModuleLifecycle's start of the sink re-applies its connections.
        modules.mixer.running = true;
        await connect();
        expect(router.getConnections().map((c) => c.id)).toEqual([ID]);
        expect(router.isConnectionWaiting(ID)).toBe(false);
    });

    it('woken connections into one sink run one at a time', async () => {
        await connect('mic');
        await connect('mic2');
        router.assignBusChannel('mic');
        router.assignBusChannel('mic2');
        expect(await waitUntil(() => router.getConnections().length === 2)).toBe(true);
        // Two restarts of one sink never overlap.
        expect(modules.mixer.start).toHaveBeenCalledTimes(2);
        expect(modules.mixer.maxConcurrent).toBe(1);
    });

    it('a woken connection runs through the scheduler handed in (the lifecycle lock)', async () => {
        const tasks: Array<() => Promise<void>> = [];
        router.setWaitingScheduler((task) => tasks.push(task));
        await connect();
        router.assignBusChannel('mic');
        expect(await waitUntil(() => tasks.length === 1)).toBe(true);
        expect(router.getConnections()).toEqual([]);
        await tasks[0]();
        expect(router.getConnections().map((c) => c.id)).toEqual([ID]);
    });

    it('a channel map edited while the connection waits is the one it runs with', async () => {
        await connect();
        const map = [{ srcChannel: 0, dstChannel: 1 }];
        await router.updateChannelMap(ID, map);
        router.assignBusChannel('mic');
        await waitUntil(() => router.getConnections().length === 1);
        expect(router.getModuleBusSources('mixer')[0].channelMap).toEqual(map);
    });

    it('a sink stopped outside the lifecycle when the channel comes takes the connection at its next start (B-196)', async () => {
        await connect();
        // A live connect of another source restarts the mixer: stopped, not started again yet.
        modules.mixer.running = false;
        router.assignBusChannel('mic');
        await sleep(30);
        expect(router.isConnectionWaiting(ID)).toBe(true);
        expect(modules.mixer.start).not.toHaveBeenCalled();

        // That start re-applies nothing of the mixer's: the router hears of it (ModuleInstance).
        modules.mixer.running = true;
        router.noteModuleStarted('mixer');
        expect(await waitUntil(() => router.getConnections().length === 1)).toBe(true);
        expect(router.isConnectionWaiting(ID)).toBe(false);
        expect(modules.mixer.start).toHaveBeenCalledTimes(1);
    });

    it("another module's start, or the sink's while its producer has no channel, runs nothing (B-196)", async () => {
        await connect();
        router.noteModuleStarted('mixer');
        router.noteModuleStarted('mic');
        router.noteModuleStarted('mic2');
        await sleep(30);
        expect(router.isConnectionWaiting(ID)).toBe(true);
        expect(modules.mixer.start).not.toHaveBeenCalled();
    });

    describe('the check of a long wait (B-196)', () => {
        const CHECK_MS = 150;
        const warnings = () =>
            lines.filter((l) => l.name === 'MediaRouter' && l.level === 40).map((l) => l.msg);

        beforeEach(() => {
            router = makeRouter(CHECK_MS);
        });

        it('a wake missed (the sink restarted unheard): run at the check, with one warning naming both modules', async () => {
            await connect();
            modules.mixer.running = false;
            router.assignBusChannel('mic');
            await sleep(30);
            modules.mixer.running = true; // started again, the router not told
            expect(router.isConnectionWaiting(ID)).toBe(true);

            expect(await waitUntil(() => router.getConnections().length === 1, 2000)).toBe(true);
            expect(warnings()).toEqual([
                'Connection [Mic 1 → Audio Mixer] still waits with Mic 1 up — applying it now',
            ]);
            expect(lines.filter((l) => l.level >= 50)).toEqual([]);
        });

        it('a producer that runs a pipeline without a channel for this output is named once; it still connects when the channel comes', async () => {
            Object.assign(modules.mic, { getChildProcess: () => ({ pipelineLaunchedAt: 1000 }) });
            await connect();
            await connect(); // a re-apply while it waits: still one check
            await sleep(CHECK_MS * 3);
            expect(router.isConnectionWaiting(ID)).toBe(true);
            expect(warnings()).toEqual([
                'Connection [Mic 1 → Audio Mixer] still waits for Mic 1: it runs, but its output audio-out is not up',
            ]);

            router.assignBusChannel('mic');
            expect(await waitUntil(() => router.getConnections().length === 1)).toBe(true);
            expect(warnings()).toHaveLength(1);
        });

        it('a check due during a lifecycle operation runs after it: quiet when the operation applied the connection', async () => {
            const tasks: Array<() => Promise<void>> = [];
            router.setWaitingScheduler((task) => tasks.push(task));
            Object.assign(modules.mic, { getChildProcess: () => ({ pipelineLaunchedAt: 1000 }) });
            await connect();
            await sleep(CHECK_MS + 50); // due: queued behind the operation (an engine start, say)
            expect(tasks).toHaveLength(1);
            // The operation gives the mic its channel and applies the connection itself.
            router.assignBusChannel('mic');
            await connect();
            expect(router.getConnections().map((c) => c.id)).toEqual([ID]);
            expect(await waitUntil(() => tasks.length === 2)).toBe(true);
            for (const task of tasks.splice(0)) await task();
            expect(warnings()).toEqual([]);
        });

        it('quiet for a wait whose run is already queued when its check runs', async () => {
            const tasks: Array<() => Promise<void>> = [];
            router.setWaitingScheduler((task) => tasks.push(task));
            await connect();
            await sleep(CHECK_MS + 50);
            router.assignBusChannel('mic'); // its run queued behind the check
            expect(await waitUntil(() => tasks.length === 2)).toBe(true);
            for (const task of tasks.splice(0)) await task();
            expect(router.getConnections().map((c) => c.id)).toEqual([ID]);
            expect(warnings()).toEqual([]);
        });

        it('quiet for a wait into a stopped sink (disabled, say): its start runs it', async () => {
            modules.mixer.running = false;
            Object.assign(modules.mic, { getChildProcess: () => ({ pipelineLaunchedAt: 1000 }) });
            await connect();
            await sleep(CHECK_MS * 2);
            router.assignBusChannel('mic');
            await sleep(30);
            expect(router.isConnectionWaiting(ID)).toBe(true);
            expect(warnings()).toEqual([]);

            modules.mixer.running = true;
            router.noteModuleStarted('mixer');
            expect(await waitUntil(() => router.getConnections().length === 1)).toBe(true);
        });

        it('quiet for a producer with no pipeline (no input, no device), a wait woken in time, and a removed one', async () => {
            const ID2 = 'mic2:audio-out-mixer:audio-in';
            await connect('mic'); // no pipeline: waits for its device, however long
            await connect('mic2');
            router.assignBusChannel('mic2'); // woken in time
            expect(await waitUntil(() => router.getConnections().length === 1)).toBe(true);
            await sleep(CHECK_MS * 2);
            expect(warnings()).toEqual([]);

            // mic2 runs again without its channel; its connection is removed while it waits.
            await router.removeConnection(ID2);
            router.releaseAllBusChannelsFor('mic2');
            Object.assign(modules.mic2, { getChildProcess: () => ({ pipelineLaunchedAt: 1000 }) });
            await connect('mic2');
            expect(router.isConnectionWaiting(ID2)).toBe(true);
            await router.removeConnection(ID2);
            await sleep(CHECK_MS * 2);

            expect(router.isConnectionWaiting(ID)).toBe(true);
            expect(warnings()).toEqual([]);
        });
    });

    it('names the module behind a bus socket path, also once its channel is released', () => {
        const port = router.assignBusChannel('mixer', 'audio-out')!.port;
        const path = busEdgeSocketPath(port, 'mixer:audio-out-x:in');
        expect(router.busSocketProducer(path)).toBe('mixer');
        router.releaseAllBusChannelsFor('mixer');
        expect(router.busSocketProducer(path)).toBe('mixer');
        expect(router.moduleName('mixer')).toBe('Audio Mixer');
        expect(router.busSocketProducer('/tmp/elsewhere.sock')).toBeUndefined();
    });
});
