import { describe, it, expect } from 'vitest';
import { SharedRead } from './SharedRead.js';

/** A read the test answers: each call waits until `answer(value)` or `fail()`. */
function makeRead(ttlMs = 1000) {
    let t = 0;
    const calls: Array<{ ok: (v: string) => void; no: (e: Error) => void }> = [];
    let running = 0;
    let most = 0;
    const read = new SharedRead<string>(
        () =>
            new Promise<string>((ok, no) => {
                most = Math.max(most, ++running);
                const end =
                    <T>(f: (v: T) => void) =>
                    (v: T) => {
                        running -= 1;
                        f(v);
                    };
                calls.push({ ok: end(ok), no: end(no) });
            }),
        ttlMs,
        () => t,
    );
    const flush = () => new Promise((r) => setImmediate(r));
    return {
        read,
        calls,
        flush,
        most: () => most,
        advance: (ms: number) => (t += ms),
        answer: async (v: string) => {
            calls.shift()!.ok(v);
            await flush();
        },
        fail: async () => {
            calls.shift()!.no(new Error('no answer'));
            await flush();
        },
    };
}

describe('SharedRead (B-200)', () => {
    it('readers while a read runs share it; its answer is kept for the TTL after it lands', async () => {
        const { read, calls, flush, answer, advance } = makeRead();
        const a = read.get();
        advance(5000); // a read that waits longer than the TTL is still the one read
        const b = read.get();
        await flush();
        expect(calls).toHaveLength(1);
        await answer('one');
        expect([await a, await b]).toEqual(['one', 'one']);
        advance(999);
        expect(await read.get()).toBe('one');
        expect(calls).toHaveLength(0);
        advance(1);
        const c = read.get();
        await flush();
        expect(calls).toHaveLength(1);
        await answer('two');
        expect(await c).toBe('two');
    });

    it('after invalidate() the next reader waits for a read that starts once the running one is done', async () => {
        const { read, calls, flush, answer, most } = makeRead();
        const old = read.get();
        await flush();
        read.invalidate();
        const fresh = read.get();
        const alsoFresh = read.get();
        await flush();
        expect(calls).toHaveLength(1); // never two at once
        await answer('before');
        expect(await old).toBe('before');
        expect(calls).toHaveLength(1); // the fresh read, started after the first landed
        await answer('after');
        expect([await fresh, await alsoFresh]).toEqual(['after', 'after']);
        expect(await read.get()).toBe('after'); // kept: nothing invalidated it
        expect(most()).toBe(1);
    });

    it('a read older than an invalidate() answers its own readers but is not kept', async () => {
        const { read, calls, flush, answer } = makeRead();
        const old = read.get();
        await flush();
        read.invalidate();
        await answer('stale');
        expect(await old).toBe('stale');
        const next = read.get();
        await flush();
        expect(calls).toHaveLength(1);
        await answer('new');
        expect(await next).toBe('new');
    });

    it('a failed read fails its readers only: the next reader gets a new read', async () => {
        const { read, calls, flush, answer, fail } = makeRead();
        const a = read.get().catch((e: Error) => e.message);
        await flush();
        read.invalidate();
        const b = read.get();
        await fail();
        expect(await a).toBe('no answer');
        expect(calls).toHaveLength(1);
        await answer('back');
        expect(await b).toBe('back');
    });

    it('TTL 0 keeps nothing, and readers during a read still share it', async () => {
        const { read, calls, flush, answer } = makeRead(0);
        const a = read.get();
        const b = read.get();
        await flush();
        expect(calls).toHaveLength(1);
        await answer('x');
        expect([await a, await b]).toEqual(['x', 'x']);
        const c = read.get();
        await flush();
        expect(calls).toHaveLength(1);
        await answer('y');
        expect(await c).toBe('y');
    });
});
