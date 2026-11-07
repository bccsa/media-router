import { describe, it, expect, vi, afterEach } from 'vitest';
import { setLogTap } from '@media-router/shared-types';
import {
    parseServerCookie,
    parseDeviceBlock,
    parseDeviceChannels,
    parseDeviceSampleRate,
    parseDeviceVolumes,
    PA_VOLUME_NORM,
    AudioDeviceOps,
    DEFAULT_DEVICE_CACHE_TTL_MS,
} from './AudioDeviceOps.js';
import { PactlNoAnswer } from './PaCommandQueue.js';

const STALE_LOG =
    'PipeWire does not answer pactl: device lists stay as it last answered, marked stale, until it does';

/** The listed devices of a listing PipeWire answered. */
async function answered(ops: AudioDeviceOps) {
    const listing = await ops.deviceListing();
    expect(listing.stale).toBeNull();
    return listing.devices!;
}

describe('parseDeviceChannels', () => {
    it('reads `Channel Map: mono` as 1 channel — fixes the mono-USB-mic-as-2ch bug where the active stereo profile mis-reports the spec', () => {
        const block = `Name: alsa_input.usb-mono\nChannel Map: mono\nSample Specification: s16le 2ch 48000Hz`;
        // Sample Specification says 2ch (active profile is stereo) but the
        // Channel Map says mono. Channel Map is authoritative — the device
        // is genuinely a mono mic, the second channel is just a duplicate.
        expect(parseDeviceChannels(block)).toBe(1);
    });
    it('counts comma-separated entries in `Channel Map:` for stereo', () => {
        const block = `Channel Map: front-left,front-right`;
        expect(parseDeviceChannels(block)).toBe(2);
    });
    it('counts entries for surround (5.1)', () => {
        const block = `Channel Map: front-left,front-right,front-center,lfe,rear-left,rear-right`;
        expect(parseDeviceChannels(block)).toBe(6);
    });
    it('falls back to `Sample Specification:` when `Channel Map:` is absent', () => {
        const block = `Sample Specification: s16le 2ch 48000Hz`;
        expect(parseDeviceChannels(block)).toBe(2);
    });
    it('returns undefined when neither field is parseable', () => {
        const block = `Name: foo\nDescription: bar`;
        expect(parseDeviceChannels(block)).toBeUndefined();
    });
    it('tolerates leading/trailing whitespace in Channel Map values', () => {
        const block = `Channel Map:   front-left , front-right  `;
        expect(parseDeviceChannels(block)).toBe(2);
    });
});

describe('parseDeviceSampleRate', () => {
    it('reads sample rate from `Sample Specification:`', () => {
        const block = `Sample Specification: s16le 2ch 48000Hz`;
        expect(parseDeviceSampleRate(block)).toBe(48000);
    });
    it('returns undefined when the spec line is missing — common for SUSPENDED devices', () => {
        const block = `Name: alsa_input.suspended\nChannel Map: mono`;
        expect(parseDeviceSampleRate(block)).toBeUndefined();
    });
});

describe('parseDeviceVolumes', () => {
    // Verbatim from `pactl list sinks` on a Shure MVX2U sitting at the
    // restored 40% that this fix exists to correct.
    const shure = [
        '\tMute: no',
        '\tVolume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB',
        '\t        balance 0.00',
        '\tBase Volume: 65536 / 100% / 0.00 dB',
    ].join('\n');

    it('reads one raw value per channel', () => {
        expect(parseDeviceVolumes(shure)).toEqual([26214, 26214]);
    });
    it('does not mistake `Base Volume:` for the current volume', () => {
        // Base Volume is always 65536; reading it would make an attenuated
        // device look like it is already at unity and skip the reset.
        expect(parseDeviceVolumes('\tBase Volume: 65536 / 100% / 0.00 dB')).toEqual([]);
    });
    it('reads a mono device as a single channel', () => {
        expect(parseDeviceVolumes('\tVolume: mono: 65536 / 100% / 0.00 dB')).toEqual([
            PA_VOLUME_NORM,
        ]);
    });
    it('reads all six channels of a surround device', () => {
        const line =
            '\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB,   ' +
            'front-center: 65536 / 100% / 0.00 dB,   lfe: 65536 / 100% / 0.00 dB,   ' +
            'rear-left: 65536 / 100% / 0.00 dB,   rear-right: 65536 / 100% / 0.00 dB';
        expect(parseDeviceVolumes(line)).toHaveLength(6);
    });
    it('returns an empty array when the block has no volume line', () => {
        expect(parseDeviceVolumes('Name: alsa_output.foo\nChannel Map: mono')).toEqual([]);
    });
});

describe('parseDeviceBlock', () => {
    it('returns null for blocks without a `Name:` field (e.g. blank trailing block)', () => {
        expect(parseDeviceBlock('', 'source')).toBeNull();
        expect(parseDeviceBlock('Description: nothing here', 'source')).toBeNull();
    });
    it('skips `.monitor` sources but keeps real sources', () => {
        const monitor = `Name: alsa_output.usb-mono.monitor\nChannel Map: mono`;
        const real = `Name: alsa_input.usb-mono\nChannel Map: mono`;
        expect(parseDeviceBlock(monitor, 'source')).toBeNull();
        expect(parseDeviceBlock(real, 'source')).not.toBeNull();
    });
    it('skips Media Router-owned modules (MR_PW_ prefix)', () => {
        const block = `Name: MR_PW_remap.module-1\nChannel Map: front-left,front-right`;
        expect(parseDeviceBlock(block, 'source')).toBeNull();
        expect(parseDeviceBlock(block, 'sink')).toBeNull();
    });
    it('returns a SUSPENDED device with channels but no sample rate — critical for the audio-input flow which probes just-selected devices that are still suspended', () => {
        const block = `Name: alsa_input.usb-mono\nDescription: USB PnP Mono\nChannel Map: mono`;
        const dev = parseDeviceBlock(block, 'source');
        expect(dev).not.toBeNull();
        expect(dev!.channels).toBe(1);
        expect(dev!.sampleRate).toBeUndefined();
        expect(dev!.description).toBe('USB PnP Mono');
    });
    it('carries per-channel volumes through so the normalizer can act on them', () => {
        const block = [
            'Name: alsa_output.usb-shure',
            'Channel Map: front-left,front-right',
            '\tVolume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB',
        ].join('\n');
        expect(parseDeviceBlock(block, 'sink')!.volumes).toEqual([26214, 26214]);
    });
    it('falls back to `name` for description when missing', () => {
        const block = `Name: alsa_input.foo\nChannel Map: mono`;
        const dev = parseDeviceBlock(block, 'source');
        expect(dev!.description).toBe('alsa_input.foo');
    });
    it('honours the `direction` argument so the same parser handles sources and sinks', () => {
        const block = `Name: alsa_output.foo\nChannel Map: mono`;
        expect(parseDeviceBlock(block, 'source')!.direction).toBe('source');
        expect(parseDeviceBlock(block, 'sink')!.direction).toBe('sink');
    });
    it('keeps a `.monitor` entry when listing sinks (the `.monitor` skip is source-only — sinks are never monitors)', () => {
        // Note: sinks don't have `.monitor` siblings — they ARE the
        // master devices that monitors hang off. `.monitor` would only
        // appear in the source list, so the skip is direction-scoped.
        const block = `Name: alsa_output.foo.monitor\nChannel Map: front-left,front-right`;
        // In the sink direction this name shouldn't appear, but if it
        // did we wouldn't filter it out — that's intentional.
        expect(parseDeviceBlock(block, 'sink')).not.toBeNull();
    });
});

describe('AudioDeviceOps listing cache', () => {
    const SOURCES = [
        'Source #1',
        '\tName: alsa_input.usb-mic',
        '\tDescription: USB Mic',
        '\tChannel Map: front-left,front-right',
    ].join('\n');
    const SINKS = [
        'Sink #2',
        '\tName: alsa_output.usb-dac',
        '\tDescription: USB DAC',
        '\tChannel Map: front-left,front-right',
    ].join('\n');

    function makeOps(cacheTtlMs?: number) {
        let t = 1_000_000;
        const execImmediateAsync = vi.fn(async (args: string[]) =>
            args[1] === 'sources' ? SOURCES : SINKS,
        );
        const queue = { execImmediateAsync, onMutation: null as (() => void) | null };
        const ops = new AudioDeviceOps(queue as never, { cacheTtlMs, now: () => t });
        return { ops, execImmediateAsync, queue, advance: (ms: number) => (t += ms) };
    }

    it('reuses one pactl snapshot for every reader inside the TTL', async () => {
        const { ops, execImmediateAsync } = makeOps();
        expect(await ops.hasDevice('alsa_input.usb-mic')).toBe(true);
        expect((await ops.getDeviceInfo('alsa_output.usb-dac'))?.channels).toBe(2);
        expect(await answered(ops)).toHaveLength(2);
        // sources + sinks, once — not once per reader.
        expect(execImmediateAsync).toHaveBeenCalledTimes(2);
    });

    it('lists sources first, then sinks', async () => {
        const { ops } = makeOps();
        expect((await answered(ops)).map((d) => d.name)).toEqual([
            'alsa_input.usb-mic',
            'alsa_output.usb-dac',
        ]);
    });

    it('re-fetches once the TTL has elapsed (hot-plug is still seen)', async () => {
        const { ops, execImmediateAsync, advance } = makeOps();
        await answered(ops);
        advance(DEFAULT_DEVICE_CACHE_TTL_MS - 1);
        await answered(ops);
        expect(execImmediateAsync).toHaveBeenCalledTimes(2);
        advance(1);
        await answered(ops);
        expect(execImmediateAsync).toHaveBeenCalledTimes(4);
    });

    it('drops the snapshot when a queued (mutating) pactl command settles', async () => {
        const { ops, execImmediateAsync, queue } = makeOps();
        await answered(ops);
        expect(queue.onMutation).toBeTypeOf('function');
        queue.onMutation!();
        await answered(ops);
        expect(execImmediateAsync).toHaveBeenCalledTimes(4);
    });

    it('hands out a copy, so a caller mutating the list cannot poison later readers', async () => {
        const { ops } = makeOps();
        (await answered(ops)).length = 0;
        expect(await answered(ops)).toHaveLength(2);
    });

    it('caches nothing when cacheTtlMs is 0', async () => {
        const { ops, execImmediateAsync } = makeOps(0);
        await answered(ops);
        await answered(ops);
        expect(execImmediateAsync).toHaveBeenCalledTimes(4);
    });
});

const MIC = 'Source #1\n\tName: alsa_input.usb-mic\n\tChannel Map: mono';
/** pactl's timeout, as PaCommandQueue reports it. */
const noAnswer = () =>
    new PactlNoAnswer('pactl command failed: pactl list sources\nno answer within 5000 ms');
/** pactl with nothing on the socket: it fails at once. */
const refused = () =>
    new Error('pactl command failed: pactl list sources\nConnection failure: Connection refused');

/** A queue whose pactl answers when the test says: `answer()` / `fail()` the calls asked so far. */
function pendingOps() {
    let t = 1_000_000;
    const pending: Array<{ args: string[]; ok: (s: string) => void; no: (e: Error) => void }> = [];
    let running = 0;
    let most = 0;
    const execImmediateAsync = vi.fn(
        (args: string[]) =>
            new Promise<string>((ok, no) => {
                most = Math.max(most, ++running);
                const done =
                    <T>(f: (v: T) => void) =>
                    (v: T) => {
                        running -= 1;
                        f(v);
                    };
                pending.push({ args, ok: done(ok), no: done(no) });
            }),
    );
    const queue = { execImmediateAsync, onMutation: null as (() => void) | null };
    const ops = new AudioDeviceOps(queue as never, { now: () => t });
    const flush = () => new Promise((r) => setImmediate(r));
    // Each first lets the calls asked so far reach pactl, then answers them.
    const answer = async (
        out: (args: string[]) => string = (args) => (args[1] === 'sources' ? MIC : ''),
    ) => {
        await flush();
        for (const c of pending.splice(0)) c.ok(out(c.args));
        await flush();
    };
    const fail = async (err: () => Error = noAnswer) => {
        await flush();
        for (const c of pending.splice(0)) c.no(err());
        await flush();
    };
    return {
        ops,
        queue,
        execImmediateAsync,
        pending,
        answer,
        fail,
        flush,
        most: () => most,
        now: () => t,
        advance: (ms: number) => (t += ms),
    };
}

describe('AudioDeviceOps: a listing that waits for PipeWire (B-200)', () => {
    const makeOps = pendingOps;
    const lines: Array<{ level: number; msg: string }> = [];
    afterEach(() => {
        setLogTap(null);
        lines.length = 0;
    });

    it('readers while it waits share it; no answer yet changes nothing; the answer reaches all', async () => {
        const { ops, execImmediateAsync, answer, flush } = makeOps();
        const first = ops.hasDevice('alsa_input.usb-mic');
        const second = ops.getDeviceInfo('alsa_input.usb-mic');
        await flush();
        expect(execImmediateAsync).toHaveBeenCalledTimes(2); // sources and sinks, once
        expect(ops.isAvailable()).toBe(true); // still the last answer's
        await answer();
        expect(await first).toBe(true);
        expect(await second).toEqual({ channels: 1, sampleRate: undefined });
    });

    it('no answer in time: unknown, not empty, one warning; the next answer is seen', async () => {
        setLogTap((l) => lines.push(JSON.parse(l)));
        const { ops, answer, fail, flush, advance } = makeOps();
        for (let i = 0; i < 3; i++) {
            const present = ops.hasDevice('alsa_input.usb-mic');
            await fail();
            expect(await present).toBeNull(); // unknown (B-207), never absent
            expect(ops.isAvailable()).toBe(false);
            advance(DEFAULT_DEVICE_CACHE_TTL_MS);
        }
        const back = ops.hasDevice('alsa_input.usb-mic');
        await answer();
        expect(await back).toBe(true);
        expect(ops.isAvailable()).toBe(true);
        await flush();
        expect(lines.map((l) => [l.level, l.msg])).toEqual([
            [40, STALE_LOG],
            [30, 'PipeWire answers pactl again'],
        ]);
    });

    it('a mutation while one waits: the next reader gets a listing that starts after it, never alongside', async () => {
        const { ops, queue, execImmediateAsync, answer, flush, most } = makeOps();
        const before = ops.hasDevice('alsa_input.usb-mic');
        await flush();
        queue.onMutation!(); // e.g. a remap-source loaded while the listing waits
        const after = ops.hasDevice('alsa_input.usb-mic');
        await flush();
        expect(execImmediateAsync).toHaveBeenCalledTimes(2); // the second waits for the first
        await answer();
        expect(await before).toBe(true);
        expect(execImmediateAsync).toHaveBeenCalledTimes(4);
        await answer(() => ''); // the device left meanwhile
        expect(await after).toBe(false);
        expect(most()).toBe(2); // one listing (its two lists) at a time
    });

    it('pactl info: one call at a time while it waits, however long', async () => {
        const { ops, execImmediateAsync, answer, flush, advance } = makeOps();
        const first = ops.daemonInstance();
        advance(3 * DEFAULT_DEVICE_CACHE_TTL_MS);
        const second = ops.daemonInstance();
        await flush();
        expect(execImmediateAsync).toHaveBeenCalledTimes(1);
        await answer(() => 'Cookie: f196:62ca');
        expect(await first).toBe('f196:62ca');
        expect(await second).toBe('f196:62ca');
    });
});

describe('AudioDeviceOps: while PipeWire gives no answer, its last list, marked stale (B-207)', () => {
    const TTL = DEFAULT_DEVICE_CACHE_TTL_MS;
    const mic = { name: 'alsa_input.usb-mic', direction: 'source', channels: 1 };

    it('no answer: the last answer, "PipeWire not answering" since the first listing without one; the device unknown; the next answer clears it', async () => {
        const { ops, answer, fail, advance, now } = pendingOps();
        const first = ops.deviceListing();
        await answer();
        expect(await first).toMatchObject({ devices: [mic], stale: null });
        advance(TTL);
        const askedAt = now();
        const hung = ops.deviceListing();
        await fail(noAnswer);
        const stale = { reason: 'PipeWire not answering', since: askedAt };
        expect(await hung).toMatchObject({ devices: [mic], stale });
        expect(await ops.hasDevice(mic.name)).toBeNull();
        expect(await ops.getDeviceInfo(mic.name)).toBeNull();
        expect(ops.isAvailable()).toBe(false);
        // Later listings without an answer keep the outage's start.
        advance(3 * TTL);
        const still = ops.deviceListing();
        await fail(noAnswer);
        expect(await still).toMatchObject({ devices: [mic], stale });
        // The next answer is the list, even an emptier one.
        advance(TTL);
        const back = ops.deviceListing();
        await answer(() => '');
        expect(await back).toEqual({ devices: [], stale: null });
        expect(await ops.hasDevice(mic.name)).toBe(false);
        expect(ops.isAvailable()).toBe(true);
    });

    it('a pactl that fails at once is "PipeWire not running"; a hang after it is its own, since its own first listing', async () => {
        const { ops, answer, fail, advance, now } = pendingOps();
        const first = ops.deviceListing();
        await answer();
        await first;
        advance(TTL);
        const downAt = now();
        const down = ops.deviceListing();
        await fail(refused);
        expect(await down).toMatchObject({
            devices: [mic],
            stale: { reason: 'PipeWire not running', since: downAt },
        });
        expect(await ops.hasDevice(mic.name)).toBeNull();
        advance(TTL);
        const hungAt = now();
        const hung = ops.deviceListing();
        await fail(noAnswer);
        expect(await hung).toMatchObject({
            devices: [mic],
            stale: { reason: 'PipeWire not answering', since: hungAt },
        });
    });

    it('never answered: no list, unknown rather than none', async () => {
        const { ops, fail, now } = pendingOps();
        const listing = ops.deviceListing();
        await fail(noAnswer);
        expect(await listing).toEqual({
            devices: null,
            stale: { reason: 'PipeWire not answering', since: now() },
        });
        expect(await ops.hasDevice(mic.name)).toBeNull();
    });

    it('one list answered and the other not is no answer: the last whole list, never half of a new one', async () => {
        const { ops, answer, pending, flush, advance } = pendingOps();
        const first = ops.deviceListing();
        await answer();
        await first;
        advance(TTL);
        const next = ops.deviceListing();
        await flush();
        for (const c of pending.splice(0)) {
            if (c.args[1] === 'sources')
                c.ok('Source #9\n\tName: alsa_input.other\n\tChannel Map: mono');
            else c.no(noAnswer());
        }
        expect(await next).toMatchObject({
            devices: [mic],
            stale: { reason: 'PipeWire not answering' },
        });
    });

    it('hands out a copy of a stale list too', async () => {
        const { ops, answer, fail, advance } = pendingOps();
        const first = ops.deviceListing();
        await answer();
        await first;
        advance(TTL);
        const hung = ops.deviceListing();
        await fail();
        (await hung).devices!.length = 0;
        expect((await ops.deviceListing()).devices).toHaveLength(1);
    });
});

describe('AudioDeviceOps: which PipeWire answers, and whether it does (B-195)', () => {
    // `pactl info` against a private PipeWire 1.2.7 daemon on the dev Pi (its pw-cli cookie 4053164746).
    const INFO = [
        'Server String: unix:/run/user/1000/pulse/native',
        'Server Name: PulseAudio (on PipeWire 1.2.7)',
        'Default Sample Specification: float32le 2ch 48000Hz',
        'Cookie: f196:62ca',
    ].join('\n');

    function makeOps() {
        let t = 1_000_000;
        const pw = { up: true, info: INFO };
        const execImmediateAsync = vi.fn(async (args: string[]) => {
            if (!pw.up)
                throw new Error('pactl command failed: Connection failure: Connection refused');
            return args[0] === 'info' ? pw.info : 'Source #1\n\tName: alsa_input.usb-mic';
        });
        const queue = { execImmediateAsync, onMutation: null as (() => void) | null };
        const ops = new AudioDeviceOps(queue as never, { now: () => t });
        return { ops, pw, execImmediateAsync, advance: (ms: number) => (t += ms) };
    }

    const lines: Array<{ level: number; msg: string }> = [];
    const flush = () => new Promise((r) => setImmediate(r));
    afterEach(() => {
        setLogTap(null);
        lines.length = 0;
    });

    it('reads the daemon cookie from pactl info, null when it has none', () => {
        expect(parseServerCookie(INFO)).toBe('f196:62ca');
        expect(parseServerCookie('Server Name: PulseAudio')).toBeNull();
    });

    it('reads it once per TTL without blocking, a new one after a restart', async () => {
        const { ops, pw, execImmediateAsync, advance } = makeOps();
        expect(await ops.daemonInstance()).toBe('f196:62ca');
        expect(await ops.daemonInstance()).toBe('f196:62ca');
        expect(execImmediateAsync).toHaveBeenCalledTimes(1);
        pw.info = INFO.replace('f196:62ca', '7e8b:4a20');
        advance(DEFAULT_DEVICE_CACHE_TTL_MS);
        expect(await ops.daemonInstance()).toBe('7e8b:4a20');
    });

    it('PipeWire down: unknown daemon, devices unknown, not available; one line down and one back', async () => {
        setLogTap((l) => lines.push(JSON.parse(l)));
        const { ops, pw, advance } = makeOps();
        expect(ops.isAvailable()).toBe(true);
        pw.up = false;
        for (let i = 0; i < 20; i++) {
            advance(DEFAULT_DEVICE_CACHE_TTL_MS);
            expect(await ops.daemonInstance()).toBeNull();
            expect(await ops.hasDevice('alsa_input.usb-mic')).toBeNull();
        }
        expect(ops.isAvailable()).toBe(false);
        pw.up = true;
        advance(DEFAULT_DEVICE_CACHE_TTL_MS);
        expect(await ops.hasDevice('alsa_input.usb-mic')).toBe(true);
        expect(ops.isAvailable()).toBe(true);
        await flush();
        expect(lines.map((l) => [l.level, l.msg])).toEqual([
            [40, STALE_LOG],
            [30, 'PipeWire answers pactl again'],
        ]);
    });
});
