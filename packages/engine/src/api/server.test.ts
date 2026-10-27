import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { get } from 'http';
import { connect, createServer, Server, SocketAddress, type AddressInfo } from 'net';
import { endianness, networkInterfaces } from 'os';
import { setLogTap } from '@media-router/shared-types';
import type { Engine } from '../Engine.js';
import { createApiServer } from './server.js';

type Api = Awaited<ReturnType<typeof createApiServer>>;

function mockEngine() {
    return {
        running: true,
        moduleManager: { size: 3 },
        managerConnection: {
            isConnected: true,
            pathDetails: [{ host: '10.0.0.1', port: 3000, connected: true }],
        },
        pluginLoader: {
            getManifests: vi
                .fn()
                .mockReturnValue([{ pluginId: 'audio-input' }, { pluginId: 'audio-encoder' }]),
        },
        profileStore: {
            getAll: vi
                .fn()
                .mockReturnValue([{ name: 'prod', paths: [{ host: '10.0.0.1', port: 3000 }] }]),
            get: vi.fn((name: string) => {
                if (name === 'prod')
                    return { name: 'prod', paths: [{ host: '10.0.0.1', port: 3000 }] };
                return undefined;
            }),
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            activate: vi.fn(),
        },
        deviceProviders: { getDevices: vi.fn().mockResolvedValue([]) },
        pipeWire: { getLinks: vi.fn().mockReturnValue([]) },
        startModules: vi.fn().mockResolvedValue(undefined),
        stopModules: vi.fn().mockResolvedValue(undefined),
        reconnectManager: vi.fn().mockResolvedValue(undefined),
    };
}

const start = (engine: ReturnType<typeof mockEngine>, port = 0) =>
    createApiServer(engine as unknown as Engine, port);
const portOf = (app: Api) => (app.server.address() as AddressInfo).port;

/** The addresses listening on `port`, as `ss -ltn` shows them (/proc/net/tcp and tcp6). */
function listening(port: number): string[] {
    const found: string[] = [];
    const tables = [
        ['/proc/net/tcp', 'ipv4'],
        ['/proc/net/tcp6', 'ipv6'],
    ] as const;
    for (const [file, family] of tables.filter(([f]) => existsSync(f))) {
        for (const row of readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
            const [, local, , state] = row.trim().split(/\s+/);
            const [hex, hexPort] = local.split(':');
            if (state !== '0A' || parseInt(hexPort, 16) !== port) continue;
            // The kernel prints each 32-bit word of the address in host byte order.
            const b = Buffer.from(hex, 'hex');
            if (endianness() === 'LE')
                for (let i = 0; i < b.length; i += 4) b.subarray(i, i + 4).reverse();
            const text =
                family === 'ipv4' ? b.join('.') : b.toString('hex').replace(/(.{4})(?!$)/g, '$1:');
            found.push(new SocketAddress({ address: text, family }).address);
        }
    }
    return found.sort();
}

/** GET over a real socket: the status, or the connect error's code. */
function httpGet(host: string, port: number, path = '/api/v1/health'): Promise<number | string> {
    return new Promise((resolve) => {
        const req = get({ host, port, path, timeout: 2000 }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
        req.on('timeout', () =>
            req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
        );
    });
}

/** Whether a TCP connect to host:port is accepted. */
function connects(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port, timeout: 2000 });
        socket.once('connect', () => (socket.destroy(), resolve(true)));
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => (socket.destroy(), resolve(false)));
    });
}

/** This host's own IPv4 addresses that are not loopback. */
const lanAddresses = () =>
    Object.values(networkInterfaces())
        .flatMap((list) => list ?? [])
        .filter((a) => a.family === 'IPv4' && !a.internal)
        .map((a) => a.address);

/** The ApiServer warnings logged while `run` runs, as JSON. */
async function warnings(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
    const lines: Array<Record<string, unknown>> = [];
    setLogTap((l) => {
        const line = JSON.parse(l) as Record<string, unknown>;
        if (line.name === 'ApiServer' && line.level === 40) lines.push(line);
    });
    try {
        await run();
        await new Promise((r) => setImmediate(r));
    } finally {
        setLogTap(null);
    }
    return lines;
}

describe('Engine API Server', () => {
    let app: Api;
    let engine: ReturnType<typeof mockEngine>;

    beforeEach(async () => {
        engine = mockEngine();
        app = await start(engine);
    });

    afterEach(async () => {
        await app.close();
    });

    // --- Health ---

    it('GET /api/v1/health returns status', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('ok');
        expect(body.moduleCount).toBe(3);
        expect(typeof body.uptime).toBe('number');
    });

    it('GET /api/v1/system returns system info', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/system' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(typeof body.hostname).toBe('string');
        expect(body.cpus).toBeGreaterThan(0);
        expect(typeof body.nodeVersion).toBe('string');
    });

    // --- Engine ---

    it('GET /api/v1/manager/status returns per-path live state (#692)', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/manager/status' });
        expect(JSON.parse(res.payload)).toEqual({
            connected: true,
            paths: [{ host: '10.0.0.1', port: 3000, connected: true }],
        });
    });

    it('GET /api/v1/engine/status returns engine state', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/engine/status' });
        const body = JSON.parse(res.payload);
        expect(body.running).toBe(true);
        expect(body.moduleCount).toBe(3);
        expect(body.connectedToManager).toBe(true);
        expect(body.plugins).toEqual(['audio-input', 'audio-encoder']);
    });

    it('POST /api/v1/engine/start calls startModules', async () => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/engine/start' });
        expect(JSON.parse(res.payload)).toEqual({ ok: true });
        expect(engine.startModules).toHaveBeenCalled();
    });

    it('POST /api/v1/engine/stop calls stopModules', async () => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/engine/stop' });
        expect(JSON.parse(res.payload)).toEqual({ ok: true });
        expect(engine.stopModules).toHaveBeenCalled();
    });

    // --- Profiles ---

    it('GET /api/v1/profiles returns all profiles', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/profiles' });
        const body = JSON.parse(res.payload);
        expect(body).toHaveLength(1);
        expect(body[0].name).toBe('prod');
    });

    it('POST /api/v1/profiles creates a profile', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/profiles',
            payload: {
                name: 'staging',
                managerHost: '10.0.0.2',
                managerPort: 3000,
                password: 'secret',
            },
        });
        const body = JSON.parse(res.payload);
        expect(body.ok).toBe(true);
        expect(body.name).toBe('staging');
        expect(engine.profileStore.create).toHaveBeenCalledWith({
            name: 'staging',
            paths: [{ host: '10.0.0.2', port: 3000 }],
            encryptionKey: 'secret',
        });
    });

    it('POST /api/v1/profiles rejects missing fields', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/profiles',
            payload: { name: 'test' }, // missing managerHost, managerPort, password
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toBe('Validation failed');
        expect(engine.profileStore.create).not.toHaveBeenCalled();
    });

    it('GET /api/v1/profiles/:name returns profile', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/profiles/prod' });
        const body = JSON.parse(res.payload);
        expect(body.name).toBe('prod');
    });

    it('GET /api/v1/profiles/:name returns error for missing profile', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/profiles/nonexistent' });
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('Profile not found');
    });

    it('DELETE /api/v1/profiles/:name deletes profile', async () => {
        const res = await app.inject({ method: 'DELETE', url: '/api/v1/profiles/prod' });
        expect(JSON.parse(res.payload)).toEqual({ ok: true });
        expect(engine.profileStore.delete).toHaveBeenCalledWith('prod');
    });

    it('POST /api/v1/profiles/:name/activate activates and reconnects', async () => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/profiles/prod/activate' });
        const body = JSON.parse(res.payload);
        expect(body.ok).toBe(true);
        expect(body.active).toBe('prod');
        expect(engine.profileStore.activate).toHaveBeenCalledWith('prod');
        expect(engine.reconnectManager).toHaveBeenCalled();
    });

    // --- The box itself only (B-114) ---

    it('listens on 127.0.0.1 and ::1 only', async () => {
        const port = portOf(app);
        expect(listening(port)).toEqual(['127.0.0.1', '::1']);
        for (const address of lanAddresses()) expect(await connects(address, port)).toBe(false);
    });

    it('serves the box itself: 127.0.0.1, 127.0.0.2, ::1 and ::ffff:127.0.0.1', async () => {
        for (const remoteAddress of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
            const res = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress });
            expect(res.statusCode, remoteAddress).toBe(200);
            expect(JSON.parse(res.payload).status).toBe('ok');
        }
    });

    it('serves real sockets on 127.0.0.1 and ::1', async () => {
        expect(await httpGet('127.0.0.1', portOf(app))).toBe(200);
        expect(await httpGet('::1', portOf(app))).toBe(200);
    });

    it('refuses every other peer with 403 and no body', async () => {
        const peers = [
            '10.1.2.3',
            '198.51.100.123',
            '::ffff:10.1.2.3',
            '::ffff:198.51.100.123',
            '2001:db8::7',
        ];
        const requests = [
            { method: 'GET', url: '/api/v1/health' },
            { method: 'GET', url: '/api/v1/profiles' },
            {
                method: 'POST',
                url: '/api/v1/profiles',
                payload: { name: 'x', managerHost: 'h', managerPort: 1, password: 'p' },
            },
            { method: 'POST', url: '/api/v1/profiles/prod/activate' },
            { method: 'DELETE', url: '/api/v1/profiles/prod' },
            { method: 'POST', url: '/api/v1/engine/stop' },
            { method: 'GET', url: '/no/such/route' },
        ] as const;
        for (const remoteAddress of peers) {
            for (const r of requests) {
                const res = await app.inject({ ...r, remoteAddress });
                expect(res.statusCode, `${remoteAddress} ${r.method} ${r.url}`).toBe(403);
                expect(res.payload).toBe('');
            }
        }
        expect(engine.profileStore.getAll).not.toHaveBeenCalled();
        expect(engine.profileStore.create).not.toHaveBeenCalled();
        expect(engine.profileStore.activate).not.toHaveBeenCalled();
        expect(engine.profileStore.delete).not.toHaveBeenCalled();
        expect(engine.stopModules).not.toHaveBeenCalled();
    });

    it('reads the peer from the socket, never a forwarded header', async () => {
        const forwarded = {
            'x-forwarded-for': '127.0.0.1',
            'x-real-ip': '127.0.0.1',
            forwarded: 'for=127.0.0.1',
        };
        const outside = await app.inject({
            method: 'GET',
            url: '/api/v1/health',
            remoteAddress: '10.1.2.3',
            headers: forwarded,
        });
        expect(outside.statusCode).toBe(403);
        const inside = await app.inject({
            method: 'GET',
            url: '/api/v1/health',
            headers: { 'x-forwarded-for': '10.1.2.3' },
        });
        expect(inside.statusCode).toBe(200);
    });

    it('sends no CORS headers on any response', async () => {
        const origin = { origin: 'http://example.com' };
        const profile = { name: 'x', managerHost: 'h', managerPort: 1, password: 'p' };
        const responses = [
            await app.inject({ method: 'GET', url: '/api/v1/health', headers: origin }),
            await app.inject({ method: 'GET', url: '/api/v1/profiles', headers: origin }),
            await app.inject({
                method: 'POST',
                url: '/api/v1/profiles',
                headers: origin,
                payload: profile,
            }),
            await app.inject({ method: 'GET', url: '/no/such/route', headers: origin }),
            await app.inject({
                method: 'GET',
                url: '/api/v1/health',
                headers: origin,
                remoteAddress: '10.1.2.3',
            }),
        ];
        expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 404, 403]);
        for (const res of responses) {
            expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual(
                [],
            );
        }
    });

    it('does not grant a cross-origin preflight', async () => {
        const preflight = await app.inject({
            method: 'OPTIONS',
            url: '/api/v1/profiles',
            headers: {
                origin: 'http://example.com',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'content-type',
            },
        });
        expect(
            Object.keys(preflight.headers).filter((h) => h.startsWith('access-control-')),
        ).toEqual([]);
        expect(preflight.statusCode).toBe(404);
    });

    it('logs a refused peer once per address and minute', async () => {
        // Only the clock is faked: the inject keeps its own timers. 59 s and 61 s pin the minute.
        vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
        const refused = (remoteAddress: string) =>
            app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress });
        try {
            const lines = await warnings(async () => {
                await refused('10.1.2.3');
                await refused('10.1.2.3');
                await refused('198.51.100.123');
                await app.inject({ method: 'GET', url: '/api/v1/health' });
                vi.setSystemTime(1_059_000);
                await refused('10.1.2.3');
                vi.setSystemTime(1_061_000);
                await refused('10.1.2.3');
                await refused('198.51.100.123');
                vi.setSystemTime(1_062_000);
                await refused('10.1.2.3');
            });
            const at = (ms: number) => new Date(ms).toISOString();
            expect(lines.map((l) => [l.peer, l.msg, l.time])).toEqual([
                ['10.1.2.3', 'Local API refused a request from another host', at(1_000_000)],
                ['198.51.100.123', 'Local API refused a request from another host', at(1_000_000)],
                ['10.1.2.3', 'Local API refused a request from another host', at(1_061_000)],
                ['198.51.100.123', 'Local API refused a request from another host', at(1_061_000)],
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Engine API Server: a host without IPv6, a port taken (B-114)', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])(
        'starts on 127.0.0.1 alone when ::1 fails with %s',
        async (code) => {
            const listen = Server.prototype.listen;
            vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
                this: Server,
                ...args: unknown[]
            ) {
                const options = args[0] as { host?: string } | undefined;
                if (options?.host !== '::1')
                    return listen.apply(this, args as Parameters<Server['listen']>);
                process.nextTick(() =>
                    this.emit('error', Object.assign(new Error(`listen ${code} ::1`), { code })),
                );
                return this;
            });
            let app: Api | undefined;
            const lines = await warnings(async () => {
                app = await start(mockEngine());
            });
            vi.restoreAllMocks();
            try {
                expect(listening(portOf(app!))).toEqual(['127.0.0.1']);
                expect(await httpGet('127.0.0.1', portOf(app!))).toBe(200);
                expect(lines.map((l) => [l.code, l.msg])).toEqual([
                    [code, 'No IPv6 loopback: the Local API listens on 127.0.0.1 only'],
                ]);
            } finally {
                await app?.close();
            }
        },
    );

    it('fails to start when another program holds ::1 on its port, and frees 127.0.0.1', async () => {
        const holder = createServer();
        await new Promise<void>((resolve) => holder.listen({ port: 0, host: '::1' }, resolve));
        const port = (holder.address() as AddressInfo).port;
        try {
            await expect(start(mockEngine(), port)).rejects.toMatchObject({
                code: 'EADDRINUSE',
                address: '::1',
            });
            expect(listening(port)).toEqual(['::1']);
        } finally {
            await new Promise((resolve) => holder.close(resolve));
        }
    });

    it('closes both listeners', async () => {
        const app = await start(mockEngine());
        const port = portOf(app);
        await app.close();
        expect(listening(port)).toEqual([]);
        expect(await connects('127.0.0.1', port)).toBe(false);
        expect(await connects('::1', port)).toBe(false);
    });
});
