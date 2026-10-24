import { describe, it, expect } from 'vitest';
import { REDACTED, isSecretKey, redactSecrets, redactValue } from './redact.js';

// Test secrets (B-109): each one unique, so the whole test output can be searched for them.
const RIST = 'zq109-rist-K7v2';
const SRT = 'zq109-srt-pass-W4d9';
const PW = 'zq109-user-pw-L3s8';
const RTMP = 'zq109-rtmp-key-H2n5';
const BEARER = 'zq109.bearer.T9q4';
const CF = 'zq109-cf-token-Y8p1';
const SIG = 'zq109-sig-Q5a7';
// SRT passphrases typed with a space, a `;` and a `'` (srtsrc and srtsink keep them whole), each
// word marked.
const SRT_SPACE = 'zq109-sp-A6u2 zq109-sp-E3r7 zq109-sp-G5y2';
const SRT_SEMI = 'zq109-sc-H4k8;zq109-sc-M8w1;zq109-sc-T2v6';
const SRT_QUOTE = "zq109-qt-N7c3'zq109-qt-R5d9'zq109-qt-W1x4";
const SRT_INNER = 'zq109-in-B8d2;secret=zq109-in-F4h6';
const ALL = [RIST, SRT, PW, RTMP, BEARER, CF, SIG, SRT_SPACE, SRT_SEMI, SRT_QUOTE, SRT_INNER];

/** Passes when no test secret, nor a word of one, is in `text`; a failure names one by number. */
function expectClean(text: string): void {
    expect(ALL.flatMap((s, i) => (text.includes(s) ? [`test secret #${i}`] : []))).toEqual([]);
    expect(text.includes('zq109')).toBe(false);
}

describe('isSecretKey (B-109)', () => {
    it.each([
        'secret',
        'passphrase',
        'password',
        'user-pw',
        'proxy-pw',
        'TUNNEL_TOKEN',
        'accessToken',
        'apiKey',
        'stream_key',
        'X-Amz-Signature',
        'Authorization',
        'encryptionKey',
        'sig',
    ])('%s is a secret', (name) => expect(isSecretKey(name)).toBe(true));

    it.each([
        'gateKey',
        'pbKeyLen',
        'streamId',
        'cname',
        'encrypted',
        'keyLevel',
        'signal',
        'pass',
        'aes-type',
    ])('%s is not', (name) => expect(isSecretKey(name)).toBe(false));
});

describe('redactSecrets (B-109)', () => {
    it.each([
        [
            'a RIST secret in a launch string',
            `mrristsrc name=ristsrc urls="rist://@0.0.0.0:5004?cname=a" secret="${RIST}" aes-type=128 ! queue`,
            `mrristsrc name=ristsrc urls="rist://@0.0.0.0:5004?cname=a" secret="${REDACTED}" aes-type=128 ! queue`,
        ],
        [
            'a quoted value with escaped quotes and spaces',
            `mrristsink secret="say \\"${RIST}\\" there" profile=1`,
            `mrristsink secret="${REDACTED}" profile=1`,
        ],
        [
            'the SRT passphrase property',
            `srtsink name=sink passphrase="${SRT}" uri="srt://h:4200"`,
            `srtsink name=sink passphrase="${REDACTED}" uri="srt://h:4200"`,
        ],
        [
            'the SRT passphrase URI parameter, between others',
            `srtsrc uri="srt://h:4200?mode=caller&passphrase=${SRT}&pbkeylen=16" auto-reconnect=false`,
            `srtsrc uri="srt://h:4200?mode=caller&passphrase=${REDACTED}&pbkeylen=16" auto-reconnect=false`,
        ],
        [
            'the SRT passphrase URI parameter, first and last',
            `srt://h:4200?passphrase=${SRT}`,
            `srt://h:4200?passphrase=${REDACTED}`,
        ],
        [
            'an SRT passphrase typed with spaces, up to the next parameter',
            `srtsrc uri="srt://h:4200?mode=caller&passphrase=${SRT_SPACE}&pbkeylen=16" ! queue`,
            `srtsrc uri="srt://h:4200?mode=caller&passphrase=${REDACTED}&pbkeylen=16" ! queue`,
        ],
        [
            'an SRT passphrase typed with semicolons',
            `srtsrc uri="srt://h:4200?mode=caller&passphrase=${SRT_SEMI}&pbkeylen=16" ! queue`,
            `srtsrc uri="srt://h:4200?mode=caller&passphrase=${REDACTED}&pbkeylen=16" ! queue`,
        ],
        [
            'an SRT passphrase typed with single quotes',
            `srtsrc uri="srt://h:4200?mode=caller&passphrase=${SRT_QUOTE}&pbkeylen=16" ! queue`,
            `srtsrc uri="srt://h:4200?mode=caller&passphrase=${REDACTED}&pbkeylen=16" ! queue`,
        ],
        [
            'an SRT passphrase typed with spaces, last, up to the closing quote',
            `srtsink uri="srt://h:4200?mode=caller&passphrase=${SRT_SPACE}" auto-reconnect=false`,
            `srtsink uri="srt://h:4200?mode=caller&passphrase=${REDACTED}" auto-reconnect=false`,
        ],
        [
            'an SRT passphrase that holds a secret parameter of its own',
            `srt://h:4200?passphrase=${SRT_INNER}&pbkeylen=16`,
            `srt://h:4200?passphrase=${REDACTED}&pbkeylen=16`,
        ],
        [
            'a secret parameter after another URI on the line',
            `listening on srt://:4200?mode=listener, calling srt://h:4201?passphrase=${SRT}`,
            `listening on srt://:4200?mode=listener, calling srt://h:4201?passphrase=${REDACTED}`,
        ],
        [
            'a signed URL in an error, up to the line end',
            `Error: HTTP 403 for https://cdn.example/a.m3u8?token=${SIG}\n    at NodeLoader.attempt (loader.js:12:5)`,
            `Error: HTTP 403 for https://cdn.example/a.m3u8?token=${REDACTED}\n    at NodeLoader.attempt (loader.js:12:5)`,
        ],
        [
            'user:password@ in a URI, an @ in the password',
            `HTTP 403 for https://operator:${PW}@x@cdn.example/live.m3u8`,
            `HTTP 403 for https://operator:${REDACTED}@cdn.example/live.m3u8`,
        ],
        [
            'an RTMP stream key',
            `rtmp2sink location="rtmp://a.rtmp.example/live2/${RTMP} live=1"`,
            `rtmp2sink location="rtmp://a.rtmp.example/live2/${REDACTED} live=1"`,
        ],
        [
            'an RTMPS stream key with its query',
            `rtmps://live.example:443/rtmp/${RTMP}?s_bl=1&a=b`,
            `rtmps://live.example:443/rtmp/${REDACTED}`,
        ],
        [
            'a bearer token',
            `retrying with Bearer ${BEARER} now`,
            `retrying with Bearer ${REDACTED} now`,
        ],
        [
            'an Authorization header of any scheme',
            `Authorization: Basic ${BEARER}, Accept: */*`,
            `Authorization: ${REDACTED}, Accept: */*`,
        ],
        [
            'the Cloudflare token in an environment file',
            `TUNNEL_TOKEN=${CF}`,
            `TUNNEL_TOKEN=${REDACTED}`,
        ],
        [
            'a token flag, with a space and with =',
            `cloudflared tunnel run --token ${CF} --metrics=:2000 --token=${CF}`,
            `cloudflared tunnel run --token ${REDACTED} --metrics=:2000 --token=${REDACTED}`,
        ],
        [
            'a signed URL',
            `https://cdn.example/m.m3u8?token=${SIG}&expires=9&Signature=${SIG}&Key-Pair-Id=K1`,
            `https://cdn.example/m.m3u8?token=${REDACTED}&expires=9&Signature=${REDACTED}&Key-Pair-Id=K1`,
        ],
        [
            'souphttpsrc credentials',
            `souphttpsrc user-id=op user-pw=${PW} proxy-pw='${PW}'`,
            `souphttpsrc user-id=op user-pw=${REDACTED} proxy-pw='${REDACTED}'`,
        ],
        [
            'a settings object printed as JSON',
            `{"secret":"${RIST}","volume":3,"passphrase":"${SRT}","token":12345}`,
            `{"secret":"${REDACTED}","volume":3,"passphrase":"${REDACTED}","token":${REDACTED}}`,
        ],
        [
            'an object printed by Python and by Node',
            `{'secret': '${RIST}', 'ok': 1} { passphrase: '${SRT}', other: 'x' }`,
            `{'secret': '${REDACTED}', 'ok': 1} { passphrase: '${REDACTED}', other: 'x' }`,
        ],
        [
            'an error that quotes a librist URL',
            `librist start failed: rist_parse_address2 failed (-1) for 'rist://h:5006?buffer=1000&secret=${RIST}&aes-type=128'`,
            `librist start failed: rist_parse_address2 failed (-1) for 'rist://h:5006?buffer=1000&secret=${REDACTED}&aes-type=128'`,
        ],
        [
            'a launch string escaped inside JSON text',
            `{"pipeline":"mrristsrc secret=\\"${RIST}\\" ! queue"}`,
            `{"pipeline":"mrristsrc secret=${REDACTED} ! queue"}`,
        ],
    ])('%s', (_kind, text, logged) => {
        const out = redactSecrets(text);
        expectClean(out);
        expect(out).toBe(logged);
        // Idempotent: a logged line passed through again is the same line.
        expect(redactSecrets(out)).toBe(out);
    });

    it.each([
        [
            'a launch string without a secret',
            'srtsrc name=src uri="srt://srt-peer.example:4200?mode=caller&streamid=s1&pbkeylen=16" ! queue',
        ],
        ['a listener URL', 'rist://@0.0.0.0:5000 srt://:4200?mode=listener udp://239.0.0.1:5000'],
        [
            'names that are not secrets',
            'gateKey=3 pbkeylen=16 aes-type=256 streamid=s1 encrypted=Yes',
        ],
        ['an empty secret', 'mrristsrc secret="" passphrase= done'],
        ['an empty secret parameter', 'srt://h:4200?mode=caller&passphrase=&pbkeylen=16'],
        [
            'caps, times and colons',
            'caps="video/x-raw,format=NV12" at 12:30:45 key: value status: ok',
        ],
    ])('leaves %s as it is', (_kind, text) => expect(redactSecrets(text)).toBe(text));
});

describe('redactValue (B-109)', () => {
    it('redacts a settings object by key and the URLs inside its strings', () => {
        const settings = {
            secret: RIST,
            passphrase: '',
            volume: 3,
            links: [{ mode: 'caller', address: 'h', port: 5004 }],
            url: `https://op:${PW}@cdn.example/x.m3u8?token=${SIG}`,
        };
        const out = redactValue(settings);
        expectClean(JSON.stringify(out));
        expect(out).toEqual({
            secret: REDACTED,
            passphrase: '',
            volume: 3,
            links: settings.links,
            url: `https://op:${REDACTED}@cdn.example/x.m3u8?token=${REDACTED}`,
        });
        expect(out.links).toBe(settings.links);
        expect(settings.secret === RIST).toBe(true);
    });

    it("redacts an op's value on a secret path and a property set on a secret property", () => {
        const ops = [
            { op: 'replace', path: '/engines/e1/modules/m1/settings/passphrase', value: SRT },
            { op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 120 },
            { cmd: 'set_property', element: 'src', property: 'secret', value: RIST },
        ];
        const out = redactValue(ops);
        expectClean(JSON.stringify(out));
        expect(out[0].value).toBe(REDACTED);
        expect(out[1]).toBe(ops[1]);
        expect(out[2]).toEqual({ ...ops[2], value: REDACTED });
    });

    it('redacts the argument after a secret flag in a command line', () => {
        const args = [
            '--ingest',
            '/tmp/mr-bus-41000-ingest.sock',
            '--token',
            CF,
            '--caps',
            'video/mpegts',
        ];
        expect(redactValue(args)).toEqual([...args.slice(0, 3), REDACTED, ...args.slice(4)]);
    });

    it('keeps what holds no secret, and its identity', () => {
        const entry = {
            level: 30,
            msg: 'Started module',
            hasSecret: true,
            secret: '',
            nested: { a: [1, 'x'] },
        };
        expect(redactValue(entry)).toBe(entry);
    });
});
