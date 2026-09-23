import { describe, it, expect, afterEach, vi } from 'vitest';
import * as dgram from 'dgram';
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
