/**
 * Everything the module publishes about itself while it runs: the chain meter
 * poll (LSP levels, latency, gain-reduction badge), the output throughput
 * poll, and the settings-panel graphs.
 *
 * Kept out of `AudioProcessingModule` so the module file stays lifecycle +
 * pipeline. The host supplies plain callbacks, so this class needs no
 * knowledge of `GstPluginBase` and tests can drive it with fakes.
 */

import { ThroughputPoller, bitrateBadge, type ThroughputSample } from '@media-router/engine';
import type { StatusGraph } from '@media-router/engine';
import { DuckLiveThrottle, type DuckLive } from './duckLive.js';
import { GraphPublisher } from './graphPublisher.js';
import { MeterPoll, type ReadProperty } from './statusPoll.js';
import type { ChainStages } from './lspProcessing.js';

export interface ChainTelemetryHooks {
    /** Read one property off a named element in the running pipeline. */
    readProperty: ReadProperty;
    /** Bytes served by the output bus sink, or undefined while not running. */
    readSinkBytes: () => Promise<Record<string, number> | undefined>;
    publishStatus: (section: string, data: Record<string, unknown>) => void;
    publishGraph: (key: string, graph: StatusGraph | null) => void;
    /** Set (or clear, with null) a module-face badge. */
    badge: (id: string, badge: { icon?: string; text: string; color?: string } | null) => void;
    /** Current module config — read fresh, so live changes are picked up. */
    config: () => Record<string, unknown>;
}

export class ChainTelemetry {
    private readonly graphs: GraphPublisher;
    private readonly meters: MeterPoll;
    private readonly throughput: ThroughputPoller;
    /** The ducker's own telemetry path — no LADSPA meters are involved. */
    private readonly duck = new DuckLiveThrottle((live) => {
        this.graphs.setDuckLive(live);
        this.publishGraphs();
    });

    constructor(private readonly hooks: ChainTelemetryHooks) {
        this.graphs = new GraphPublisher(hooks.publishGraph);
        this.meters = new MeterPoll({
            read: hooks.readProperty,
            publish: (status, levels) => {
                hooks.publishStatus('meters', status);
                // Same tick republishes the transfer curve so its live
                // operating point tracks the meter.
                this.graphs.update(hooks.config(), levels);
            },
            badge: (badge) => hooks.badge('gr', badge),
        });
        this.throughput = new ThroughputPoller({
            getBytes: hooks.readSinkBytes,
            publish: (total: ThroughputSample) => {
                hooks.publishStatus('throughput', { bitrate: total.bitrateKbps });
                hooks.badge('bitrate', bitrateBadge(total.bitrateKbps));
            },
        });
    }

    /** Recompute the graphs from current config (no meter reading involved). */
    publishGraphs(): void {
        this.graphs.update(this.hooks.config());
    }

    /**
     * One ducker envelope tick (~15 Hz, off the sidechain level messages) —
     * `DuckerEnvelope` itself is the reading. The throttle decides whether it
     * is worth a graph republish (see `duckLive.ts`); a module that isn't
     * ducking publishes nothing at all.
     */
    duckLevel(reading: DuckLive): void {
        this.duck.offer(reading);
    }

    /** Meter poll runs only when the chain has a LADSPA stage to read. */
    start(stages: ChainStages | null): void {
        this.throughput.start();
        if (stages) this.meters.start(stages);
    }

    stop(): void {
        this.throughput.stop();
        this.meters.stop();
        this.duck.reset();
        // The dot would otherwise freeze at the last level the chain saw.
        this.graphs.clearLive();
        this.publishGraphs();
    }
}
