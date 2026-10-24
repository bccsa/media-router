import { describe, it, expect, afterEach, vi } from 'vitest';
import * as dgram from 'dgram';
import { Client } from '@media-router/dgram-comms';
import { EngineConnectionManager } from './EngineConnectionManager.js';

const configStore = {
    getAllEngines: vi.fn().mockReturnValue([{ engine_id: 'eng-1', password: 'pw' }]),
    getEngine: vi.fn().mockReturnValue(undefined),
    modifyProfileConfig: vi.fn(),
} as any;

const LOOPBACK = (port = 0) => ({ port, bindAddress: '127.0.0.1' });

/** Ports the manager's dgram server actually bound (spec port 0 = ephemeral). */
function boundPorts(m: EngineConnectionManager): number[] {
    const server = (m as any).server;
    return server.udpListeners.map((l: any) => l.udpSocket.address().port);
}

describe('EngineConnectionManager listeners', () => {
    let mgr: EngineConnectionManager;
    afterEach(async () => {
        await mgr?.stop();
    });

    it('a bare port number becomes a single listener', () => {
        mgr = new EngineConnectionManager(configStore, 3456);
        expect(mgr.dgramListeners).toEqual([{ port: 3456 }]);
    });

    it('binds every listener on start and rebinds live to a new set', async () => {
        mgr = new EngineConnectionManager(configStore, [LOOPBACK()]);
        await mgr.start();
        expect(boundPorts(mgr)).toHaveLength(1);

        await mgr.setListeners([LOOPBACK(), LOOPBACK()]);
        expect(mgr.dgramListeners).toEqual([LOOPBACK(), LOOPBACK()]);
        const ports = boundPorts(mgr);
        expect(ports).toHaveLength(2);
        expect(ports[0]).not.toBe(ports[1]);
    });

    it('a failed rebind restores the previous listeners and rethrows', async () => {
        const blocker = dgram.createSocket('udp4');
        const busy = await new Promise<number>((resolve) =>
            blocker.bind(0, '127.0.0.1', () => resolve(blocker.address().port)),
        );
        mgr = new EngineConnectionManager(configStore, [LOOPBACK()]);
        await mgr.start();
        const before = boundPorts(mgr);

        const liveServer = (mgr as any).server;
        await expect(mgr.setListeners([LOOPBACK(), LOOPBACK(busy)])).rejects.toThrow(/EADDRINUSE/);

        expect(mgr.dgramListeners).toEqual([LOOPBACK()]);
        // The probe rejected the set BEFORE the live server was touched.
        expect((mgr as any).server).toBe(liveServer);
        expect(boundPorts(mgr)).toEqual(before);
        blocker.close();
    });

    it('setListeners before start only swaps the spec (nothing to bind yet)', async () => {
        mgr = new EngineConnectionManager(configStore, [LOOPBACK()]);
        await mgr.setListeners([LOOPBACK(), LOOPBACK()]);
        expect(mgr.dgramListeners).toHaveLength(2);
        await mgr.start();
        expect(boundPorts(mgr)).toHaveLength(2);
    });
});

/** A UDP port free right now (bound once and released). */
async function freePort(): Promise<number> {
    const s = dgram.createSocket('udp4');
    const port = await new Promise<number>((resolve) => s.bind(0, '0.0.0.0', () => resolve(s.address().port)));
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return port;
}

/** The sockets the manager's dgram server holds, as `address:port`. */
function boundSockets(m: EngineConnectionManager): string[] {
    return (m as any).server.udpListeners.map((l: any) => {
        const a = l.udpSocket.address();
        return `${a.address}:${a.port}`;
    });
}

function until(what: string, ms: number, check: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const t = setInterval(() => {
            if (check()) {
                clearInterval(t);
                resolve();
            } else if (Date.now() - started > ms) {
                clearInterval(t);
                reject(new Error(`timeout waiting for ${what}`));
            }
        }, 10);
    });
}

describe('EngineConnectionManager: a listener moves to another address (B-110)', () => {
    let mgr: EngineConnectionManager;
    let engine: Client | undefined;
    let blocker: dgram.Socket | undefined;
    afterEach(async () => {
        engine?.destroy();
        engine = undefined;
        blocker?.close();
        blocker = undefined;
        await mgr?.stop();
    });

    /** An engine on `port` at 127.0.0.1, with the engine's own timeouts (ManagerConnection). */
    async function connectEngine(port: number) {
        const events: string[] = [];
        mgr.on('engineOnline', () => events.push('online'));
        mgr.on('engineOffline', () => events.push('offline'));
        engine = new Client({
            clientId: 'eng-1',
            paths: [{ host: '127.0.0.1', port }],
            encryptionKey: 'pw',
            connectionTimeout: 3000,
            missedKeepaliveThreshold: 3,
        });
        await until('the engine online', 3000, () => mgr.isEngineOnline('eng-1'));
        events.length = 0;
        return events;
    }

    it('moves a port from all interfaces to 127.0.0.1 and back; an engine on it comes back within 3 s', async () => {
        const port = await freePort();
        mgr = new EngineConnectionManager(configStore, [{ port }]);
        await mgr.start();
        const events = await connectEngine(port);

        await mgr.setListeners([{ port, bindAddress: '127.0.0.1' }]);
        expect(boundSockets(mgr)).toEqual([`127.0.0.1:${port}`]);
        expect(mgr.dgramListeners).toEqual([{ port, bindAddress: '127.0.0.1' }]);
        // The rebind ends its session at once; it re-handshakes on its own.
        expect(events).toEqual(['offline']);
        await until('the engine back', 3000, () => mgr.isEngineOnline('eng-1'));

        await mgr.setListeners([{ port }]);
        expect(boundSockets(mgr)).toEqual([`0.0.0.0:${port}`]);
        await until('the engine back again', 3000, () => mgr.isEngineOnline('eng-1'));
        expect(events).toEqual(['offline', 'online', 'offline', 'online']);
    }, 15_000);

    it('swaps the addresses of two listeners on their ports, and their ports between them', async () => {
        const [p, q] = [await freePort(), await freePort()];
        mgr = new EngineConnectionManager(configStore, [{ port: p }, { port: q, bindAddress: '127.0.0.1' }]);
        await mgr.start();

        await mgr.setListeners([{ port: p, bindAddress: '127.0.0.1' }, { port: q }]);
        expect(boundSockets(mgr)).toEqual([`127.0.0.1:${p}`, `0.0.0.0:${q}`]);
        await mgr.setListeners([{ port: q, bindAddress: '127.0.0.1' }, { port: p }]);
        expect(boundSockets(mgr)).toEqual([`127.0.0.1:${q}`, `0.0.0.0:${p}`]);
    }, 15_000);

    it('a move to an address this host lacks is refused before the live server is touched', async () => {
        const port = await freePort();
        mgr = new EngineConnectionManager(configStore, [{ port }]);
        await mgr.start();
        const events = await connectEngine(port);
        const live = (mgr as any).server;

        await expect(mgr.setListeners([{ port, bindAddress: '192.0.2.1' }])).rejects.toThrow(/EADDRNOTAVAIL/);

        expect((mgr as any).server).toBe(live);
        expect(boundSockets(mgr)).toEqual([`0.0.0.0:${port}`]);
        expect(mgr.dgramListeners).toEqual([{ port }]);
        expect(events).toEqual([]);
        expect(mgr.isEngineOnline('eng-1')).toBe(true);
    }, 15_000);

    it('a bind that fails once the old set closed restores the old set, and the engine comes back', async () => {
        const port = await freePort();
        // Another program on the port at another address: all interfaces cannot be bound beside it.
        blocker = dgram.createSocket('udp4');
        await new Promise<void>((resolve) => blocker!.bind(port, '127.0.0.2', () => resolve()));
        mgr = new EngineConnectionManager(configStore, [{ port, bindAddress: '127.0.0.1' }]);
        await mgr.start();
        const events = await connectEngine(port);

        await expect(mgr.setListeners([{ port }])).rejects.toThrow(/EADDRINUSE/);

        expect(boundSockets(mgr)).toEqual([`127.0.0.1:${port}`]);
        expect(mgr.dgramListeners).toEqual([{ port, bindAddress: '127.0.0.1' }]);
        expect((mgr as any).started).toBe(true);
        await until('the engine back', 3000, () => mgr.isEngineOnline('eng-1'));
        expect(events).toEqual(['offline', 'online']);
    }, 15_000);

    it('a no-op apply touches nothing: the same sockets in another order or spelling rebind nothing', async () => {
        const [p, q] = [await freePort(), await freePort()];
        mgr = new EngineConnectionManager(configStore, [{ port: p }, { port: q, bindAddress: '127.0.0.1' }]);
        await mgr.start();
        const events = await connectEngine(q);
        const live = (mgr as any).server;
        const sockets = live.udpListeners.map((l: any) => l.udpSocket);

        await mgr.setListeners([{ port: p }, { port: q, bindAddress: '127.0.0.1' }]);
        await mgr.setListeners([{ port: q, bindAddress: '127.0.0.1' }, { port: p, bindAddress: '0.0.0.0' }]);

        expect((mgr as any).server).toBe(live);
        expect(live.udpListeners.map((l: any) => l.udpSocket)).toEqual(sockets);
        expect(mgr.dgramListeners).toEqual([{ port: q, bindAddress: '127.0.0.1' }, { port: p, bindAddress: '0.0.0.0' }]);
        expect(events).toEqual([]);
        expect(mgr.isEngineOnline('eng-1')).toBe(true);
    }, 15_000);
});
