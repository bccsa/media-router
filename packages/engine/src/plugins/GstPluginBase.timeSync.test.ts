import { describe, it, expect, vi } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import type { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { ModuleServices, PipelineDescription } from './PluginModule.js';

/**
 * Precedence between the two time-sync modes, resolved in one place
 * (`GstPluginBase.applyTimeSync`) for both the start and the refresh path.
 *
 * The engine-wide contract SUPERSEDES the per-module `clockSync` opt-in and
 * applies to EVERY pipeline: each one is marked for the runner's monotonic
 * pinned-timeline path and the clock authority is never contacted (no daemon
 * spawn, no net-clock wait). Timing is a system property — a producer left on
 * its own base-time breaks the contract for every consumer downstream of it.
 * With the contract off the legacy path must be untouched — `clockSync` only,
 * same resolve, same best-effort fallbacks — because it is what the fleet runs
 * today.
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

const clockSyncDesc = (): PipelineDescription => ({
    pipeline: 'fakesrc ! fakesink',
    clockSync: true,
});

const authority = (config: { host: string; port: number } | null) => ({
    getClockConfig: vi.fn(async () => config),
});

describe('GstPluginBase time-sync mode resolution', () => {
    describe('contract mode ON', () => {
        it('marks the description for the contract and never resolves a net clock', async () => {
            const clockAuthority = authority({ host: '127.0.0.1', port: 5000 });
            const sent = await resolve(clockSyncDesc(), {
                timeSyncContract: true,
                clockAuthority: clockAuthority as unknown as ModuleServices['clockAuthority'],
            });
            expect(sent!.timeSyncContract).toBe(true);
            expect(sent!.clock).toBeUndefined();
            // The whole point: no daemon is spawned and nothing is waited on.
            expect(clockAuthority.getClockConfig).not.toHaveBeenCalled();
        });

        it('does not depend on a clock authority being present', async () => {
            // Contract mode means "no authority needed" — a services bag without
            // one (test harness, or an engine that never spawned it) must still
            // get the contract, not silently fall back to an unsynced pipeline.
            const sent = await resolve(clockSyncDesc(), { timeSyncContract: true });
            expect(sent!.timeSyncContract).toBe(true);
        });

        it('marks EVERY pipeline, not just the ones that opted into clockSync', async () => {
            // The gate gap that made Stage 1 a no-op end to end. The contract is
            // producer-stamped: a producer's bus PTS is house-clock media time
            // only if that producer's running-time IS house-clock time
            // (base_time=0). Only consumers set `clockSync`, so gating on it
            // pinned the consumers and left every producer on a per-start
            // base-time — the wire then carried `stamp + base_time` and nothing
            // downstream could tell.
            const sent = await resolve(
                { pipeline: 'srtsrc ! queue ! tee name=busout_41000' },
                { timeSyncContract: true },
            );
            expect(sent!.timeSyncContract).toBe(true);
            expect(sent!.clock).toBeUndefined();
        });

        it('drops preserveSourceTimeline — the mechanism the contract replaced', async () => {
            // Both are timeline mechanisms and they do not compose. The latch
            // cannot change what a consumer sees (its constant pad offset
            // cancels in the egress stamper's `anchor + (PES − firstPES)`), but
            // it DOES answer a source discontinuity by erroring the pipeline out
            // to re-latch — where the contract re-anchors in place. Leaving both
            // armed means the restart wins over the re-anchor, which is the
            // worse half of each mechanism. See applyTimeSync for the full
            // trace and ADR-0005's Stage 2 implementation notes.
            const sent = await resolve(
                {
                    pipeline: 'unixfdsrc ! tsdemux name=demux ! fakesink',
                    preserveSourceTimeline: { demux: 'demux' },
                },
                { timeSyncContract: true },
            );
            expect(sent!.timeSyncContract).toBe(true);
            expect(sent!.preserveSourceTimeline).toBeUndefined();
        });

        it('never resolves a net clock for a non-clockSync pipeline either', async () => {
            // Widening the gate must not widen what the contract COSTS: still no
            // daemon, still nothing waited on, for any pipeline.
            const clockAuthority = authority({ host: '127.0.0.1', port: 5000 });
            const sent = await resolve({ pipeline: 'fakesrc ! fakesink' }, {
                timeSyncContract: true,
                clockAuthority: clockAuthority as unknown as ModuleServices['clockAuthority'],
            });
            expect(sent!.timeSyncContract).toBe(true);
            expect(clockAuthority.getClockConfig).not.toHaveBeenCalled();
        });
    });

    describe('contract mode OFF — legacy clockSync path unchanged', () => {
        it('resolves the shared net clock from the clock authority', async () => {
            const clockAuthority = authority({ host: '127.0.0.1', port: 46008 });
            const sent = await resolve(clockSyncDesc(), {
                clockAuthority: clockAuthority as unknown as ModuleServices['clockAuthority'],
            });
            expect(sent!.clock).toEqual({ host: '127.0.0.1', port: 46008 });
            expect(sent!.timeSyncContract).toBeUndefined();
            expect(clockAuthority.getClockConfig).toHaveBeenCalledTimes(1);
        });

        it('an authority that cannot be brought up leaves the pipeline unsynced', async () => {
            const clockAuthority = authority(null);
            const sent = await resolve(clockSyncDesc(), {
                clockAuthority: clockAuthority as unknown as ModuleServices['clockAuthority'],
            });
            expect(sent!.clock).toBeUndefined();
            expect(sent!.timeSyncContract).toBeUndefined();
        });

        it('no authority at all is a no-op, not a failure', async () => {
            const sent = await resolve(clockSyncDesc(), {});
            expect(sent!.clock).toBeUndefined();
            expect(sent!.timeSyncContract).toBeUndefined();
        });

        it('keeps preserveSourceTimeline — it is the legacy timeline mechanism', async () => {
            // The other side of the drop above: with the contract off
            // (MR_TIME_SYNC_CONTRACT=0, the kill-switch) nothing about the
            // legacy path may change, and the latch is what carries the source
            // timeline there.
            const sent = await resolve(
                {
                    pipeline: 'unixfdsrc ! tsdemux name=demux ! fakesink',
                    preserveSourceTimeline: { demux: 'demux' },
                },
                {},
            );
            expect(sent!.preserveSourceTimeline).toEqual({ demux: 'demux' });
        });

        it('an explicit `timeSyncContract: false` keeps the legacy path', async () => {
            const clockAuthority = authority({ host: '127.0.0.1', port: 46008 });
            const sent = await resolve(clockSyncDesc(), {
                timeSyncContract: false,
                clockAuthority: clockAuthority as unknown as ModuleServices['clockAuthority'],
            });
            expect(sent!.clock).toEqual({ host: '127.0.0.1', port: 46008 });
            expect(sent!.timeSyncContract).toBeUndefined();
        });

        it('a non-sync pipeline never touches the authority', async () => {
            const clockAuthority = authority({ host: '127.0.0.1', port: 46008 });
            const sent = await resolve({ pipeline: 'fakesrc ! fakesink' }, {
                clockAuthority: clockAuthority as unknown as ModuleServices['clockAuthority'],
            });
            expect(sent!.clock).toBeUndefined();
            expect(clockAuthority.getClockConfig).not.toHaveBeenCalled();
        });
    });
});
