import {
    GstPluginBase,
    OwnPaModules,
    type PipelineDescription,
    type ModuleServices,
} from '@media-router/engine';

/**
 * N-1 Mix-Minus Audio Mixer.
 *
 * Creates N input/output pairs where each output bus receives a mix of ALL inputs
 * EXCEPT the one at the same index. Used for broadcast IFB monitoring — each
 * presenter hears everyone except themselves.
 *
 * Architecture:
 * - N input null-sinks (audio sources connect here via PipeWire loopback)
 * - N output null-sinks (mix buses — PipeWire sums when multiple loopbacks target same sink)
 * - N*(N-1) internal loopbacks (the cross-routing matrix, skipping self)
 * - N VU GStreamer processes (one per output bus for metering + volume control)
 *
 * No GStreamer mixing pipeline needed — PipeWire handles summing natively.
 */
export class N1MixerModule extends GstPluginBase {
    protected liveUpdatableParams: string[] = [];

    private pairCount = 4;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.pairCount = (config.pairCount as number) ?? 4;
    }

    /** Generate ports dynamically based on pairCount config. */
    getDynamicPorts(config: Record<string, unknown> = this.config): Array<{
        id: string;
        direction: 'input' | 'output';
        streamType: string;
        label: string;
        maxConnections: number;
    }> {
        // Read from the passed config so the engine's pre-start port resolution
        // (before onInit sets `this.pairCount`) still reflects the real count.
        const pairCount = (config.pairCount as number) ?? this.pairCount;
        const ports: Array<{
            id: string;
            direction: 'input' | 'output';
            streamType: string;
            label: string;
            maxConnections: number;
        }> = [];
        for (let i = 0; i < pairCount; i++) {
            ports.push({
                id: `in-${i}`,
                direction: 'input',
                streamType: 'audio/pcm',
                label: `In ${i + 1}`,
                maxConnections: -1,
            });
        }
        for (let i = 0; i < pairCount; i++) {
            ports.push({
                id: `out-${i}`,
                direction: 'output',
                streamType: 'audio/pcm',
                label: `Out ${i + 1}`,
                maxConnections: -1,
            });
        }
        return ports;
    }

    /**
     * Start: create PipeWire null-sinks, internal loopbacks, and VU processes.
     * Does NOT call super.onStart() — this module manages its own lifecycle.
     */
    async onStart(): Promise<void> {
        if (!this.services?.pipeWire) {
            throw new Error('PipeWire not available');
        }

        const instanceId = this.services.instanceId;
        this.pairCount = (this.config.pairCount as number) ?? 4;
        this.log.info({ pairCount: this.pairCount }, 'Starting N-1 mixer');
        // A PipeWire restart takes the whole graph with it: the watchdog makes it again. Before
        // the graph, so a restart while it is being made is caught too (v104 review minor 4).
        this.startDeviceWatchdog(true, true);
        const loopbackCount = await this.bringUpGraph();

        // Set running state
        this.running = true;
        this.health = 'ok';
        this.emit('stateChange', this.getState());

        // 7. Update status data
        this.setStatusData('routing', {
            pairCount: this.pairCount,
            loopbacks: loopbackCount,
            status: 'Active',
        });

        // A PipeWire-graph module: its timing is the latency PipeWire reports (§9.5).
        this.timing.watchPipeWire(
            Array.from({ length: this.pairCount }, (_, i) => `MR_PW_${instanceId}_out_${i}`),
        );

        this.log.info({ pairCount: this.pairCount, loopbackCount }, 'N-1 mixer started');
    }

    /** Its null sinks and loopbacks, kept by name for a rebuild (v104 B1). */
    private readonly own = new OwnPaModules(
        () => this.services?.pipeWire,
        () => this.services?.instanceId ?? '',
    );

    /** The N input and N output null sinks and the N*(N-1) loopbacks between them. */
    private async bringUpGraph(): Promise<number> {
        const pw = this.services!.pipeWire!;
        const instanceId = this.services!.instanceId;
        // 1. Create N input null-sinks
        for (let i = 0; i < this.pairCount; i++) {
            await this.own.nullSink(`${instanceId}_in_${i}`);
        }

        // 2. Create N output null-sinks (mix buses)
        for (let i = 0; i < this.pairCount; i++) {
            await this.own.nullSink(`${instanceId}_out_${i}`);
        }

        // 3. Wait for all sinks to appear
        for (let i = 0; i < this.pairCount; i++) {
            await pw.waitForSink(`MR_PW_${instanceId}_in_${i}`);
            await pw.waitForSink(`MR_PW_${instanceId}_out_${i}`);
        }

        // 4. Create N*(N-1) internal loopbacks (skip self)
        // Pace loopback creation to avoid overwhelming PipeWire
        let loopbackCount = 0;
        for (let out = 0; out < this.pairCount; out++) {
            for (let inp = 0; inp < this.pairCount; inp++) {
                if (inp === out) continue; // The N-1 exclusion
                const connId = `${instanceId}_n1_${inp}_to_${out}`;
                const source = `MR_PW_${instanceId}_in_${inp}.monitor`;
                const sink = `MR_PW_${instanceId}_out_${out}`;
                await this.own.loopback(connId, source, sink, 2, 48000, 5);
                loopbackCount++;
                // Brief pause every 8 loopbacks to let PipeWire settle
                if (loopbackCount % 8 === 0) {
                    await new Promise((r) => setTimeout(r, 100));
                }
            }
        }

        this.log.info({ loopbackCount }, 'Created internal loopbacks');
        return loopbackCount;
    }

    /** Its first input null sink, watched for a PipeWire restart (v104 B1). */
    protected getWatchedDeviceName(): string | null {
        return this.services?.instanceId ? `MR_PW_${this.services.instanceId}_in_0` : null;
    }

    /** PipeWire restarted: its null sinks and loopbacks unloaded by name. */
    protected async onDeviceDisconnected(): Promise<void> {
        await this.own.unloadAll();
    }

    /** PipeWire answers again: the graph made again, and the pw-links into and out of it re-made:
     *  they died with the old nodes. */
    protected async onDeviceReconnected(): Promise<void> {
        // A rebuild that failed part-way left some of its graph: gone first, so a retry never
        // makes a second sink or loopback of the same name (v104 F3).
        await this.own.unloadAll();
        await this.bringUpGraph();
        this.running = true;
        const id = this.services?.instanceId ?? '';
        await this.services?.mediaRouter?.reexecuteIncomingPwLinks?.(id);
        await this.services?.mediaRouter?.reexecuteOutgoingPwLinks?.(id);
    }

    async onStop(): Promise<void> {
        await this.stopDeviceWatchdog();
        this.own.clear();
        // PipeWire resources (null-sinks + loopbacks) are cleaned up automatically
        // by ModuleInstance.stop() → pipeWire.releaseAll(instanceId)

        await super.onStop();
    }

    /** N-1 mixer does not use a single GStreamer pipeline — returns null. */
    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        return null;
    }

    /** Map port IDs to PipeWire node names for multi-port routing. */
    getPipeWireNodeForPort(portId: string): { source?: string; sink?: string } {
        const instanceId = this.services?.instanceId ?? '';
        const match = portId.match(/^(in|out)-(\d+)$/);
        if (!match) return {};

        const [, direction, indexStr] = match;
        const index = parseInt(indexStr, 10);

        if (direction === 'in') {
            // Input ports are sinks — audio flows INTO the input null-sink
            return { sink: `MR_PW_${instanceId}_in_${index}` };
        } else {
            // Output ports are sources — audio flows OUT from the output null-sink monitor
            return { source: `MR_PW_${instanceId}_out_${index}.monitor` };
        }
    }

    /** Single-port fallback — not used for N-1 mixer, but required by interface. */
    getPipeWireNodes(): { source?: string; sink?: string } {
        return {};
    }
}
