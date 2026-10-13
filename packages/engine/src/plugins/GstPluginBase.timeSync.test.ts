import { describe, it, expect } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import type { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { ModuleServices, PipelineDescription } from './PluginModule.js';

/**
 * What `GstPluginBase.applyTimeSync` does to a description on both the start
 * and the refresh path. Every pipeline runs on the house clock (§4.1); the
 * runners need no flag for it, so nothing clock-related is added here.
 */
class TestModule extends GstPluginBase {
    constructor(private readonly desc: PipelineDescription | null) {
        super();
    }
    buildPipeline(): PipelineDescription | null {
        return this.desc;
    }
    attachChild(fake: unknown): void {
        this.childProcess = fake as GstChildProcess;
    }
}

/**
 * Run a description through the real resolve path (`refreshPipelineDescription`
 * → applyTimeSync → childProcess) and hand back what the runner would receive.
 */
async function resolve(
    desc: PipelineDescription | null,
    services: Partial<ModuleServices>,
): Promise<PipelineDescription | undefined> {
    const module = new TestModule(desc);
    await module.onInit({}, services as ModuleServices);
    let sent: PipelineDescription | undefined;
    module.attachChild({
        updatePipelineDesc: (d: PipelineDescription) => {
            sent = d;
            return Promise.resolve();
        },
    });
    await module.refreshPipelineDescription();
    return sent;
}

describe('GstPluginBase time-sync resolution', () => {
    it('adds no clock key: the runners pin every pipeline themselves', async () => {
        // A producer and a consumer get the same treatment — a producer left on
        // its own base-time would break the stamps for everything downstream.
        for (const pipeline of ['srtsrc ! queue ! tee name=busout_41000', 'fakesrc ! fakesink']) {
            const sent = await resolve({ pipeline }, {});
            expect(Object.keys(sent!).sort()).toEqual(['latchRepair', 'pipeline']);
        }
    });

    it('drops preserveSourceTimeline — the mechanism the producer stamps replaced', async () => {
        // Both are timeline mechanisms and they do not compose. The latch
        // cannot change what a consumer sees (its constant pad offset cancels
        // in the egress stamper's `anchor + (PES − firstPES)`), but it DOES
        // answer a source discontinuity by erroring the pipeline out to
        // re-latch, where the stamper re-anchors in place.
        const sent = await resolve(
            {
                pipeline: 'unixfdsrc ! tsdemux name=demux ! fakesink',
                preserveSourceTimeline: { demux: 'demux' },
            },
            {},
        );
        expect(sent!.preserveSourceTimeline).toBeUndefined();
    });

    it('keeps alignBranchesToStamps — it is anchored to the producer stamps', async () => {
        // A multi-input mux's branches each zero their own timeline off the ONE
        // bus buffer their tsdemux locked on; this is where that mapping is put
        // back.
        const sent = await resolve(
            {
                pipeline: 'unixfdsrc ! tsdemux name=demux_0 ! mpegtsmux name=mux',
                alignBranchesToStamps: { demuxes: ['demux_0', 'demux_1'] },
            },
            {},
        );
        expect(sent!.alignBranchesToStamps).toEqual({ demuxes: ['demux_0', 'demux_1'] });
    });

    it('keeps houseTimelineEgress — the identity stamp rides the producer stamps too', async () => {
        const sent = await resolve(
            {
                pipeline:
                    'unixfdsrc ! tsdemux ! avdec_aac ! avenc_s302m ! mpegtsmux ! tee name=busout_1',
                houseTimelineEgress: true,
            },
            {},
        );
        expect(sent!.houseTimelineEgress).toBe(true);
    });

    it('keeps liveCaptureClock for the runner to read', async () => {
        const sent = await resolve(
            { pipeline: 'v4l2src ! mpegtsmux ! tee name=busout_1', liveCaptureClock: true },
            {},
        );
        expect(sent!.liveCaptureClock).toBe(true);
    });
});

describe('latch repair (ADR-0005 note 2026-09-05)', () => {
    const desc = (): PipelineDescription => ({ pipeline: 'fakesrc ! fakesink' });

    it('is resolved from the graph: ON below a live source', async () => {
        const sent = await resolve(desc(), {
            instanceId: 'mpegts-muxer-1',
            mediaRouter: {
                getUpstreamBusProducers: () => [
                    { pluginId: 'ts-splitter', deliveryLead: false },
                    { pluginId: 'srt-input', deliveryLead: false },
                ],
            } as never,
        });
        expect(sent!.latchRepair).toBe(true);
    });

    it('...and OFF anywhere below a producer that declares a delivery lead (hls-player)', async () => {
        const sent = await resolve(desc(), {
            instanceId: 'mpegts-muxer-1',
            mediaRouter: {
                getUpstreamBusProducers: () => [
                    { pluginId: 'ts-splitter', deliveryLead: false },
                    { pluginId: 'hls-player', deliveryLead: true },
                ],
            } as never,
        });
        expect(sent!.latchRepair).toBe(false);
    });

    it('MR_LATCH_REPAIR=0 turns it OFF for every producer (operator kill-switch for the conditioner)', async () => {
        const prev = process.env.MR_LATCH_REPAIR;
        process.env.MR_LATCH_REPAIR = '0';
        try {
            const sent = await resolve(
                { pipeline: 'udpsrc ! tee name=busout_1' },
                {
                    instanceId: 'mpegts-ip-input-1',
                    mediaRouter: { getUpstreamBusProducers: () => [] } as never,
                },
            );
            expect(sent!.latchRepair).toBe(false);
        } finally {
            if (prev === undefined) delete process.env.MR_LATCH_REPAIR;
            else process.env.MR_LATCH_REPAIR = prev;
        }
    });
});
