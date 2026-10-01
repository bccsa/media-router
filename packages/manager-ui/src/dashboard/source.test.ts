/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { createSource } from './source';

function fakeIo() {
    const handlers = new Map<string, Array<(...a: any[]) => void>>();
    const acks: Record<string, (payload: any) => unknown> = {};
    const s: any = {
        connected: false,
        on: (ev: string, fn: (...a: any[]) => void) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
        emit: (ev: string, payload: any, ack?: (a: unknown) => void) => ack && acks[ev] && ack(acks[ev](payload)),
        removeAllListeners() {},
        disconnect() {},
        fire(ev: string, ...args: any[]) {
            s.connected = ev === 'connect' ? true : ev === 'disconnect' ? false : s.connected;
            for (const h of handlers.get(ev) ?? []) h(...args);
        },
    };
    return { s, acks, connectFn: vi.fn(() => s) as any };
}

describe('dashboard source', () => {
    it('mirrors snapshots and frames, and knows which patterns are loaded', () => {
        const io = fakeIo();
        const src = createSource({ prefix: '/engines/e1', connectFn: io.connectFn });
        io.acks.sub = () => ({ ok: true, data: { ops: [{ op: 'add', path: '/engines/e1/modules/m1/settings/volume', value: 80 }] } });
        io.s.fire('connect');
        src.subscribe(['/engines/e1/modules/m1/settings/volume']);
        expect(src.connected.value).toBe(true);
        expect(src.get('/engines/e1/modules/m1/settings/volume')).toBe(80);
        expect(src.loaded('/engines/e1/modules/m1/settings/volume')).toBe(true);
        io.s.fire('tree', { ops: [{ op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 90 }] });
        expect(src.get('/engines/e1/modules/m1/settings/volume')).toBe(90);
        io.s.fire('disconnect');
        expect(src.connected.value).toBe(false);
        expect(src.loaded('/engines/e1/modules/m1/settings/volume')).toBe(false);
        expect(src.get('/engines/e1/modules/m1/settings/volume')).toBe(90);
    });

    it('a value that vanished while away is gone after the resubscribe snapshot', () => {
        const io = fakeIo();
        const src = createSource({ prefix: '', connectFn: io.connectFn });
        io.acks.sub = () => ({ ok: true, data: { ops: [{ op: 'add', path: '/modules/m1/vu', value: [3] }] } });
        io.s.fire('connect');
        src.subscribe(['/modules/m1/vu']);
        expect(src.get('/modules/m1/vu')).toEqual([3]);
        io.s.fire('disconnect');
        io.acks.sub = () => ({ ok: true, data: { ops: [] } });
        io.s.fire('connect');
        expect(src.get('/modules/m1/vu')).toBeUndefined();
        expect(src.loaded('/modules/m1/vu')).toBe(true);
    });
});
