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

    beforeEach(() => {
        lines = [];
        setLogTap((l) => lines.push(JSON.parse(l) as Line));
        router = new MediaRouter();
        modules = { mic: fakeModule(), mic2: fakeModule(), mixer: fakeModule() };
        for (const id of ['mic', 'mic2']) {
            router.registerPorts(id, [
                { id: 'audio-out', direction: 'output', streamType: 'audio/302m', label: 'Out' },
            ]);
        }
        router.registerPorts('mixer', [
            {
                id: 'audio-in',
                direction: 'input',
                streamType: 'audio/302m',
                label: 'In',
                maxConnections: -1,
            },
        ]);
        router.setDependencies(
            {} as never,
            (id) => modules[id] as never,
            (id) => NAMES[id] ?? id,
        );
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
