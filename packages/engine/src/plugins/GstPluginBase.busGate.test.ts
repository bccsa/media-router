import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The runner's unixfd input gate waits INDEFINITELY for its producer edge
 * sockets, so the health warning it raises is the only thing an operator has to
 * go on. It used to read
 *
 *   Waiting for producer bus socket(s): /tmp/mr-bus-41000-a1b2c3.sock
 *
 * which names nothing an operator can act on — the path is derived from
 * (channel port, connection id). The routing layer knows both ends of every bus
 * edge feeding this module, so the wait is reported by upstream MODULE instead.
 *
 * Pinned here as well: the clear branch. `if (this.health === 'warning')
 * setHealth('ok')` erased ANY warning when the gate opened, including ones
 * raised by something else entirely (a crashed helper, a missing device) — so a
 * real failure disappeared because an unrelated gate happened to open.
 */
// `vi.hoisted` runs before the import section, so the fake carries its own
// minimal emitter rather than extending node's (which isn't initialised yet).
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
import { busEdgeSocketPath } from './busHelpers.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';

const EDGE_A = busEdgeSocketPath(41000, 'conn-a');
const EDGE_B = busEdgeSocketPath(41001, 'conn-b');

class TestModule extends GstPluginBase {
    buildPipeline(): PipelineDescription | null {
        return { pipeline: `unixfdsrc socket-path=${EDGE_A} ! fakesink` };
    }
}

type BusSource = ReturnType<
    import('../routing/MediaRouter.js').MediaRouter['getModuleBusSources']
>[number];

const busSource = (socketPath: string, sourceModuleId: string, sinkPortId: string): BusSource =>
    ({
        port: 41000,
        connectionId: 'conn',
        sourceModuleId,
        sourcePortId: 'out',
        sinkPortId,
        streamType: 'muxed/mpegts',
        socketPath,
    }) as unknown as BusSource;

/** A started module (real busGate wiring in place) plus its fake child. */
async function makeStarted(sources: BusSource[] | null): Promise<{
    module: TestModule;
    child: InstanceType<typeof h.FakeChildProcess>;
}> {
    h.FakeChildProcess.instances = [];
    const module = new TestModule();
    await module.onInit({}, {
        instanceId: 'consumer-1',
        ...(sources ? { mediaRouter: { getModuleBusSources: vi.fn(() => sources) } } : {}),
    } as unknown as ModuleServices);
    await module.onStart();
    const child = h.FakeChildProcess.instances[0]!;
    expect(module.getState().health).toBe('ok');
    return { module, child };
}

const gate = (child: InstanceType<typeof h.FakeChildProcess>, pending: string[]): void => {
    child.emit('busGate', { pending });
};

beforeEach(() => vi.clearAllMocks());

describe('GstPluginBase busGate → health', () => {
    it('names the upstream module and sink port, not the socket path', async () => {
        const { module, child } = await makeStarted([busSource(EDGE_A, 'mpegts-in-1', 'input')]);
        gate(child, [EDGE_A]);

        const state = module.getState();
        expect(state.health).toBe('warning');
        expect(state.error).toBe('Waiting for upstream module(s): mpegts-in-1 (input)');
        expect(state.error).not.toContain('/tmp/');
        expect(state.statusData.bus).toEqual({
            'Waiting for producer': 'mpegts-in-1 (input)',
        });
    });

    it('reports every pending edge, falling back to the raw path when unmatched', async () => {
        const { module, child } = await makeStarted([busSource(EDGE_A, 'mpegts-in-1', 'video')]);
        gate(child, [EDGE_A, EDGE_B]);

        expect(module.getState().error).toBe(
            `Waiting for upstream module(s): mpegts-in-1 (video), ${EDGE_B}`,
        );
    });

    it('falls back to raw paths when there is no routing service to ask', async () => {
        const { module, child } = await makeStarted(null);
        gate(child, [EDGE_A]);
        expect(module.getState().error).toBe(`Waiting for upstream module(s): ${EDGE_A}`);
    });

    it('the gate opening clears its own warning and the bus section', async () => {
        const { module, child } = await makeStarted([busSource(EDGE_A, 'mpegts-in-1', 'input')]);
        gate(child, [EDGE_A]);
        expect(module.getState().health).toBe('warning');

        gate(child, []);
        const state = module.getState();
        expect(state.health).toBe('ok');
        expect(state.error).toBeNull();
        expect(state.statusData.bus).toEqual({});
    });

    it('does NOT stomp an unrelated warning raised while the gate was waiting', async () => {
        const { module, child } = await makeStarted([busSource(EDGE_A, 'mpegts-in-1', 'input')]);
        gate(child, [EDGE_A]);
        // Something else takes over the health text (ManagedProcess restart,
        // device watchdog, plugin-specific condition…).
        module.setHealth('warning', 'ffmpeg helper crashed — restarting (attempt 2)');

        gate(child, []);
        const state = module.getState();
        expect(state.health).toBe('warning');
        expect(state.error).toBe('ffmpeg helper crashed — restarting (attempt 2)');
        // The gate's own section still clears — the wait really is over.
        expect(state.statusData.bus).toEqual({});
    });

    it('an error raised while gated survives the gate opening', async () => {
        const { module, child } = await makeStarted([busSource(EDGE_A, 'mpegts-in-1', 'input')]);
        gate(child, [EDGE_A]);
        child.emit('error', { message: 'Bus ERROR: internal data stream error' });
        expect(module.getState().health).toBe('error');

        gate(child, []);
        expect(module.getState().health).toBe('error');
        expect(module.getState().error).toContain('internal data stream error');
    });

    it('a second gate report re-arms the clear (warning is still ours)', async () => {
        const { module, child } = await makeStarted([busSource(EDGE_A, 'mpegts-in-1', 'input')]);
        gate(child, [EDGE_A]);
        gate(child, [EDGE_A]); // periodic re-report while still waiting
        gate(child, []);
        expect(module.getState().health).toBe('ok');
    });
});
