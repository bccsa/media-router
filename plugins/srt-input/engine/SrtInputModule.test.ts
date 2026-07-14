import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    const assignUdpPort = vi.fn(() =>
        udpPort === null ? null : { host: '239.255.0.1', port: udpPort },
    );
    const getUdpEndpoint = vi.fn(() =>
        udpPort === null ? undefined : { host: '239.255.0.1', port: udpPort },
    );
    module.services = {
        instanceId: opts.instanceId ?? 'srt-in-1',
        mediaRouter: { assignUdpPort, getUdpEndpoint },
    };
    module.config = {};
    module.log = { warn: vi.fn(), debug: vi.fn() };

    const setStatusData = vi.fn();
    const setBadge = vi.fn();
    module.setStatusData = setStatusData;
    module.setBadge = setBadge;
    return { module, assignUdpPort, getUdpEndpoint, setStatusData, setBadge };
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
        expect(desc!.pipeline).toContain('srtsrc name=src uri="srt://0.0.0.0:9000?mode=listener&latency=125"');
        // Depacketize inbound SRT to standard 188-byte TS packets on the internal bus.
        expect(desc!.pipeline).toContain('tsparse alignment=1 set-timestamps=false');
        expect(desc!.pipeline).toContain('udpsink');
        expect(desc!.pipeline).toContain('port=41000');
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
