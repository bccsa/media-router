// v104 B1's rig for the modules that make their own null sinks: the real module on a private
// PipeWire that restarts, its own nodes configured and linked as WirePlumber would (linkOwnNodes).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { setLogTap } from '@media-router/shared-types';
import { ModuleInstance } from '../../modules/ModuleInstance.js';
import type { PluginModule } from '../../plugins/PluginModule.js';
import { PipeWireManager } from '../PipeWireManager.js';
import { PrivatePipeWire, linkOwnNodes, sleep } from './privatePipeWire.js';

export interface OwnNodeRig {
    pw: PrivatePipeWire;
    instance: ModuleInstance;
    /** The router's re-link of the pw-links into and out of the module. */
    relinkIn: ReturnType<typeof vi.fn>;
    relinkOut: ReturnType<typeof vi.fn>;
    lines: Array<{ name: string; msg: string }>;
    /** Every one of `sinks` listed by pactl. */
    sinksBack(sinks: string[]): Promise<boolean>;
    /** Health ok and `ready()` within `budgetMs`. */
    upWithin(budgetMs: number, ready: () => Promise<boolean>): Promise<boolean>;
    stop(): Promise<void>;
}

export async function ownNodeRig(opts: {
    registry: string;
    id: string;
    pluginId: string;
    module: PluginModule;
    config: Record<string, unknown>;
    /** Extra router methods the module asks (its bus channel, its upstream). */
    router?: Record<string, unknown>;
}): Promise<OwnNodeRig> {
    const pw = new PrivatePipeWire({ sinks: ['own_spk'] });
    pw.enter(opts.registry);
    const savedBusDir = process.env.MR_BUS_SOCKET_DIR;
    process.env.MR_BUS_SOCKET_DIR = join(pw.root, 'bus');
    mkdirSync(process.env.MR_BUS_SOCKET_DIR, { recursive: true });
    const lines: Array<{ name: string; msg: string }> = [];
    setLogTap((l) => lines.push(JSON.parse(l)));
    await pw.start();
    const stopLinking = linkOwnNodes(pw);
    const relinkIn = vi.fn(async () => {});
    const relinkOut = vi.fn(async () => {});
    const instance = new ModuleInstance(opts.id, opts.pluginId, opts.module, opts.config, {
        instanceId: opts.id,
        pipeWire: new PipeWireManager(),
        mediaRouter: {
            assignBusChannel: () => ({ port: 41971 }),
            getBusChannel: () => ({ port: 41971 }),
            releaseAllBusChannelsFor: () => {},
            onProducerPlaying: () => {},
            getModuleBusSource: () => undefined,
            getModuleBusSources: () => [],
            hasStoredEdge: () => false,
            reexecuteIncomingPwLinks: relinkIn,
            reexecuteOutgoingPwLinks: relinkOut,
            ...opts.router,
        },
        processManager: { releaseAll: async () => {} },
        deviceProviders: {},
    } as any);
    const state = () => opts.module.getState();
    const rig: OwnNodeRig = {
        pw,
        instance,
        relinkIn,
        relinkOut,
        lines,
        async sinksBack(sinks) {
            const listed = (await pw.tool('pactl', ['list', 'short', 'sinks']))
                .split('\n')
                .map((l) => l.split('\t')[1]);
            return sinks.every((s) => listed.includes(s));
        },
        async upWithin(budgetMs, ready) {
            const deadline = Date.now() + budgetMs;
            while (Date.now() < deadline) {
                if (state().health === 'ok' && (await ready())) return true;
                await sleep(200);
            }
            return false;
        },
        async stop() {
            await instance.stop().catch(() => {});
            await stopLinking();
            await pw.stop();
            pw.remove();
            setLogTap(null);
            pw.leave();
            if (savedBusDir === undefined) delete process.env.MR_BUS_SOCKET_DIR;
            else process.env.MR_BUS_SOCKET_DIR = savedBusDir;
        },
    };
    await instance.start();
    return rig;
}

/** Does a stream run into `sink` (a sink-input on it, the sink RUNNING)? */
export async function streamInto(pw: PrivatePipeWire, sink: string): Promise<boolean> {
    const sinks = await pw.tool('pactl', ['list', 'short', 'sinks']);
    const row = sinks.split('\n').find((l) => l.split('\t')[1] === sink);
    if (!row || !/\tRUNNING$/.test(row)) return false;
    const inputs = await pw.tool('pactl', ['list', 'short', 'sink-inputs']);
    return inputs.split('\n').some((l) => l.split('\t')[1] === row.split('\t')[0]);
}

/** Is `sink`'s monitor linked into something (a capture of it)? */
export async function monitorRead(pw: PrivatePipeWire, sink: string): Promise<boolean> {
    const links = await pw.tool('pw-link', ['-l']);
    return new RegExp(`^${sink}:monitor_\\w+\\n  \\|-> `, 'm').test(links);
}

/** The case: up, PipeWire restarted (~0.2 s down), then its own sinks made again and `ready()`
 *  within 15 s of the return, with a warning on the way and the re-links asked. The time back. */
export async function restartComesBack(
    rig: OwnNodeRig,
    sinks: string[],
    ready: () => Promise<boolean>,
): Promise<{ ms: number; health: string[] }> {
    if (!(await rig.upWithin(60_000, async () => (await rig.sinksBack(sinks)) && (await ready()))))
        throw new Error('not up before the restart');
    const plugin = rig.instance.getPlugin() as unknown as import('node:events').EventEmitter & {
        getState(): { health: string };
    };
    const health: string[] = [];
    const onHealth = () => health.push(plugin.getState().health);
    plugin.on('stateChange', onHealth);
    await rig.pw.stop();
    await sleep(200);
    await rig.pw.start();
    const back = Date.now();
    const up = await rig.upWithin(
        15_000,
        async () => health.includes('warning') && (await rig.sinksBack(sinks)) && (await ready()),
    );
    plugin.off('stateChange', onHealth);
    if (!up) throw new Error(`not back within 15 s: health ${health.join(',')}`);
    return { ms: Date.now() - back, health };
}
