import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { TREE_PROTOCOL } from '@media-router/shared-types';
import { TopicBus } from './TopicBus.js';
import { attachTree } from './attachTree.js';
import { TreeCallError } from './types.js';
import { objectSource } from './testing.js';

const state = { engines: { e1: { info: { online: true }, settings: { volume: 80 } } } };

function request(client: Socket, event: string, payload: unknown): Promise<any> {
    return new Promise((resolve) => client.emit(event, payload, resolve));
}

describe('attachTree over a real Socket.IO server', () => {
    let http: HttpServer;
    let url: string;
    let bus: TopicBus;
    const clients: Socket[] = [];

    beforeEach(async () => {
        http = createServer();
        const io = new Server(http);
        bus = new TopicBus(objectSource(state), 5);
        attachTree(io, {
            bus,
            hello: () => ({ proto: TREE_PROTOCOL, build: 'b1' }),
            onWrite: (_caller, ops) => ({
                rejected: ops.map((o, index) => ({ index, path: o.path, reason: 'read-only' })),
            }),
            onCall: (_caller, path, method) => {
                if (method === 'fail') throw new TreeCallError('nope');
                return { path, method };
            },
        });
        await new Promise<void>((r) => http.listen(0, r));
        url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        for (const c of clients.splice(0)) c.close();
        await new Promise<void>((r) => http.close(() => r()));
    });

    function open(auth: Record<string, unknown>): Socket {
        const c = connect(url, { transports: ['websocket'], auth, reconnection: false });
        clients.push(c);
        return c;
    }

    it('refuses a client on another protocol version', async () => {
        const c = open({ proto: 0 });
        const err = await new Promise<Error>((r) => c.on('connect_error', r));
        expect(err.message).toMatch(/tree protocol/);
    });

    it('greets, snapshots, calls and echoes rejected writes', async () => {
        const c = open({ proto: TREE_PROTOCOL });
        const hello = await new Promise<any>((r) => c.on('hello', r));
        expect(hello).toEqual({ proto: TREE_PROTOCOL, build: 'b1' });

        const sub = await request(c, 'sub', { patterns: ['/engines/+/info'] });
        expect(sub).toEqual({ ok: true, data: { ops: [{ op: 'add', path: '/engines/e1/info', value: { online: true } }] } });

        expect(await request(c, 'call', { path: '/engines/e1', method: 'reboot' })).toEqual({
            ok: true, data: { path: '/engines/e1', method: 'reboot' },
        });
        expect(await request(c, 'call', { path: '/x', method: 'fail' })).toEqual({ ok: false, error: 'nope' });

        const frame = new Promise<any>((r) => c.on('tree', r));
        const write = await request(c, 'write', { id: 4, ops: [{ op: 'replace', path: '/engines/e1/settings/volume', value: 1 }] });
        expect(write.data.rejected).toHaveLength(1);
        expect((await frame).ops).toEqual([{ op: 'replace', path: '/engines/e1/settings/volume', value: 80, w: 4 }]);
    });

    it('answers a malformed request with an error ack', async () => {
        const c = open({ proto: TREE_PROTOCOL });
        await new Promise((r) => c.on('hello', r));
        expect(await request(c, 'sub', { patterns: 'nope' })).toEqual({ ok: false, error: 'invalid request' });
    });
});
