import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    NO_TIMELINE,
    TIMELINE_SALT_FILE,
    fnv1a64,
    isTimelineText,
    loadTimelineSalt,
    localOriginKey,
    senderTimelineId,
    timelineText,
} from './timelineId.js';

// The sender's timeline id (p5-20): the hash, the salt on disk, the one text form.
const SALT = '00112233445566ff';
const none = (): undefined => undefined;

describe('the hash and the text form', () => {
    it("FNV-1a 64's published values; 16 lower-case hex digits, no prefix", () => {
        expect(fnv1a64('')).toBe(0xcbf29ce484222325n);
        expect(fnv1a64('a')).toBe(0xaf63dc4c8601ec8cn);
        expect(fnv1a64('foobar')).toBe(0x85944171f73967e8n);
        expect(timelineText(0n)).toBe(NO_TIMELINE);
        expect(timelineText(0xabn)).toBe('00000000000000ab');
        expect(isTimelineText('0123456789abcdef')).toBe(true);
        expect(isTimelineText('0123456789ABCDEF')).toBe(false);
        expect(isTimelineText('0x23456789abcdef')).toBe(false);
        expect(isTimelineText(undefined)).toBe(false);
    });

    it("an origin's key is its module id under the salt", () => {
        expect(localOriginKey(SALT, 'srt-input-a1')).toBe(
            timelineText(fnv1a64(`${SALT}:srt-input-a1`)),
        );
        expect(isTimelineText(localOriginKey(SALT, 'x'))).toBe(true);
    });
});

describe('senderTimelineId', () => {
    it('one origin: its local key; none: 0', () => {
        expect(senderTimelineId(['gen-1'], none, SALT)).toBe(localOriginKey(SALT, 'gen-1'));
        expect(senderTimelineId([], none, SALT)).toBe(NO_TIMELINE);
    });

    it('a Trust relay: the received key passes through', () => {
        const got = senderTimelineId(['rist-in'], () => 'fedcba9876543210', SALT);
        expect(got).toBe('fedcba9876543210');
        // A received 0 (an older writer) or a malformed key is no timeline: the local key.
        expect(senderTimelineId(['rist-in'], () => NO_TIMELINE, SALT)).toBe(
            localOriginKey(SALT, 'rist-in'),
        );
        expect(senderTimelineId(['rist-in'], () => 'tl:zz', SALT)).toBe(
            localOriginKey(SALT, 'rist-in'),
        );
    });

    it('two origins: the hash of the sorted keys, whatever the order; one shared key is that key', () => {
        const ab = senderTimelineId(['a', 'b'], none, SALT);
        expect(ab).toBe(senderTimelineId(['b', 'a'], none, SALT));
        const keys = [localOriginKey(SALT, 'a'), localOriginKey(SALT, 'b')].sort();
        expect(ab).toBe(timelineText(fnv1a64(keys.join(','))));
        expect(ab).not.toBe(localOriginKey(SALT, 'a'));
        // Video over SRT and audio over RIST of one upstream, both in Trust, muxed: one timeline.
        const same = (): string => 'fedcba9876543210';
        expect(senderTimelineId(['srt-in', 'rist-in'], same, SALT)).toBe('fedcba9876543210');
    });

    it('two engines with the same profile (same module ids) give different ids: two salts', () => {
        expect(senderTimelineId(['gen-1'], none, SALT)).not.toBe(
            senderTimelineId(['gen-1'], none, 'ffeeddccbbaa9988'),
        );
    });
});

describe('loadTimelineSalt', () => {
    const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mr-salt-'));

    it('a missing salt file is created once; a restart reads it back', () => {
        const dir = path.join(tmp(), 'state');
        const first = loadTimelineSalt(dir);
        expect(first.created).toBe(true);
        expect(isTimelineText(first.salt)).toBe(true);
        expect(fs.readFileSync(path.join(dir, TIMELINE_SALT_FILE), 'utf8')).toBe(`${first.salt}\n`);
        const again = loadTimelineSalt(dir);
        expect(again).toEqual({ salt: first.salt, created: false });
        expect(fs.readdirSync(dir)).toEqual([TIMELINE_SALT_FILE]);
        // So the id an egress declares is stable across the restart.
        expect(senderTimelineId(['gen-1'], none, again.salt)).toBe(
            senderTimelineId(['gen-1'], none, first.salt),
        );
    });

    it('two state directories (two engines) get two salts', () => {
        expect(loadTimelineSalt(tmp()).salt).not.toBe(loadTimelineSalt(tmp()).salt);
    });

    it('a damaged file is replaced; an unwritable directory keeps a salt for the run, reported', () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, TIMELINE_SALT_FILE), 'not a salt\n');
        const fixed = loadTimelineSalt(dir);
        expect(fixed.created).toBe(true);
        expect(fs.readFileSync(path.join(dir, TIMELINE_SALT_FILE), 'utf8').trim()).toBe(fixed.salt);
        const file = path.join(tmp(), 'plain-file');
        fs.writeFileSync(file, '');
        const errors: unknown[] = [];
        const run = loadTimelineSalt(path.join(file, 'below'), (err) => errors.push(err));
        expect(isTimelineText(run.salt)).toBe(true);
        expect(errors).toHaveLength(1);
    });
});
