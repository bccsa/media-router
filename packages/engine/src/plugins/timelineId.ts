// The sender's timeline id (house-clock plan ch. 9, p5-20): what an egress writer declares in its
// descriptor, so a receiver groups the Trust inputs of one programme. 16 lower-case hex digits (p5-1).
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** p5-1's text form of `timeline_id` 0: none (an egress with no origin). */
export const NO_TIMELINE = '0000000000000000';
/** The engine's salt, beside the profile store (never inside it: a copied profile keeps no salt). */
export const TIMELINE_SALT_FILE = 'timeline-salt';

const HEX16 = /^[0-9a-f]{16}$/;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

/** FNV-1a 64 over the text's UTF-8 bytes. */
export function fnv1a64(text: string): bigint {
    let h = FNV_OFFSET;
    for (const b of Buffer.from(text, 'utf8')) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK;
    return h;
}

/** The one text form: 16 lower-case hex digits, no prefix. */
export function timelineText(v: bigint): string {
    return (v & MASK).toString(16).padStart(16, '0');
}

export function isTimelineText(s: unknown): s is string {
    return typeof s === 'string' && HEX16.test(s);
}

/** A hash as an id: 0 is "none", so a real origin never hashes to it. */
const idOf = (text: string): string => timelineText(fnv1a64(text) || 1n);

/** The key of an origin this engine starts: its module id under this engine's salt. */
export function localOriginKey(salt: string, moduleId: string): string {
    return idOf(`${salt}:${moduleId}`);
}

/** An egress's id from its origins: a Trust ingest's received key (a relay keeps its upstream's
 *  timeline), else the origin's local key; one key is the id, several hash sorted; none is 0. */
export function senderTimelineId(
    origins: Iterable<string>,
    receivedKey: (moduleId: string) => string | undefined,
    salt: string,
): string {
    const keys = new Set<string>();
    for (const id of origins) {
        const k = receivedKey(id);
        keys.add(isTimelineText(k) && k !== NO_TIMELINE ? k : localOriginKey(salt, id));
    }
    if (!keys.size) return NO_TIMELINE;
    if (keys.size === 1) return [...keys][0];
    return idOf([...keys].sort().join(','));
}

/** The engine's salt from `dir`, created once (random 64 bits) when missing or unreadable. A
 *  failed write keeps the new salt for this run only: ids then move at the next start. */
export function loadTimelineSalt(
    dir: string,
    onError?: (err: unknown) => void,
): { salt: string; created: boolean } {
    const file = path.join(dir, TIMELINE_SALT_FILE);
    try {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (isTimelineText(text)) return { salt: text, created: false };
    } catch {
        // Missing: created below.
    }
    const salt = randomBytes(8).toString('hex');
    try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${salt}\n`, { mode: 0o644 });
        fs.renameSync(tmp, file);
    } catch (err) {
        onError?.(err);
    }
    return { salt, created: true };
}
