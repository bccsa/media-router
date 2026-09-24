import { describe, it, expect, vi } from 'vitest';
import { VuSocketFanout } from './VuSocketFanout.js';

/** Fake socket.io server: rooms + sockets maps, browser sockets with an engine.io-like `conn`. */
function createIo() {
    const rooms = new Map<string, Set<string>>();
    const sockets = new Map<string, any>();
    const io = { sockets: { adapter: { rooms }, sockets } } as any;

    function addSocket(id: string, engineIds: string[], writable = true) {
        const drains: Array<() => void> = [];
        const socket = {
            emit: vi.fn(),
            conn: {
                transport: { writable },
                once: vi.fn((event: string, cb: () => void) => {
                    if (event === 'drain') drains.push(cb);
                }),
            },
            drain() {
                socket.conn.transport.writable = true;
                for (const cb of drains.splice(0)) cb();
            },
        };
        sockets.set(id, socket);
        for (const engineId of engineIds) {
            if (!rooms.has(`watch:${engineId}`)) rooms.set(`watch:${engineId}`, new Set());
            rooms.get(`watch:${engineId}`)!.add(id);
        }
        return socket;
    }
    return { io, rooms, sockets, addSocket, fanout: new VuSocketFanout(io) };
}

describe('VuSocketFanout', () => {
    it('emits straight to each watcher whose transport is writable, and only to that room', () => {
        const { fanout, addSocket } = createIo();
        const a = addSocket('sock-a', ['eng-1']);
        const other = addSocket('sock-b', ['eng-2']);

        fanout.emit('eng-1', { engineId: 'eng-1', batch: { 'mod-1': [6] } });

        expect(a.emit).toHaveBeenCalledWith('engine:vu', {
            engineId: 'eng-1',
            batch: { 'mod-1': [6] },
        });
        expect(other.emit).not.toHaveBeenCalled();
    });

    it('does nothing for an engine nobody watches', () => {
        const { fanout } = createIo();
        expect(() => fanout.emit('eng-9', { engineId: 'eng-9' })).not.toThrow();
    });

    it('holds the newest payload per engine while the transport is busy and flushes on drain (#677)', () => {
        const { fanout, addSocket } = createIo();
        const busy = addSocket('sock-a', ['eng-1', 'eng-2'], false);

        fanout.emit('eng-1', { engineId: 'eng-1', batch: { 'mod-1': [6] } });
        fanout.emit('eng-1', { engineId: 'eng-1', batch: { 'mod-1': [7] } });
        fanout.emit('eng-2', { engineId: 'eng-2', batch: { 'mod-2': [3] } });
        expect(busy.emit).not.toHaveBeenCalled();
        expect(busy.conn.once).toHaveBeenCalledTimes(1);

        busy.drain();
        expect(busy.emit).toHaveBeenCalledTimes(2);
        expect(busy.emit).toHaveBeenCalledWith('engine:vu', {
            engineId: 'eng-1',
            batch: { 'mod-1': [7] },
        });
        expect(busy.emit).toHaveBeenCalledWith('engine:vu', {
            engineId: 'eng-2',
            batch: { 'mod-2': [3] },
        });

        // The next busy window arms a fresh drain listener.
        busy.conn.transport.writable = false;
        fanout.emit('eng-1', { engineId: 'eng-1', batch: { 'mod-1': [8] } });
        expect(busy.conn.once).toHaveBeenCalledTimes(2);
    });

    it('skips a socket id that is still in the room but gone from the sockets map', () => {
        const { fanout, addSocket, sockets } = createIo();
        const live = addSocket('sock-live', ['eng-1']);
        addSocket('sock-gone', ['eng-1']);
        sockets.delete('sock-gone');

        fanout.emit('eng-1', { engineId: 'eng-1', batch: {} });
        expect(live.emit).toHaveBeenCalledTimes(1);
    });
});
