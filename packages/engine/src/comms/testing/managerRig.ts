// A real Manager and a router of this engine (routerRig) in one process over loopback
// (#857), not shipped. Clients reach both over Socket.IO, the way a router dashboard,
// the LCP and a manager dashboard do.
import type { AddressInfo } from 'net';
import { vi } from 'vitest';
import { io, type Socket as IoSocket } from 'socket.io-client';
import {
    applyTreeOp,
    getAt,
    splitPath,
    ROUTER_TREE_PATH,
    TREE_PROTOCOL,
    type PatchOp,
} from '@media-router/shared-types';
import { Manager } from '../../../../manager/src/Manager.js';
import { startRouter, until, type RigPlugin } from './routerRig.js';

export { sleep } from './routerRig.js';

const ENGINE = 'e1';
const PROFILE = 'default';
const output = (displayName: string, settings: Record<string, unknown>) => ({
    pluginId: 'audio-output',
    displayName,
    enabled: true,
    settings: { volumeMax: 150, ...settings },
});

/** The profile the manager stores; by default three audio outputs, two of them an interlock. */
export interface RigProfile {
    modules: Record<string, unknown>;
    /** Real modules on the router over these plugins (routerRig's startRouter). */
    plugins?: Record<string, RigPlugin>;
}

function open(url: string, opts: Parameters<typeof io>[1] = {}): Promise<IoSocket> {
    const socket = io(url, { transports: ['websocket'], reconnection: false, ...opts });
    return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}
const request = (socket: IoSocket, event: string, payload: unknown): Promise<any> =>
    new Promise((resolve) => socket.emit(event, payload, resolve));

export async function managerRig(profile?: RigProfile) {
    const manager = new Manager({ httpPort: 0, dgramPort: 0, dbPath: ':memory:' });
    const m = manager as any;
    m.configStore.createEngine(ENGINE, 'Router One', 'pw');
    m.configStore.createProfile(ENGINE, PROFILE, {
        modules: profile?.modules ?? {
            m1: output('Out', { volume: 80 }),
            a: output('A', { audioEnabled: false }),
            b: output('B', { audioEnabled: true }),
        },
        connections: [],
        interlocks: profile ? [] : [{ id: 'ilk1', name: 'Language', members: ['a', 'b'] }],
        running: true,
    });
    m.configStore.setActiveProfile(ENGINE, PROFILE);
    m.engineManager.refreshEncryptionKeys();
    await manager.start();
    const server = m.engineManager.server;
    const router = await startRouter(
        ENGINE,
        server.udpListeners[0].udpSocket.address().port,
        profile?.plugins,
    );
    const moduleIds = Object.keys(router.config().modules ?? {});

    const auth = { proto: TREE_PROTOCOL };
    const routerDash = await open(router.url, { path: ROUTER_TREE_PATH, auth });
    const lcp = await open(router.url);
    /** Every op the LCP got, in order. */
    const lcpOps: PatchOp[] = [];
    lcp.on('configUpdate', (ops: PatchOp[]) => lcpOps.push(...ops));
    const managerDash = await open(
        `http://127.0.0.1:${(m.httpServer.address() as AddressInfo).port}`,
        { auth },
    );
    const mirror: Record<string, unknown> = {};
    /** Every op the manager dashboard got, in order. */
    const seen: PatchOp[] = [];
    managerDash.on('tree', (frame: { ops: PatchOp[] }) => {
        for (const op of frame.ops) {
            seen.push(op);
            applyTreeOp(mirror, op);
        }
    });
    const enginePath = (p: string) => `/engines/${ENGINE}${p}`;
    const patterns = [...moduleIds.map((id) => `/modules/${id}`), '/info'].map(enginePath);
    for (const op of (await request(managerDash, 'sub', { patterns })).data.ops)
        applyTreeOp(mirror, op);
    /** Every op a router dashboard on the modules got, in order. */
    const routerSeen: PatchOp[] = [];
    routerDash.on('tree', (frame: { ops: PatchOp[] }) => routerSeen.push(...frame.ops));
    await request(routerDash, 'sub', { patterns: moduleIds.map((id) => `/modules/${id}`) });

    let writeId = 0;
    const rig = {
        ...router,
        manager: m,
        stored: () => m.configStore.getProfile(ENGINE, PROFILE),
        /** A router dashboard's write; resolves with what the router refused. */
        routerWrite: async (ops: PatchOp[]) =>
            (await request(routerDash, 'write', { id: ++writeId, ops })).data.rejected,
        routerCall: (path: string, method: string) => request(routerDash, 'call', { path, method }),
        lcpPatch: (ops: PatchOp[]) => lcp.emit('patch', { ops }),
        lcpControl: (action: 'start' | 'stop') => lcp.emit(action),
        managerWrite: (ops: PatchOp[]) =>
            request(managerDash, 'write', {
                id: ++writeId,
                ops: ops.map((o) => ({ ...o, path: enginePath(o.path) })),
            }),
        /** What the manager dashboard shows at an engine-relative path. */
        shown: (p: string) => getAt(mirror, splitPath(enginePath(p))),
        seen,
        routerSeen,
        /** What a router dashboard opened now reads at `p`. */
        async routerRead(p: string) {
            const view: Record<string, unknown> = {};
            for (const op of (await request(routerDash, 'sub', { patterns: [p] })).data.ops)
                applyTreeOp(view, op);
            return getAt(view, splitPath(p));
        },
        lcpOps,
        /** Resolves once the manager dashboard shows `value` at `p`, at most `ms` after the call. */
        shows: (p: string, value: unknown, ms = 1000) =>
            until(
                `the manager dashboard to show ${p} = ${JSON.stringify(value)}`,
                ms,
                () => rig.shown(p) === value,
            ),

        /**
         * A drop the router notices and the manager does not: every packet lost
         * both ways, then the client's keepalive watchdog gives the path up (here
         * at once rather than after ~5 s of silence); the link comes back on the
         * session the manager kept. `silent` runs while packets are lost and the
         * link still looks up, `down` once the router knows it is down.
         */
        async blip(during: { silent?: () => Promise<void>; down?: () => Promise<void> } = {}) {
            const client = (router.mc as any).client;
            const cut = [
                vi.spyOn(client, 'onPacket').mockImplementation(() => {}),
                vi.spyOn(server, 'onPacket').mockImplementation(() => {}),
            ];
            await during.silent?.();
            for (const ps of client.pathStates) ps.socket.disconnect();
            await during.down?.();
            for (const spy of cut) spy.mockRestore();
            const before = router.links.length;
            await until('the link back', 5000, () => router.links.length > before);
        },
        /** The manager drops the session (as on its own timeout): the router comes back on a new one. */
        async newSession() {
            const before = router.pushes();
            server.sockets.get(server.clientToSocket.get(ENGINE)).destroy();
            await until(
                'the connect push of a new session',
                10_000,
                () => router.pushes() > before,
            );
        },
        /**
         * A full outage both sides see, then the real reconnect (#857's F2 drill): every packet
         * lost both ways, the router gives the link up and the manager the session; `during`
         * runs then; the link comes back on a new session with its connect push.
         */
        async outage(during: () => Promise<void> = async () => {}) {
            const client = (router.mc as any).client;
            const cut = [
                vi.spyOn(client, 'onPacket').mockImplementation(() => {}),
                vi.spyOn(server, 'onPacket').mockImplementation(() => {}),
            ];
            for (const ps of client.pathStates) ps.socket.disconnect();
            server.sockets.get(server.clientToSocket.get(ENGINE)).destroy();
            await until(
                'the router offline on the manager',
                1000,
                () => !m.engineManager.isEngineOnline(ENGINE),
            );
            await during();
            const before = router.pushes();
            for (const spy of cut) spy.mockRestore();
            await until(
                'the connect push of a new session',
                10_000,
                () => router.pushes() > before,
            );
        },
        async close() {
            for (const s of [routerDash, lcp, managerDash]) s.close();
            await router.close();
            await manager.stop();
        },
    };
    return rig;
}
