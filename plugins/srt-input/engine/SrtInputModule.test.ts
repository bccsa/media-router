import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    GstPluginBase,
    ModuleInstance,
    PluginLoader,
    REDACTED,
    redactSecrets,
} from '@media-router/engine';
import { SrtInputModule } from './SrtInputModule.js';

// pollStats logic moved to packages/engine/src/plugins/srtHelpers.ts (SrtStatPoller)
// and is covered by srtHelpers.test.ts. These tests focus on what the module
// still owns directly: pipeline construction and the static status fields.
// `as any` lets us reach private fields/methods on the module without
// re-declaring them in a typed intersection (TS would collapse the
// intersection to `never` over private members).

function makeModule(opts: { udpPort?: number | null; instanceId?: string } = {}) {
    const module = new SrtInputModule() as any;
    const udpPort = opts.udpPort === undefined ? 41000 : opts.udpPort;
    const assignBusChannel = vi.fn(() => (udpPort === null ? null : { port: udpPort }));
    const getBusChannel = vi.fn(() => (udpPort === null ? undefined : { port: udpPort }));
    module.services = {
        instanceId: opts.instanceId ?? 'srt-in-1',
        mediaRouter: { assignBusChannel, getBusChannel },
    };
    module.config = {};
    module.log = { warn: vi.fn(), debug: vi.fn() };

    const setStatusData = vi.fn();
    const setBadge = vi.fn();
    module.setStatusData = setStatusData;
    module.setBadge = setBadge;
    return { module, assignBusChannel, getBusChannel, setStatusData, setBadge };
}

describe('SrtInputModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null + warns when no UDP port is assigned', () => {
        const { module } = makeModule({ udpPort: null });
        expect(module.buildPipeline({})).toBeNull();
        expect(module.log.warn).toHaveBeenCalledWith(expect.stringContaining('No UDP port'));
    });

    it('builds default listener-mode URI with sensible defaults', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain(
            'srtsrc name=src uri="srt://0.0.0.0:9000?mode=listener&latency=125"',
        );
        expect(desc!.pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'mrlateness name=lat_busout_41000 reference=running-time ! tee name=busout_41000 allow-not-linked=true',
        );
        expect(desc!.pipeline).not.toContain('udpsink');
    });

    it('includes streamId, passphrase, and pbkeylen when configured', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            host: '203.0.113.5',
            port: 4200,
            mode: 'caller',
            latency: 200,
            streamId: 'mr/feed-a',
            passphrase: 'shared-secret',
            pbKeyLen: 16,
        });
        expect(desc!.pipeline).toContain('srt://203.0.113.5:4200?');
        expect(desc!.pipeline).toContain('mode=caller');
        expect(desc!.pipeline).toContain('latency=200');
        expect(desc!.pipeline).toContain('streamid=mr/feed-a');
        expect(desc!.pipeline).toContain('passphrase=shared-secret');
        expect(desc!.pipeline).toContain('pbkeylen=16');
    });

    // Test secrets, unique so the test output can be searched for them; srtsrc keeps a passphrase
    // typed with a space, `;` or `'` whole, so its logged form must hold none of it.
    it.each([
        ['as one word', 'zq109-srt-in-V5g1'],
        ['with a space', 'zq109-srt-in-sp-B2c4 zq109-srt-in-sp-D6f8'],
        ['with a ;', 'zq109-srt-in-sc-F1g3;zq109-srt-in-sc-H5j7'],
        ["with a '", "zq109-srt-in-qt-K9m2'zq109-srt-in-qt-L4n6"],
    ])(
        'logs a passphrase typed %s as <redacted>, the pipeline keeps it (B-109)',
        (_kind, passphrase) => {
            const { module } = makeModule();
            const desc = module.buildPipeline({
                mode: 'caller',
                host: 'srt-peer.example',
                port: 4200,
                passphrase,
                pbKeyLen: 16,
            });
            const pipeline: string = desc!.pipeline;
            expect(pipeline.includes(`&passphrase=${passphrase}&pbkeylen=16"`)).toBe(true);
            const logged = redactSecrets(pipeline);
            expect(logged.includes('zq109')).toBe(false);
            expect(logged).toBe(pipeline.replace(passphrase, REDACTED));
        },
    );

    it('omits streamId/passphrase/pbkeylen params when not set or zero', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ mode: 'rendezvous' });
        expect(desc!.pipeline).not.toContain('streamid=');
        expect(desc!.pipeline).not.toContain('passphrase=');
        expect(desc!.pipeline).not.toContain('pbkeylen=');
    });

    it('disables srtsrc auto-reconnect (CPU spike when peer unreachable)', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('auto-reconnect=false');
    });

    it('keeps listening after the caller drops (listener mode)', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ mode: 'listener' });
        expect(desc!.pipeline).toContain('auto-reconnect=false keep-listening=true');
    });

    it('does not set keep-listening in caller mode', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ mode: 'caller', host: '10.9.16.22' });
        expect(desc!.pipeline).toContain('mode=caller');
        expect(desc!.pipeline).not.toContain('keep-listening');
    });

    it('sets the leaky queue + correct restart backoff window', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('queue leaky=2');
        expect(desc!.restartOnError).toBe(true);
        expect(desc!.restartBackoffMs).toEqual({ baseMs: 5000, maxMs: 10000 });
    });
});

describe('SrtInputModule.updateStatusData', () => {
    beforeEach(() => vi.clearAllMocks());

    it('sets the encrypted badge when a passphrase is configured', () => {
        const { module, setBadge } = makeModule();
        module.config = { mode: 'caller', host: '1.2.3.4', port: 4200, passphrase: 'secret' };
        module.updateStatusData();
        expect(setBadge).toHaveBeenCalledWith(
            'encrypted',
            expect.objectContaining({ icon: 'lock', text: 'AES' }),
        );
    });

    it('does not set the encrypted badge without a passphrase', () => {
        const { module, setBadge } = makeModule();
        module.config = { mode: 'listener' };
        module.updateStatusData();
        expect(setBadge).not.toHaveBeenCalledWith('encrypted', expect.anything());
    });

    it('reports the configured connection info in the connection section', () => {
        const { module, setStatusData } = makeModule();
        module.config = { mode: 'caller', host: '1.2.3.4', port: 4200, passphrase: 'secret' };
        module.updateStatusData();
        expect(setStatusData).toHaveBeenCalledWith('connection', {
            mode: 'caller',
            host: '1.2.3.4',
            port: 4200,
            encrypted: 'Yes',
        });
    });
});

// --- On the restamp (house-clock plan WI-P1-10) -----------------------------------------------

const MS = 1_000_000;
const CH = {
    stats: 'mrtsrestamp-stats:restamp',
    pid: 'mrtsrestamp-pid:restamp',
    event: 'mrtsrestamp-event:restamp',
};
/** The element's messages as the runner forwards them (plan ch. 5 part 10). */
const stats = (o: Record<string, unknown> = {}) => ({
    program: 1,
    state: 'locked',
    reason: 'none',
    ppb: 1234,
    'residual-p99-ns': 4 * MS,
    'pcr-interval-max-ns': 40 * MS,
    relocks: 0,
    'cadence-warning': false,
    'cc-lost': 0,
    'desync-bytes': 0,
    ...o,
});
const pidMsg = (pid: number, type: number) => ({
    program: 1,
    pid,
    'stream-type': type,
    'lead-min-ns': 300 * MS,
    'lead-median-ns': 340 * MS,
    'lead-max-ns': 420 * MS,
    'trim-ns': 0,
    'shift-ns': 0,
    'dropped-pes': 0,
});
const DEGRADED = 'Degraded clock: PCR frozen — timing from PID 0x0100 PTS against arrival';
const factories = (pipeline: string) => pipeline.split(' ! ').map((el) => el.split(' ')[0]);
/** Smoothing Cooldown as the loader injects it (b95s): minutes, 5 by default, live. */
const COOLDOWN_SCHEMA = {
    type: 'number',
    default: 5,
    minimum: 0,
    maximum: 60,
    'x-unit': 'min',
    'x-live': true,
    title: 'Smoothing Cooldown',
};

/** A playing module on the base's own state methods: what its card shows is `getState()`. */
function cardModule() {
    const module = new SrtInputModule() as any;
    module.services = {
        instanceId: 'srt-in-1',
        mediaRouter: { assignBusChannel: vi.fn(), getBusChannel: vi.fn(() => ({ port: 41000 })) },
    };
    module.config = {};
    module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    module.health = 'ok';
    return module;
}
const sectionIds = (module: any) =>
    module.getState().dynamicStatusSections.map((s: { id: string }) => s.id);
/** One report interval: stats and the video PID, then the reporter's tick. */
function report(module: any, s: Record<string, unknown> = {}) {
    module.dispatchPluginEvent(CH.stats, stats(s));
    module.dispatchPluginEvent(CH.pid, pidMsg(256, 0x1b));
    module.ingestTiming.tick();
}

describe('SrtInputModule on the restamp (WI-P1-10)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('restamps right after srtsrc, before the queue and the bus sink', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(factories(desc!.pipeline)).toEqual([
            'srtsrc',
            'mrtsrestamp',
            'queue',
            'capssetter',
            'capsfilter',
            'mrlateness',
            'tee',
        ]);
        expect(desc!.pipeline).toContain(
            ' ! mrtsrestamp name=restamp clock-mode=stc smoothing-cooldown-ns=300000000000 ' +
                'offset-ns=0 ! queue leaky=2 ',
        );
        expect(desc!.busReports).toEqual([
            { element: 'restamp', structure: 'mrtsrestamp-stats' },
            { element: 'restamp', structure: 'mrtsrestamp-pid' },
            { element: 'restamp', structure: 'mrtsrestamp-event' },
        ]);
    });

    it('starts the restamp on the configured offset, trims and smoothing cooldown', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            ingestOffsetMs: -250,
            pidTrimsMs: { 257: 40, 256: -12 },
            smoothingCooldownMin: 10,
        });
        expect(desc!.pipeline).toContain(
            'mrtsrestamp name=restamp clock-mode=stc smoothing-cooldown-ns=600000000000 ' +
                'offset-ns=-250000000 pid-trims="256=-12000000;257=40000000" ! queue',
        );
    });

    it("is the string the ingest-restamp protocol case runs behind srt-input's queue", () => {
        // gst_ingest_restamp_test.py copies the queue (plan ch. 5 part 7.3 b): it must not drift.
        const py = readFileSync(
            join(
                __dirname,
                '../../../packages/engine/src/child-process/gst_ingest_restamp_test.py',
            ),
            'utf8',
        );
        const queue = /^SRT_QUEUE = "(.+)"$/m.exec(py)?.[1];
        expect(queue).toMatch(/^queue /);
        const { module } = makeModule();
        expect(module.buildPipeline({})!.pipeline).toContain(
            `offset-ns=0 ! ${queue} ! capssetter `,
        );
    });

    it('a live edit of O, a trim or the cooldown sets the restamp property, with no restart', async () => {
        const { module } = makeModule();
        const setElementProperty = vi.fn(async () => {});
        module.setElementProperty = setElementProperty;
        const instance = new ModuleInstance('srt-in-1', 'srt-input', module, {});
        await instance.applyConfigUpdate({ ingestOffsetMs: 500 });
        expect(setElementProperty).toHaveBeenCalledWith('restamp', 'offset-ns', 500_000_000);
        await instance.applyConfigUpdate({ pidTrimsMs: { 257: -40 } });
        expect(setElementProperty).toHaveBeenLastCalledWith(
            'restamp',
            'pid-trims',
            '257=-40000000',
        );
        await instance.applyConfigUpdate({ smoothingCooldownMin: 0 });
        expect(setElementProperty).toHaveBeenLastCalledWith('restamp', 'smoothing-cooldown-ns', 0);
        expect(setElementProperty).toHaveBeenCalledTimes(3);
        expect(instance.getState().pendingRestart).toBe(false);
        // A later rebuild starts on the edited values.
        expect(module.buildPipeline(module.config)!.pipeline).toContain(
            'smoothing-cooldown-ns=0 offset-ns=500000000 pid-trims="257=-40000000"',
        );
    });

    it('declares ingest timing: the loader adds O, the trims and the cooldown, each live here', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'srt-input-manifest-'));
        try {
            mkdirSync(join(dir, 'srt-input'));
            copyFileSync(join(__dirname, '../package.json'), join(dir, 'srt-input/package.json'));
            const loader = new PluginLoader(dir);
            await loader.load();
            const props = (loader.getPluginSchemas()['srt-input'] as any).properties;
            expect(props.ingestOffsetMs).toMatchObject({ minimum: -10000, maximum: 10000 });
            expect(props.pidTrimsMs).toMatchObject({
                'x-widget': 'pidTrim',
                'x-optionsFrom': 'pids',
            });
            expect(props.smoothingCooldownMin).toMatchObject(COOLDOWN_SCHEMA);
            const live = Object.keys(props).filter((k) => props[k]['x-live'] === true);
            expect(live).toEqual(
                expect.arrayContaining(['ingestOffsetMs', 'pidTrimsMs', 'smoothingCooldownMin']),
            );
            expect(new SrtInputModule().getLiveUpdatableParams()).toEqual(
                expect.arrayContaining(live),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("shows the restamp's card from start to stop, beside the caller sections", async () => {
        vi.useFakeTimers();
        // The base's start spawns a runner; a bare emitter stands in for it.
        const child = Object.assign(new EventEmitter(), { stop: vi.fn(async () => {}) });
        vi.spyOn(GstPluginBase.prototype, 'onStart').mockImplementation(async function (this: any) {
            this.childProcess = child;
        });
        const module = cardModule();
        await module.onStart();
        module.dispatchPluginEvent(CH.stats, stats());
        module.dispatchPluginEvent(CH.pid, pidMsg(256, 0x1b));
        expect(sectionIds(module)).toEqual([]);
        vi.advanceTimersByTime(2000); // the reporter's tick
        const state = module.getState();
        expect(state.badges).toContainEqual({
            id: 'clock',
            icon: 'clock',
            text: 'Locked',
            color: '#10b981',
        });
        expect(state.statusData.clock).toMatchObject({ state: 'Locked', sourceRate: 1.23 });
        expect(state.statusData['pid-256']).toMatchObject({ lead: '300 / 340 / 420' });
        expect(state.fieldOptions.pids).toEqual([{ value: '256', label: '0x0100 H.264 video' }]);

        // A listener's callers come and go with every poll; the clock's sections stay.
        module.running = true;
        module.getElementStats = vi.fn(async () => ({ callers: [{ 'bytes-received': 1000 }] }));
        await module.statPoller.poll();
        expect(sectionIds(module)).toEqual(['caller-0', 'clock', 'pid-256']);
        // ...and the clock's publication keeps the callers, in the same order.
        report(module, { state: 'acquiring' });
        expect(sectionIds(module)).toEqual(['caller-0', 'clock', 'pid-256']);
        expect(module.getState().statusData['caller-0']).toBeDefined();
        // The runner going down drops the callers, not the clock (it reads No PCR when stale).
        child.emit('stateChange', { state: 'error' });
        expect(sectionIds(module)).toEqual(['clock', 'pid-256']);

        // Every program stopped reporting (its PIDs report on): the badge is withdrawn.
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(2000);
            module.dispatchPluginEvent(CH.pid, pidMsg(256, 0x1b));
        }
        vi.advanceTimersByTime(2000);
        expect(module.getState().badges.map((b: { id: string }) => b.id)).not.toContain('clock');

        // Stopped: the card is cleared and nothing publishes any more.
        await module.onStop();
        module.dispatchPluginEvent(CH.stats, stats());
        vi.advanceTimersByTime(4000);
        expect(module.getState().badges).toEqual([]);
        expect(sectionIds(module)).toEqual([]);
    });

    it('logs the restamp events, and leaves other plugin events alone', () => {
        const module = cardModule();
        module.dispatchPluginEvent(CH.event, { kind: 'relock', program: 1, reason: 'leap' });
        expect(module.log.info).toHaveBeenCalledWith(
            { 'mrtsrestamp-event': { kind: 'relock', program: 1, reason: 'leap' } },
            'mrtsrestamp-event relock (leap)',
        );
        module.dispatchPluginEvent('mrtsrestamp-stats:other', stats());
        module.ingestTiming.tick();
        expect(sectionIds(module)).toEqual([]);
    });

    it('raises the degraded clock as a warning and withdraws only its own text', () => {
        const module = cardModule();
        module.dispatchPluginEvent(CH.event, {
            kind: 'degraded',
            program: 1,
            pid: 256,
            reason: 'freeze',
        });
        report(module, { state: 'degraded', reason: 'freeze' });
        expect([module.health, module.error]).toEqual(['warning', DEGRADED]);
        // A second condition replaces the clock's own text.
        const sparse = {
            'cadence-warning': true,
            'pcr-gap-max-ns': 700 * MS,
            'pcr-cadence-ns': 40 * MS,
        };
        report(module, { state: 'degraded', reason: 'freeze', ...sparse });
        expect(module.error).toMatch(
            /^Degraded clock: .*; PCR comes irregularly: gaps up to 700 ms, normally every 40 ms$/,
        );
        report(module);
        expect([module.health, module.error]).toEqual(['ok', undefined]);

        // Another warning since then owns the health text: the clock's clear leaves it.
        report(module, { state: 'degraded', reason: 'freeze' });
        module.setHealth('warning', 'Waiting for upstream module(s): x');
        report(module);
        expect([module.health, module.error]).toEqual([
            'warning',
            'Waiting for upstream module(s): x',
        ]);
    });

    it('a clock warning hidden by another, or raised during a fault, shows again at ok', () => {
        const module = cardModule();
        report(module, { state: 'degraded', reason: 'freeze' });
        module.setHealth('warning', 'Waiting for upstream module(s): x');
        module.setHealth('ok');
        expect([module.health, module.error]).toEqual([
            'warning',
            expect.stringMatching(/^Degraded clock: PCR frozen/),
        ]);

        // A fault outranks it; the PLAYING after the restart puts it back.
        const faulted = cardModule();
        faulted.setHealth('error', 'srtsrc: connection failed');
        report(faulted, { state: 'degraded', reason: 'freeze' });
        expect([faulted.health, faulted.error]).toEqual(['error', 'srtsrc: connection failed']);
        faulted.health = 'ok'; // what the base's PLAYING sets before its hook
        faulted.error = undefined;
        faulted.onPipelinePlaying();
        expect(faulted.health).toBe('warning');
        expect(faulted.error).toMatch(/^Degraded clock: PCR frozen/);
    });
});
