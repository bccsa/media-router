/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeClient, errorCode } from './TreeClient';

function fakeIo() {
    const handlers = new Map<string, Array<(...a: any[]) => void>>();
    const emitted: Array<[string, any]> = [];
    const acks: Record<string, (payload: any) => unknown> = {};
    const s: any = {
        connected: false,
        on(ev: string, fn: (...a: any[]) => void) {
            handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
        },
        emit(ev: string, payload: any, ack?: (a: unknown) => void) {
            emitted.push([ev, payload]);
            if (ack && acks[ev]) ack(acks[ev](payload));
        },
        removeAllListeners() {},
        disconnect() {},
        fire(ev: string, ...args: any[]) {
            if (ev === 'connect') s.connected = true;
            for (const h of handlers.get(ev) ?? []) h(...args);
        },
    };
    return { s, emitted, acks, connectFn: vi.fn(() => s) as any };
}

function setup() {
    const io = fakeIo();
    const onOps = vi.fn();
    const onDropped = vi.fn();
    const reload = vi.fn();
    const client = new TreeClient({ onOps, onDropped, reload, connectFn: io.connectFn });
    client.connect();
    return { client, io, onOps, onDropped, reload };
}

describe('TreeClient', () => {
    beforeEach(() => sessionStorage.clear());

    it('connects with the tree protocol and subscribes on connect', () => {
        const { client, io, onOps } = setup();
        expect(io.connectFn.mock.calls[0][1].auth).toEqual({ proto: 1 });
        client.subscribe(['/engines/+/info']);
        expect(io.emitted).toEqual([]);
        io.acks.sub = () => ({ ok: true, data: { ops: [{ op: 'add', path: '/engines/e/info', value: {} }] } });
        io.s.fire('connect');
        expect(io.emitted).toEqual([['sub', { patterns: ['/engines/+/info'] }]]);
        expect(onOps).toHaveBeenCalledWith([{ op: 'add', path: '/engines/e/info', value: {} }], { snapshot: true });
    });

    it('ref-counts patterns and unsubscribes on the last release', () => {
        const { client, io, onDropped } = setup();
        io.s.fire('connect');
        const a = client.subscribe(['/engines/e']);
        const b = client.subscribe(['/engines/e', '/groups']);
        expect(io.emitted.filter(([e]) => e === 'sub')).toHaveLength(2);
        a();
        expect(io.emitted.some(([e]) => e === 'unsub')).toBe(false);
        b();
        expect(io.emitted.at(-1)).toEqual(['unsub', { patterns: ['/engines/e', '/groups'] }]);
        expect(onDropped).toHaveBeenCalledWith(['/engines/e', '/groups'], []);
    });

    it('settles echoes: stale own echoes and foreign ops yield to a newer own write', () => {
        const { client, io, onOps } = setup();
        io.acks.write = () => ({ ok: true, data: { rejected: [] } });
        io.s.fire('connect');
        const path = '/engines/e/modules/m/settings/volume';
        void client.write([{ op: 'replace', path, value: 50 }]);
        void client.write([{ op: 'replace', path, value: 60 }]);
        io.s.fire('tree', { ops: [{ op: 'replace', path, value: 50, w: 1 }] });
        io.s.fire('tree', { ops: [{ op: 'replace', path, value: 55 }] });
        expect(onOps).not.toHaveBeenCalled();
        io.s.fire('tree', { ops: [{ op: 'replace', path, value: 60, w: 2 }] });
        io.s.fire('tree', { ops: [{ op: 'replace', path, value: 70 }] });
        expect(onOps.mock.calls.map(([ops]) => ops[0].value)).toEqual([60, 70]);
    });

    it('reloads once when the server refuses our protocol, not on other connect errors', () => {
        const { io, reload } = setup();
        sessionStorage.removeItem('mr-tree-reload');
        io.s.fire('connect_error', new Error('xhr poll error'));
        expect(reload).not.toHaveBeenCalled();
        io.s.fire('connect_error', new Error('tree protocol 2 required, client sent 1'));
        io.s.fire('connect_error', new Error('tree protocol 2 required, client sent 1'));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads once when the served UI build changes', () => {
        const { io, reload } = setup();
        io.s.fire('hello', { proto: 1, build: 'a' });
        io.s.fire('hello', { proto: 1, build: 'a' });
        expect(reload).not.toHaveBeenCalled();
        io.s.fire('hello', { proto: 1, build: 'b' });
        io.s.fire('hello', { proto: 1, build: 'b' });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('follows a rename, so releasing the old spelling frees the new pattern', () => {
        const { client, io } = setup();
        io.s.fire('connect');
        const release = client.subscribe(['/engines/old']);
        io.s.fire('tree:renamed', { from: '/engines/old', to: '/engines/new' });
        expect(client.patterns()).toEqual(['/engines/new']);
        release();
        expect(client.patterns()).toEqual([]);
        expect(io.emitted.at(-1)).toEqual(['unsub', { patterns: ['/engines/new'] }]);
    });

    it('rejects a call while disconnected', async () => {
        const { client } = setup();
        await expect(client.call('/engines/e', 'reboot')).rejects.toThrow('Not connected');
    });

    it('a refused call carries its code', async () => {
        const { client, io } = setup();
        io.s.fire('connect');
        io.acks.call = () => ({ ok: false, error: 'Someone else saved this dashboard meanwhile', code: 'conflict' });
        const err = await client.call('/dashboards', 'save').catch((e: unknown) => e);
        expect(errorCode(err)).toBe('conflict');
        expect((err as Error).message).toBe('Someone else saved this dashboard meanwhile');
        io.acks.call = () => ({ ok: false, error: 'nope' });
        expect(errorCode(await client.call('/x', 'y').catch((e: unknown) => e))).toBeUndefined();
    });
});
