import { vi } from 'vitest';
import { MediaRouter } from '../MediaRouter.js';
import type { ModuleInstance } from '../../modules/ModuleInstance.js';
import { effectivePlayoutOffsetMs } from '../../plugins/playoutOffset.js';
import type { ReanchorRaiseRequest } from '../../plugins/playoutReanchor.js';

/** Route fixtures for the playout re-anchor suites: a free-form bus graph whose modules are
 *  spies (MediaRouter.playoutOffset.test.ts's shape). */
export function busGraph(configs: Record<string, Record<string, unknown>>, pcm: string[] = []) {
    const router = new MediaRouter();
    const notified: string[] = [];
    const modules: Record<string, ModuleInstance> = {};
    for (const [id, config] of Object.entries(configs)) {
        router.registerPorts(id, [
            { id: 'in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
            { id: 'in-b', direction: 'input', streamType: 'muxed/mpegts', label: 'In B' },
            {
                id: 'out',
                direction: 'output',
                streamType: pcm.includes(id) ? 'audio/302m' : 'muxed/mpegts',
                label: 'Out',
            },
        ]);
        modules[id] = {
            instanceId: id,
            config,
            running: false,
            start: vi.fn(),
            stop: vi.fn(),
            notifyRoutePlayoutOffsetChanged: vi.fn(async () => {
                notified.push(id);
            }),
            notifyRoutePlayoutRaised: vi.fn(),
            notifyRoutePlayoutRebased: vi.fn(),
            notifyPlayoutLegOffset: vi.fn(),
        } as unknown as ModuleInstance;
    }
    router.setDependencies(
        {} as never,
        (id: string) => modules[id],
        (id) => `${id} (name)`,
    );
    for (const id of Object.keys(configs)) router.assignBusChannel(id, 'out');
    const wire = (from: string, to: string, sinkPortId = 'in') =>
        router.createConnection(from, 'out', to, sinkPortId);
    return { router, modules, notified, wire };
}

export const spy = (m: ModuleInstance, name: keyof ModuleInstance) =>
    (m as unknown as Record<string, ReturnType<typeof vi.fn>>)[name as string];

export function req(
    excessMs: number,
    over: Partial<ReanchorRaiseRequest> = {},
): ReanchorRaiseRequest {
    return {
        kind: 'raise',
        element: 'vdec',
        excessMs,
        worstMs: excessMs,
        cause: 'timeline',
        queuedMs: 0,
        budgetMs: 300,
        tsOffsetMs: 300,
        latencyMs: 0,
        holdMs: 15_000,
        ...over,
    };
}

/** splitter (D 300) → { video-player, audio-transcoder → audio-output-302m }. */
export async function splitRoute() {
    const g = busGraph(
        {
            splitter: { playoutOffsetMs: 300 },
            'video-player': {},
            'audio-transcoder': {},
            'audio-output-302m': {},
        },
        ['audio-transcoder'],
    );
    await g.wire('splitter', 'video-player');
    await g.wire('splitter', 'audio-transcoder');
    await g.wire('audio-transcoder', 'audio-output-302m');
    g.router.setPlayoutReanchor(true, 60);
    g.notified.length = 0;
    return g;
}

/** What a leg resolves for its sink: the one shared definition. */
export const legD = (router: MediaRouter, id: string) =>
    effectivePlayoutOffsetMs({
        instanceId: id,
        playoutOffsetMs: 60,
        mediaRouter: router,
    });
