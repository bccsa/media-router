import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { createLogger, setLogTap } from './logger.js';
import { REDACTED } from './redact.js';

// Test secrets (B-109): unique, so the whole test output can be searched for them.
const RIST = 'zq109-log-rist-F6c3';
const PW = 'zq109-log-pw-N1x5';
const SIG = 'zq109-log-sig-R8j2';

/** Every line the logger writes, as the tap and stderr get it. */
async function capture(log: (l: ReturnType<typeof createLogger>) => void) {
    const tapped: string[] = [];
    const written: string[] = [];
    setLogTap((line) => tapped.push(line));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
    });
    log(createLogger('b109'));
    await new Promise((r) => setImmediate(r));
    stderr.mockRestore();
    setLogTap(null);
    return { tapped, written };
}

const leaks = (text: string) => [RIST, PW, SIG].filter((s) => text.includes(s)).length;

describe('createLogger: every line loses its secrets (B-109)', () => {
    afterEach(() => setLogTap(null));

    it('redacts a settings object, an error quoting a launch string and a URL in the message', async () => {
        const { tapped, written } = await capture((log) => {
            log.info(
                { moduleId: 'm1', changes: { secret: RIST, volume: 80 } },
                'Plugin auto-detected config',
            );
            log.error(
                { err: new Error(`Pipeline parse error: mrristsrc secret="${RIST}" ! queue`) },
                'failed',
            );
            log.warn(
                { src: 'hls-pipe' },
                `HTTP 403 for https://op:${PW}@cdn.example/a.m3u8?token=${SIG}`,
            );
        });
        expect(tapped).toHaveLength(3);
        expect(written).toEqual(tapped);
        expect(leaks(tapped.join(''))).toBe(0);
        const [config, error, warn] = tapped.map((l) => JSON.parse(l));
        expect(config.changes).toEqual({ secret: REDACTED, volume: 80 });
        expect(config.msg).toBe('Plugin auto-detected config');
        expect(error.err.message).toBe(
            `Pipeline parse error: mrristsrc secret="${REDACTED}" ! queue`,
        );
        expect(error.err.stack).toContain(`secret="${REDACTED}"`);
        expect(warn.msg).toBe(
            `HTTP 403 for https://op:${REDACTED}@cdn.example/a.m3u8?token=${REDACTED}`,
        );
        expect(tapped.every((l) => l.endsWith('\n'))).toBe(true);
    });

    it('redacts a line that is not JSON as text', async () => {
        const { tapped, written } = await capture((log) => {
            const stream = (log as unknown as Record<symbol, NodeJS.WritableStream>)[
                pino.symbols.streamSym
            ];
            stream.write(`not json: mrristsrc secret="${RIST}" ! queue\n`);
        });
        expect(tapped).toEqual([`not json: mrristsrc secret="${REDACTED}" ! queue\n`]);
        expect(written).toEqual(tapped);
    });

    it('passes a line with no secret through as pino wrote it', async () => {
        const { tapped, written } = await capture((log) =>
            log.info({ count: 2 }, 'Starting modules'),
        );
        expect(written).toEqual(tapped);
        expect(JSON.parse(tapped[0])).toMatchObject({
            name: 'b109',
            count: 2,
            msg: 'Starting modules',
        });
    });
});
