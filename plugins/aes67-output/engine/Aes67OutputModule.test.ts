import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { HouseEpoch, TimeSyncState } from '@media-router/engine';
import { Aes67OutputModule } from './Aes67OutputModule.js';

// `as any` reaches private fields/methods without re-declaring them in a typed
// intersection (TS collapses such intersections to `never` over privates).
function makeModule(opts: { source?: boolean } = {}) {
    const module = new Aes67OutputModule() as any;
    const source =
        opts.source === false ? undefined : { port: 41000, socketPath: '/run/mr/edge.sock' };
    module.services = {
        instanceId: 'aes67-out-1',
        mediaRouter: { getModuleBusSource: vi.fn(() => source) },
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    module.setStatusData = vi.fn();
    module.setHealth = vi.fn();
    module.setBadge = vi.fn();
    module.clearBadge = vi.fn();
    return module;
}

const DEST = { address: '239.69.0.1', port: 5004 };

describe('Aes67OutputModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('is idle until a 302M source is wired in', () => {
        const module = makeModule({ source: false });
        expect(module.buildPipeline(DEST)).toBeNull();
        expect(module.setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No 302M source'),
        );
    });

    it('refuses to send with no destination', () => {
        const module = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(module.setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('No destination'),
        );
    });

    it('builds the bus → AES67 chain', () => {
        const module = makeModule();
        const desc = module.buildPipeline(DEST);
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('unixfdsrc name=busin');
        expect(desc!.pipeline).toContain('tsdemux latency=0 ! audio/x-smpte-302m ! avdec_s302m');
        expect(desc!.pipeline).toContain(
            'audio/x-raw,format=S24BE,rate=48000,channels=2,layout=interleaved',
        );
        expect(desc!.pipeline).toContain('rtpL24pay name=pay pt=96 mtu=1452');
        expect(desc!.pipeline).toContain('udpsink name=netsink host=239.69.0.1 port=5004');
        // Egress lateness is read right before the wire (WI-P0-8).
        expect(desc!.pipeline).toContain(
            'mrlateness name=lat_egress reference=running-time ! udpsink name=netsink',
        );
        expect(desc!.restartOnError).toBe(true);
    });

    it('pins the packet time at both ends so the payloader cannot coalesce', () => {
        const module = makeModule();
        expect(module.buildPipeline(DEST)!.pipeline).toContain(
            'min-ptime=1000000 max-ptime=1000000',
        );
        expect(module.buildPipeline({ ...DEST, ptimeMs: 0.25 })!.pipeline).toContain(
            'min-ptime=250000 max-ptime=250000',
        );
    });

    it('marks the media DSCP EF by default, and honours an override', () => {
        const module = makeModule();
        expect(module.buildPipeline(DEST)!.pipeline).toContain('qos-dscp=46');
        expect(module.buildPipeline({ ...DEST, dscp: 34 })!.pipeline).toContain('qos-dscp=34');
        expect(module.buildPipeline({ ...DEST, dscp: -1 })!.pipeline).toContain('qos-dscp=-1');
    });

    it('uses multicast TTL and the chosen NIC for a group, plain TTL for a host', () => {
        const module = makeModule();
        const mc = module.buildPipeline({ ...DEST, interface: 'eth0', ttl: 8 });
        expect(mc!.pipeline).toContain('multicast-iface=eth0');
        expect(mc!.pipeline).toContain('auto-multicast=true ttl-mc=8');
        const uni = module.buildPipeline({
            address: '10.9.1.42',
            port: 5004,
            interface: 'eth0',
            ttl: 8,
        });
        expect(uni!.pipeline).toContain(' ttl=8');
        expect(uni!.pipeline).not.toContain('multicast-iface');
    });

    it('switches the whole chain to L16 together', () => {
        const module = makeModule();
        const desc = module.buildPipeline({ ...DEST, encoding: 'L16' });
        expect(desc!.pipeline).toContain('format=S16BE');
        expect(desc!.pipeline).toContain('rtpL16pay');
        expect(desc!.pipeline).not.toContain('L24');
    });

    it('refuses a packet time that cannot fit the MTU instead of fragmenting it', () => {
        // 4 ms of stereo L24 is 1152 B of payload; a 576 B MTU would have the
        // payloader split it into something no AES67 receiver expects.
        const module = makeModule();
        expect(module.buildPipeline({ ...DEST, ptimeMs: 4, mtu: 576 })).toBeNull();
        expect(module.setHealth).toHaveBeenCalledWith('error', expect.stringContaining('1152 B'));
    });

    describe('pacing', () => {
        it('paces against the house clock', () => {
            // The payloader emits one buffer per packet time; without a syncing
            // sink they leave in decode-sized bursts.
            const module = makeModule();
            const desc = module.buildPipeline({ ...DEST, senderLatencyMs: 15 });
            expect(desc!.pipeline).toContain('sync=true max-lateness=-1 ts-offset=15000000');
        });

        it('is NOT the route playout offset D', () => {
            // D would delay the egress by ~300 ms, spending the receiver's link
            // offset on our side of the wire while the RTP timestamps (which
            // carry the alignment) stay unchanged. Default is 20 ms, not 300.
            const module = makeModule();
            expect(module.buildPipeline(DEST)!.pipeline).toContain('ts-offset=20000000');
        });
    });

    describe('PTP epoch stamping', () => {
        it('leaves the payloader on its random RFC 3550 offset when the epoch is unknown', () => {
            const module = makeModule();
            module.epoch = null;
            expect(module.buildPipeline(DEST)!.pipeline).not.toContain('timestamp-offset');
        });

        it("pins timestamp-offset to the claimed epoch's offset", () => {
            const module = makeModule();
            module.epoch = { rtpTimestampOffset: 123456789, taiOffsetS: 37, seq: 1, source: 'ptp' };
            expect(module.buildPipeline(DEST)!.pipeline).toContain('timestamp-offset=123456789');
        });

        it('warns when ptpSync was asked for but the epoch could not be claimed', () => {
            // The failure that must never be silent: announcing a PTP media
            // clock we do not have is undetectable at the receiver.
            const module = makeModule();
            module.epoch = null;
            module.epochError = 'kernel TAI offset unset, epoch untraceable';
            module.buildPipeline({ ...DEST, ptpSync: true });
            expect(module.setHealth).toHaveBeenCalledWith(
                'warning',
                expect.stringContaining('untraceable'),
            );
        });
    });
});

/** A house clock the test drives: the engine's E, its traceability and events. */
function fakeClock(ep: Partial<HouseEpoch> | null, state: Partial<TimeSyncState> = {}) {
    const clock = new EventEmitter() as EventEmitter & {
        current: HouseEpoch | null;
        st: Partial<TimeSyncState>;
        ready: () => Promise<HouseEpoch | null>;
        epoch: () => HouseEpoch | null;
        state: () => TimeSyncState;
    };
    clock.current = ep
        ? {
              eNs: E,
              seq: 1,
              latchedAtMonoNs: 1n,
              traceable: true,
              reason: 'start',
              source: 'ptp',
              taiOffsetS: 37,
              ...ep,
          }
        : null;
    clock.st = { sidecar: true, source: 'ptp', taiOffsetS: 37, ...state };
    clock.ready = async () => clock.current;
    clock.epoch = () => clock.current;
    clock.state = () => clock.st as TimeSyncState;
    return clock;
}

const E = 1_789_775_770_559_436_728n;

describe('Aes67OutputModule — the engine house epoch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does nothing at all when ptpSync is off', async () => {
        const module = makeModule();
        module.services.houseClock = fakeClock({});
        module.config = { ptpSync: false };
        await module.resolveEpoch();
        expect(module.epoch).toBeNull();
        expect(module.epochError).toBe('');
    });

    it("claims the engine's E as timestamp-offset when the epoch is traceable", async () => {
        const module = makeModule();
        module.services.houseClock = fakeClock({ seq: 3, source: 'chrony' });
        module.config = { ptpSync: true };
        await module.resolveEpoch();
        expect(module.epoch).toMatchObject({
            rtpTimestampOffset: 1301132260,
            seq: 3,
            source: 'chrony',
        });
        expect(module.buildPipeline(DEST)!.pipeline).toContain('timestamp-offset=1301132260');
    });

    it('free-runs, and says why, when the epoch is untraceable', async () => {
        const cases: Array<[Partial<TimeSyncState>, RegExp]> = [
            [{ source: 'none' }, /source none/],
            [{ taiOffsetS: 0 }, /TAI offset unset/],
            [{}, /not synchronised/],
        ];
        for (const [state, why] of cases) {
            const module = makeModule();
            module.services.houseClock = fakeClock({ traceable: false }, state);
            module.config = { ptpSync: true };
            await module.resolveEpoch();
            expect(module.epoch).toBeNull();
            expect(module.epochError).toMatch(why);
            expect(module.buildPipeline({ ...DEST, ptpSync: true })!.pipeline).not.toContain(
                'timestamp-offset',
            );
        }
    });

    it('free-runs with no epoch at all (mr-clockstate missing, or no house clock)', async () => {
        const module = makeModule();
        module.config = { ptpSync: true };
        module.services.houseClock = fakeClock(null, { sidecar: false });
        await module.resolveEpoch();
        expect(module.epochError).toMatch(/mr-clockstate missing/);
        delete module.services.houseClock;
        await module.resolveEpoch();
        expect(module.epochError).toMatch(/no engine house clock/);
    });

    it("restarts on an 'epoch' event so the new timestamp-offset lands", async () => {
        const module = makeModule();
        const clock = fakeClock({});
        module.services.houseClock = clock;
        module.config = { ptpSync: true };
        await module.resolveEpoch();
        module.running = true;
        module.onStop = vi.fn(async () => {});
        module.onStart = vi.fn(async () => {});
        clock.on('epoch', module.onClockChange);

        clock.current = { ...clock.current!, eNs: E + 2_000_000_000n, seq: 2, reason: 'step' };
        clock.emit('epoch', clock.current);
        await module.epochRestart;
        expect(module.onStop).toHaveBeenCalledOnce();
        expect(module.onStart).toHaveBeenCalledOnce();
    });

    it('keeps the claim when sync is lost (E unchanged), and restarts when sync arrives', async () => {
        const module = makeModule();
        const clock = fakeClock({});
        module.services.houseClock = clock;
        module.config = { ptpSync: true };
        await module.resolveEpoch();
        module.running = true;
        module.onStop = vi.fn(async () => {});
        module.onStart = vi.fn(async () => {});

        clock.current = { ...clock.current!, traceable: false };
        module.onClockChange();
        expect(module.onStop).not.toHaveBeenCalled();
        expect(module.setStatusData).toHaveBeenCalledWith(
            'clock',
            expect.objectContaining({ epoch: expect.stringContaining('sync lost'), epochSeq: 1 }),
        );

        // Free-running sender (untraceable start), then sync arrives: claim it.
        module.epoch = null;
        clock.current = { ...clock.current!, traceable: true };
        module.onClockChange();
        await module.epochRestart;
        expect(module.onStart).toHaveBeenCalledOnce();
    });

    it('does not revive a module the engine stopped during the restart', async () => {
        const module = makeModule();
        const clock = fakeClock({});
        module.services.houseClock = clock;
        module.config = { ptpSync: true };
        await module.resolveEpoch();
        module.running = true;
        module.onStart = vi.fn(async () => {});
        module.onStop = vi.fn(async () => {
            module.externalStop = true; // the engine's own stop landed meanwhile
        });
        clock.current = { ...clock.current!, eNs: E + 5_000_000n, seq: 2 };
        module.onClockChange();
        await module.epochRestart;
        expect(module.onStart).not.toHaveBeenCalled();
    });

    it('shows seq and source in the clock section', async () => {
        const module = makeModule();
        module.services.houseClock = fakeClock({ seq: 4 }, { source: 'chrony' });
        module.config = { ...DEST, ptpSync: true };
        await module.resolveEpoch();
        module.updateStatusData();
        expect(module.setStatusData).toHaveBeenCalledWith(
            'clock',
            expect.objectContaining({ epochSeq: 4, timeSource: 'chrony' }),
        );
    });
});
