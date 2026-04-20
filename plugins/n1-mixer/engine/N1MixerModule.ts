import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

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
    getDynamicPorts(): Array<{
        id: string;
        direction: 'input' | 'output';
        streamType: string;
        label: string;
        maxConnections: number;
    }> {
        const ports: Array<{
            id: string;
            direction: 'input' | 'output';
            streamType: string;
            label: string;
            maxConnections: number;
        }> = [];
        for (let i = 0; i < this.pairCount; i++) {
            ports.push({
                id: `in-${i}`,
                direction: 'input',
                streamType: 'audio/pcm',
                label: `In ${i + 1}`,
                maxConnections: -1,
            });
        }
        for (let i = 0; i < this.pairCount; i++) {
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

        const pw = this.services.pipeWire;
        const instanceId = this.services.instanceId;
        this.pairCount = (this.config.pairCount as number) ?? 4;

        this.log.info({ pairCount: this.pairCount }, 'Starting N-1 mixer');

        // 1. Create N input null-sinks
        for (let i = 0; i < this.pairCount; i++) {
            await pw.loadNullSink(`${instanceId}_in_${i}`, 2, 48000, instanceId);
            await pw.setSinkVolume(`MR_PW_${instanceId}_in_${i}`, 100);
        }

        // 2. Create N output null-sinks (mix buses)
        for (let i = 0; i < this.pairCount; i++) {
            await pw.loadNullSink(`${instanceId}_out_${i}`, 2, 48000, instanceId);
            await pw.setSinkVolume(`MR_PW_${instanceId}_out_${i}`, 100);
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
                await pw.loadLoopback(connId, source, sink, 2, 48000, instanceId, 5);
                loopbackCount++;
                // Brief pause every 8 loopbacks to let PipeWire settle
                if (loopbackCount % 8 === 0) {
                    await new Promise((r) => setTimeout(r, 100));
                }
            }
        }

        this.log.info({ loopbackCount }, 'Created internal loopbacks');

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

        this.log.info({ pairCount: this.pairCount, loopbackCount }, 'N-1 mixer started');
    }

    async onStop(): Promise<void> {
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
