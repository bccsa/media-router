import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { REDACTED, quoteGstString, redactSecrets } from '@media-router/engine';
import { SrtOutputModule } from './SrtOutputModule.js';

/** Each character a passphrase or stream ID may hold, and its percent-encoded form (B-112). */
const SPECIAL: Array<[string, string]> = [
    ['#', '%23'],
    ['&', '%26'],
    ['"', '%22'],
    [' ', '%20'],
    [';', '%3B'],
    ['%', '%25'],
    ['+', '%2B'],
    ['=', '%3D'],
    ['?', '%3F'],
    ['/', '%2F'],
    ['\\', '%5C'],
    ["'", "'"],
    ['é', '%C3%A9'],
    ['中', '%E4%B8%AD'],
    ['\u{1F600}', '%F0%9F%98%80'],
];

/** The query of srtsink's `uri` as GstUri reads it: one launch-string token, its query up to a `#`
 *  split at each `&`, then at the first `=`, each value percent-decoded. */
function srtQuery(pipeline: string): Record<string, string> {
    const uri = / uri="([^"\\\s]*)"(?:\s|$)/.exec(pipeline)?.[1];
    expect(uri).toBeDefined();
    const query = uri!.slice(uri!.indexOf('?') + 1).split('#')[0];
    return Object.fromEntries(
        query.split('&').map((kv) => {
            const eq = kv.indexOf('=');
            return [kv.slice(0, eq), decodeURIComponent(kv.slice(eq + 1))];
        }),
    );
}

// pollStats logic moved to packages/engine/src/plugins/srtHelpers.ts (SrtStatPoller)
// and is covered by srtHelpers.test.ts. These tests focus on what the module
// still owns directly: pipeline construction and the static status fields.

function makeModule(
    opts: { upstream?: { port?: number; socketPath?: string } | null; instanceId?: string } = {},
) {
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
                ' ! mrlateness name=lat_busin_41000_676b67 reference=house' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000',
        );
        expect(desc!.pipeline).not.toContain('udpsrc');
        // No tsparse by default (ADR-0011): bus buffers are one access unit
        // each and srtsink slices them to its 1316 B payload size itself —
        // measured 2026-09-02, full rate, no datagram over 1316 B.
        expect(desc!.pipeline).not.toContain('tsparse');
        expect(desc!.pipeline).toContain(
            'mrlateness name=lat_egress reference=running-time ! srtsink name=sink uri="srt://0.0.0.0:9000?mode=caller&latency=125"',
        );
    });

    it('appends maxbw=0 to the URI only when unpaced is on (sender pacing off)', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({ unpaced: true }).pipeline).toContain('&maxbw=0"');
        expect(module.buildPipeline({ unpaced: false }).pipeline).not.toContain('maxbw');
        expect(module.buildPipeline({}).pipeline).not.toContain('maxbw');
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
        expect(desc!.pipeline).toContain('streamid=mr%2Fout-a');
        expect(desc!.pipeline).toContain('passphrase=shared-secret');
        expect(desc!.pipeline).toContain('pbkeylen=16');
    });

    // B-112: each character, percent-encoded as `encodeURIComponent` writes it.
    it.each(SPECIAL)(
        'puts a passphrase and a stream ID holding %s into the URI percent-encoded (B-112)',
        (ch, encoded) => {
            const { module } = makeModule();
            const passphrase = `zq112-out-${ch}-M5d3`;
            const streamId = `#!::r=live/${ch},m=publish`;
            const pipeline: string = module.buildPipeline({
                mode: 'caller',
                host: 'srt-peer.example',
                port: 4200,
                streamId,
                passphrase,
                pbKeyLen: 16,
                unpaced: true,
            }).pipeline;
            expect(pipeline).toContain(
                `?mode=caller&latency=125&streamid=%23!%3A%3Ar%3Dlive%2F${encoded}%2Cm%3Dpublish` +
                    `&passphrase=zq112-out-${encoded}-M5d3&pbkeylen=16&maxbw=0" sync=false`,
            );
            // What srtsink reads out of the URI: each value as typed.
            expect(srtQuery(pipeline)).toEqual({
                mode: 'caller',
                latency: '125',
                streamid: streamId,
                passphrase,
                pbkeylen: '16',
                maxbw: '0',
            });
            const logged = redactSecrets(pipeline);
            expect(logged.includes('zq112')).toBe(false);
            expect(logged).toBe(pipeline.replace(`zq112-out-${encoded}-M5d3`, REDACTED));
        },
    );

    // Test secrets, unique so the test output can be searched for them; srtsink keeps a passphrase
    // typed with a space, `;` or `'` whole, so its logged form must hold none of it.
    it.each([
        ['as one word', 'zq109-srt-out-J6e4'],
        ['with a space', 'zq109-srt-out-sp-P3q5 zq109-srt-out-sp-S7t9'],
        ['with a ;', 'zq109-srt-out-sc-U2w4;zq109-srt-out-sc-X6y8'],
        ["with a '", "zq109-srt-out-qt-Z1a3'zq109-srt-out-qt-C5e7"],
    ])(
        'logs a passphrase typed %s as <redacted>, the pipeline keeps it (B-109)',
        (_kind, passphrase) => {
            const { module } = makeModule();
            const desc = module.buildPipeline({
                mode: 'caller',
                host: 'srt-peer.example',
                port: 4200,
                streamId: 'mr/out-a',
                passphrase,
            });
            const pipeline: string = desc!.pipeline;
            const encoded = encodeURIComponent(passphrase);
            expect(pipeline.includes(`&passphrase=${encoded}"`)).toBe(true);
            const logged = redactSecrets(pipeline);
            expect(logged.includes('zq109')).toBe(false);
            expect(logged).toBe(pipeline.replace(encoded, REDACTED));
        },
    );

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

// --- On a real srtsink (B-112) -----------------------------------------------------------------

const HAVE_SRT = ['srtsrc', 'srtsink'].every(
    (el) => spawnSync('gst-inspect-1.0', ['--exists', el], { timeout: 60_000 }).status === 0,
);

/** A UDP port free on 127.0.0.1 right now. */
function freeUdpPort(): Promise<number> {
    const s = createSocket('udp4');
    return new Promise((resolve) =>
        s.bind(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        }),
    );
}

/** gst-launch-1.0 on a description, no shell between: its exit code, null once killed, and its
 *  stderr. Its argv is the description split at each space outside double quotes, as a shell would. */
function launch(desc: string, env?: Record<string, string>) {
    const argv = desc.match(/(?:[^\s"]+|"(?:[^"\\]|\\.)*")+/g) ?? [];
    let stderr = '';
    let done: (code: number | null) => void = () => {};
    const exit = new Promise<number | null>((r) => (done = r));
    const p = execFile(
        'gst-launch-1.0',
        ['-q', ...argv],
        { env: { ...process.env, ...env } },
        (err, _stdout, errOut) => {
            stderr = String(errOut);
            done(err ? (typeof err.code === 'number' ? err.code : null) : 0);
        },
    );
    return { exit, kill: () => p.kill('SIGKILL'), stderr: () => stderr };
}

/** Whether `listener`, which ends after a few buffers, receives them from `caller` within `ms`, and
 *  the listener's log; a caller that ends first (the listener not up yet, or refused) starts again.
 *  The listener logs each caller's stream ID (srtobject at debug level). */
async function receives(listener: string, caller: string, ms: number) {
    const rx = launch(listener, { GST_DEBUG: 'srtobject:5', GST_DEBUG_NO_COLOR: '1' });
    let ended: number | null | undefined;
    void rx.exit.then((code) => (ended = code));
    const deadline = Date.now() + ms;
    while (ended === undefined && Date.now() < deadline) {
        const tx = launch(caller);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise(
            (r) => (timer = setTimeout(r, Math.max(0, deadline - Date.now()))),
        );
        await Promise.race([tx.exit, rx.exit, late]);
        clearTimeout(timer);
        tx.kill();
        await tx.exit;
    }
    rx.kill();
    await rx.exit;
    return { received: ended === 0, log: rx.stderr() };
}

describe.skipIf(!HAVE_SRT)('SrtOutputModule on a real srtsink (B-112)', () => {
    // Every character of SPECIAL; the listener is given the passphrase as typed, as a property.
    const PASSPHRASE = `zq112-e2e ${SPECIAL.map(([ch]) => ch).join('')} out-V2k7`;
    const STREAM_ID = `#!::r=live/feed a,m=publish&x="1";%41 é`;

    async function callerAndListener(listenerPassphrase: string) {
        const port = await freeUdpPort();
        const { module } = makeModule();
        const pipeline: string = module.buildPipeline({
            mode: 'caller',
            host: '127.0.0.1',
            port,
            streamId: STREAM_ID,
            passphrase: PASSPHRASE,
            pbKeyLen: 16,
        }).pipeline;
        const srtsink = pipeline.split(' ! ').find((el) => el.startsWith('srtsink '));
        expect(srtsink).toMatch(/^srtsink name=sink uri="srt:\/\/127\.0\.0\.1:/);
        return {
            caller: `fakesrc is-live=true sizetype=fixed sizemax=1316 datarate=1316000 ! ${srtsink}`,
            listener:
                `srtsrc uri="srt://127.0.0.1:${port}?mode=listener&latency=125&pbkeylen=16" ` +
                `passphrase=${quoteGstString(listenerPassphrase)} num-buffers=20 ! fakesink sync=false`,
        };
    }

    it('its caller reaches a listener given the passphrase as typed, and its stream ID arrives whole', async () => {
        const { caller, listener } = await callerAndListener(PASSPHRASE);
        const { received, log } = await receives(listener, caller, 15_000);
        expect(received).toBe(true);
        expect(log).toContain(`streamid: ${STREAM_ID}\n`);
    }, 30_000);

    it('a listener whose passphrase is one character longer receives nothing', async () => {
        const { caller, listener } = await callerAndListener(`${PASSPHRASE}x`);
        expect((await receives(listener, caller, 4_000)).received).toBe(false);
    }, 30_000);
});
