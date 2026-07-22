import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SrtOutputModule } from './SrtOutputModule.js';

// pollStats logic moved to packages/engine/src/plugins/srtHelpers.ts (SrtStatPoller)
// and is covered by srtHelpers.test.ts. These tests focus on what the module
// still owns directly: pipeline construction and the static status fields.

function makeModule(opts: { upstream?: { port?: number; socketPath?: string } | null; instanceId?: string } = {}) {
    const module = new SrtOutputModule() as any;
    const upstream =
        opts.upstream === null
            ? null
            : {
                  port: opts.upstream?.port ?? 41000,
                  socketPath: opts.upstream?.socketPath ?? '/tmp/mr-bus-41000-abc123.sock',
              };
    const getModuleBusSource = vi.fn(() =>
        upstream === null
            ? undefined
            : {
                  ...upstream,
                  connectionId: 'c-up',
                  sourceModuleId: 'src-1',
                  sourcePortId: 'mpegts-out',
              },
    );
    module.services = {
        instanceId: opts.instanceId ?? 'srt-out-1',
        mediaRouter: { getModuleBusSource },
    };
    module.config = {};
    module.log = { info: vi.fn(), warn: vi.fn() };

    const setStatusData = vi.fn();
    const setBadge = vi.fn();
    module.setStatusData = setStatusData;
    module.setBadge = setBadge;
    return { module, getModuleBusSource, setStatusData, setBadge };
}

describe('SrtOutputModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null + logs info when no upstream MPEG-TS source is connected', () => {
        const { module } = makeModule({ upstream: null });
        expect(module.buildPipeline({})).toBeNull();
        expect(module.log.info).toHaveBeenCalledWith(expect.stringContaining('No MPEG-TS source'));
    });

    it('builds default caller-mode URI with sensible defaults', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain(
            'unixfdsrc socket-path=/tmp/mr-bus-41000-abc123.sock' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0',
        );
        expect(desc!.pipeline).not.toContain('udpsrc');
        // Passthrough by default — no TS re-parsing (safest for lossy live streams).
        expect(desc!.pipeline).not.toContain('tsparse');
        expect(desc!.pipeline).toContain('srtsink name=sink uri="srt://0.0.0.0:9000?mode=caller&latency=125"');
    });

    it('inserts tsparse only when a wire datagram size is explicitly forced', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({ packetsPerDatagram: 0 }).pipeline).not.toContain('tsparse');
        expect(module.buildPipeline({ packetsPerDatagram: 7 }).pipeline).toContain(
            'tsparse alignment=7 set-timestamps=false',
        );
        expect(module.buildPipeline({ packetsPerDatagram: 1 }).pipeline).toContain(
            'tsparse alignment=1 set-timestamps=false',
        );
    });

    it('includes streamId, passphrase, and pbkeylen when configured', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            host: '198.51.100.10',
            port: 4200,
            mode: 'listener',
            latency: 200,
            streamId: 'mr/out-a',
            passphrase: 'shared-secret',
            pbKeyLen: 16,
        });
        expect(desc!.pipeline).toContain('srt://198.51.100.10:4200?');
        expect(desc!.pipeline).toContain('mode=listener');
        expect(desc!.pipeline).toContain('latency=200');
        expect(desc!.pipeline).toContain('streamid=mr/out-a');
        expect(desc!.pipeline).toContain('passphrase=shared-secret');
        expect(desc!.pipeline).toContain('pbkeylen=16');
    });

    it('omits streamId/passphrase/pbkeylen params when not set', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).not.toContain('streamid=');
        expect(desc!.pipeline).not.toContain('passphrase=');
        expect(desc!.pipeline).not.toContain('pbkeylen=');
    });

    it('disables srtsink auto-reconnect and sets sync/wait-for-connection false', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('auto-reconnect=false');
        expect(desc!.pipeline).toContain('sync=false');
        expect(desc!.pipeline).toContain('wait-for-connection=false');
    });

    it('sets a NON-leaky relay queue + correct restart backoff window', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        // Non-leaky: a leaky shed on a muxed TS byte stream cuts mid-packet —
        // receiver-visible corruption. Hold + back-pressure instead.
        expect(desc!.pipeline).toContain('queue leaky=0 max-size-time=200000000');
        expect(desc!.restartOnError).toBe(true);
        expect(desc!.restartBackoffMs).toEqual({ baseMs: 5000, maxMs: 10000 });
    });
});

describe('SrtOutputModule.updateStatusData', () => {
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
        module.config = { mode: 'caller' };
        module.updateStatusData();
        expect(setBadge).not.toHaveBeenCalledWith('encrypted', expect.anything());
    });

    it('reports the configured connection info in the connection section', () => {
        const { module, setStatusData } = makeModule();
        module.config = { mode: 'listener', host: '1.2.3.4', port: 4200, passphrase: 'secret' };
        module.updateStatusData();
        expect(setStatusData).toHaveBeenCalledWith('connection', {
            mode: 'listener',
            host: '1.2.3.4',
            port: 4200,
            encrypted: 'Yes',
        });
    });
});
