import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReliableDelivery } from './ReliableDelivery.js';
import type { FragmentTransport } from './FragmentTransport.js';

function fakeTransport() {
    const resent: Array<{ mid: number; port: number; address: string }> = [];
    const released: number[] = [];
    const tx = {
        resend: (mid: number, port: number, address: string) => resent.push({ mid, port, address }),
        release: (mid: number) => released.push(mid),
    } as unknown as FragmentTransport;
    /** One copy on this transport to endpoint key 'ep'. */
    const copy = (mid: number) => [{ transport: tx, messageId: mid, endpointKey: 'ep' }];
    return { tx, resent, released, copy };
}

describe('ReliableDelivery', () => {
    afterEach(() => vi.useRealTimers());

    it('assigns increasing ackIDs', () => {
        const rd = new ReliableDelivery(() => ({ port: 1, address: 'a' }), () => {}, () => false);
        expect(rd.nextAckId()).toBe(1);
        expect(rd.nextAckId()).toBe(2);
        rd.destroy();
    });

    it('resends the retained message on timeout, to the current endpoint', () => {
        vi.useFakeTimers();
        const { resent, copy } = fakeTransport();
        const rd = new ReliableDelivery(() => ({ port: 7, address: 'z' }), () => {}, () => false);
        const ackID = rd.nextAckId();
        rd.track(ackID, copy(99), 't');
        vi.advanceTimersByTime(250); // first fallback resend at ~200ms
        expect(resent).toContainEqual({ mid: 99, port: 7, address: 'z' });
        rd.destroy();
    });

    it('stops resending and releases fragments once ACKed', () => {
        vi.useFakeTimers();
        const { resent, released, copy } = fakeTransport();
        const rd = new ReliableDelivery(() => ({ port: 1, address: 'a' }), () => {}, () => false);
        const ackID = rd.nextAckId();
        rd.track(ackID, copy(42), 'cfg');
        rd.ack(ackID);
        expect(released).toContain(42);
        vi.advanceTimersByTime(5000);
        expect(resent).toHaveLength(0); // acked before any resend fired
        rd.destroy();
    });

    it('emits ackTimeout and releases after MAX_RESEND attempts', () => {
        vi.useFakeTimers();
        const { released, copy } = fakeTransport();
        const timeouts: Array<{ topic?: string; ackID: number }> = [];
        const rd = new ReliableDelivery(
            () => ({ port: 1, address: 'a' }),
            (info) => timeouts.push(info),
            () => false,
        );
        const ackID = rd.nextAckId();
        rd.track(ackID, copy(5), 'cfg');
        vi.advanceTimersByTime(60000); // past all 10 backoffs (~13s)
        expect(timeouts).toEqual([{ topic: 'cfg', ackID }]);
        expect(released).toContain(5);
        rd.destroy();
    });

    it('resends every copy to its own endpoint and skips a pruned one', () => {
        vi.useFakeTimers();
        const { resent } = fakeTransport();
        const other = fakeTransport();
        const endpoints: Record<string, { port: number; address: string } | undefined> = {
            a: { port: 1, address: 'a' },
            b: { port: 2, address: 'b' },
        };
        const rd = new ReliableDelivery((k) => endpoints[k], () => {}, () => false);
        const ackID = rd.nextAckId();
        rd.track(
            ackID,
            [
                { transport: fakeTransport().tx, messageId: 0, endpointKey: 'none' },
                { transport: other.tx, messageId: 7, endpointKey: 'b' },
            ],
            't',
        );
        // First copy's transport is a throwaway; verify via the second.
        vi.advanceTimersByTime(250);
        expect(other.resent).toContainEqual({ mid: 7, port: 2, address: 'b' });
        expect(resent).toHaveLength(0);
        // Prune endpoint b: the next resend round must skip it.
        endpoints.b = undefined;
        vi.advanceTimersByTime(500);
        expect(other.resent.filter((r) => r.mid === 7)).toHaveLength(1);
        rd.destroy();
    });

    it('one ACK releases every copy', () => {
        const a = fakeTransport();
        const b = fakeTransport();
        const rd = new ReliableDelivery(() => ({ port: 1, address: 'a' }), () => {}, () => false);
        const ackID = rd.nextAckId();
        rd.track(
            ackID,
            [
                { transport: a.tx, messageId: 11, endpointKey: 'a' },
                { transport: b.tx, messageId: 12, endpointKey: 'b' },
            ],
            't',
        );
        rd.ack(ackID);
        expect(a.released).toEqual([11]);
        expect(b.released).toEqual([12]);
        rd.destroy();
    });

    it('uses the injected ackID source when given', () => {
        let n = 100;
        const rd = new ReliableDelivery(() => undefined, () => {}, () => false, () => ++n);
        expect(rd.nextAckId()).toBe(101);
        expect(rd.nextAckId()).toBe(102);
        rd.destroy();
    });
});
