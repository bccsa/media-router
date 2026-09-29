import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SocketOutbox } from './SocketOutbox.js';
import { fakeSocket } from './testing.js';

describe('SocketOutbox', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('batches ops into one frame per flush tick', () => {
        const sock = fakeSocket('s');
        const box = new SocketOutbox(sock, 50);
        box.push({ op: 'replace', path: '/a', value: 1 });
        box.push({ op: 'replace', path: '/b', value: 2 });
        expect(sock.frames()).toHaveLength(0);
        vi.advanceTimersByTime(50);
        expect(sock.frames()).toEqual([[
            { op: 'replace', path: '/a', value: 1 },
            { op: 'replace', path: '/b', value: 2 },
        ]]);
    });

    it('keeps only the newest op per path, moved to the end', () => {
        const sock = fakeSocket('s');
        const box = new SocketOutbox(sock, 50);
        box.push({ op: 'replace', path: '/a', value: 1 });
        box.push({ op: 'replace', path: '/b', value: 2 });
        box.push({ op: 'replace', path: '/a', value: 3 });
        vi.advanceTimersByTime(50);
        expect(sock.frames()[0].map((o: any) => o.value)).toEqual([2, 3]);
    });

    it('never coalesces appends', () => {
        const sock = fakeSocket('s');
        const box = new SocketOutbox(sock, 50);
        box.push({ op: 'add', path: '/logs/-', value: 'x' });
        box.push({ op: 'add', path: '/logs/-', value: 'y' });
        vi.advanceTimersByTime(50);
        expect(sock.frames()[0]).toHaveLength(2);
    });

    it('carries a superseded write id so the echo is not lost', () => {
        const sock = fakeSocket('s');
        const box = new SocketOutbox(sock, 50);
        box.push({ op: 'replace', path: '/a', value: 1, w: 7 });
        box.push({ op: 'replace', path: '/a', value: 2 });
        vi.advanceTimersByTime(50);
        expect(sock.frames()[0]).toEqual([{ op: 'replace', path: '/a', value: 2, w: 7 }]);
    });

    it('holds latest values while the transport is busy and retries until it is free', () => {
        const sock = fakeSocket('s');
        const box = new SocketOutbox(sock, 50);
        sock.setWritable(false);
        box.push({ op: 'replace', path: '/vu', value: [1] });
        vi.advanceTimersByTime(50);
        box.push({ op: 'replace', path: '/vu', value: [2] });
        vi.advanceTimersByTime(500);
        expect(sock.frames()).toHaveLength(0);
        // Nothing else is sent to this socket, so no engine.io 'drain' will come.
        sock.setWritable(true);
        vi.advanceTimersByTime(50);
        expect(sock.frames()).toEqual([[{ op: 'replace', path: '/vu', value: [2] }]]);
    });

    it('flushNow sends immediately', () => {
        const sock = fakeSocket('s');
        const box = new SocketOutbox(sock, 50);
        box.push({ op: 'replace', path: '/a', value: 1 });
        box.flushNow();
        expect(sock.frames()).toHaveLength(1);
        vi.advanceTimersByTime(100);
        expect(sock.frames()).toHaveLength(1);
    });
});
