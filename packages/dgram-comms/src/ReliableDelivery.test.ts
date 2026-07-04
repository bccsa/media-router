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
    return { tx, resent, released };
}

describe('ReliableDelivery', () => {
    afterEach(() => vi.useRealTimers());

    it('assigns increasing ackIDs', () => {
        const { tx } = fakeTransport();
        const rd = new ReliableDelivery(tx, () => ({ port: 1, address: 'a' }), () => {}, () => false);
        expect(rd.nextAckId()).toBe(1);
        expect(rd.nextAckId()).toBe(2);
        rd.destroy();
    });

    it('resends the retained message on timeout, to the current endpoint', () => {
        vi.useFakeTimers();
        const { tx, resent } = fakeTransport();
        const rd = new ReliableDelivery(tx, () => ({ port: 7, address: 'z' }), () => {}, () => false);
        const ackID = rd.nextAckId();
        rd.track(ackID, 99, 't');
        vi.advanceTimersByTime(250); // first fallback resend at ~200ms
        expect(resent).toContainEqual({ mid: 99, port: 7, address: 'z' });
        rd.destroy();
    });

    it('stops resending and releases fragments once ACKed', () => {
        vi.useFakeTimers();
        const { tx, resent, released } = fakeTransport();
        const rd = new ReliableDelivery(tx, () => ({ port: 1, address: 'a' }), () => {}, () => false);
        const ackID = rd.nextAckId();
        rd.track(ackID, 42, 'cfg');
        rd.ack(ackID);
        expect(released).toContain(42);
        vi.advanceTimersByTime(5000);
        expect(resent).toHaveLength(0); // acked before any resend fired
        rd.destroy();
    });

    it('emits ackTimeout and releases after MAX_RESEND attempts', () => {
        vi.useFakeTimers();
        const { tx, released } = fakeTransport();
        const timeouts: Array<{ topic?: string; ackID: number }> = [];
        const rd = new ReliableDelivery(
            tx,
            () => ({ port: 1, address: 'a' }),
            (info) => timeouts.push(info),
            () => false,
        );
        const ackID = rd.nextAckId();
        rd.track(ackID, 5, 'cfg');
        vi.advanceTimersByTime(60000); // past all 10 backoffs (~13s)
        expect(timeouts).toEqual([{ topic: 'cfg', ackID }]);
        expect(released).toContain(5);
        rd.destroy();
    });
});
