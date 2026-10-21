import { describe, it, expect } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import type { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { ModuleServices, PipelineDescription } from './PluginModule.js';

/** What `GstPluginBase.applyTimeSync` does to a description on both the start and the refresh
 *  path. Every pipeline runs on the house clock (§4.1) and every egress is stamped by identity
 *  (plan ch. 6 WI-P2-3); the runners need no field for either, so nothing is added here. */
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
    it('adds nothing: the runners pin the clock and stamp every egress themselves', async () => {
        // An ingest, a transform producer and a consumer get the same treatment: the
        // description goes out as the module built it.
        for (const pipeline of [
            'srtsrc ! queue ! tee name=busout_41000',
            'unixfdsrc ! tsdemux ! mpegtsmux ! tee name=busout_41001',
            'fakesrc ! fakesink',
        ]) {
            const sent = await resolve({ pipeline }, {});
            expect(Object.keys(sent!)).toEqual(['pipeline']);
        }
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

    it('keeps liveCaptureClock for the runner to read', async () => {
        const sent = await resolve(
            { pipeline: 'v4l2src ! mpegtsmux ! tee name=busout_1', liveCaptureClock: true },
            {},
        );
        expect(sent).toEqual({
            pipeline: 'v4l2src ! mpegtsmux ! tee name=busout_1',
            liveCaptureClock: true,
        });
    });
});
