import { createServer, type Server } from 'http';
import { isIPv4, type AddressInfo } from 'net';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { createLogger, CreateEngineProfileSchema } from '@media-router/shared-types';
import type { Engine } from '../Engine.js';

const log = createLogger('ApiServer');

/** A refused peer is logged at most once a minute per address. */
const REFUSAL_LOG_MS = 60_000;

/**
 * Create and configure the Fastify Local API server. It answers only the box itself (B-114):
 * it listens on 127.0.0.1 and ::1, refuses any other peer and sends no CORS headers.
 */
export async function createApiServer(engine: Engine, port = 3001) {
    const app = Fastify({ logger: false });
    refuseOtherHosts(app);

    // Register route modules
    registerHealthRoutes(app, engine);
    registerEngineRoutes(app, engine);
    registerProfileRoutes(app, engine);
    registerSystemRoutes(app, engine);
    registerAudioRoutes(app, engine);

    let ipv6: Server | null = null;
    app.addHook('onClose', async () => {
        const server = ipv6;
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await app.listen({ port, host: '127.0.0.1' });
    try {
        ipv6 = await listenIpv6Loopback(app, (app.server.address() as AddressInfo).port);
    } catch (err) {
        await app.close();
        throw err;
    }
    log.info({ port, hosts: ipv6 ? ['127.0.0.1', '::1'] : ['127.0.0.1'] }, 'Local API listening');
    return app;
}

/**
 * ::1 beside Fastify's 127.0.0.1, on the same routes: Fastify binds both only for 'localhost',
 * which follows /etc/hosts. A host without IPv6 serves 127.0.0.1 alone.
 */
async function listenIpv6Loopback(
    app: ReturnType<typeof Fastify>,
    port: number,
): Promise<Server | null> {
    const server = createServer((req, res) => app.routing(req, res));
    server.keepAliveTimeout = app.server.keepAliveTimeout;
    server.requestTimeout = app.server.requestTimeout;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen({ port, host: '::1' }, () => {
                server.off('error', reject);
                resolve();
            });
        });
        return server;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') throw err;
        log.warn({ code }, 'No IPv6 loopback: the Local API listens on 127.0.0.1 only');
        return null;
    }
}

/**
 * 403 with no body to every request whose peer is not loopback. The peer is the raw socket's
 * address, never a forwarded header, so a DNAT to loopback is refused too.
 */
function refuseOtherHosts(app: ReturnType<typeof Fastify>): void {
    const lastLogged = new Map<string, number>();
    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
        const peer = req.raw.socket.remoteAddress;
        if (isLoopback(peer)) return;
        logRefusal(lastLogged, peer ?? 'unknown');
        return reply.code(403).send();
    });
}

/** 127.0.0.0/8, ::1 and the IPv4-mapped ::ffff:127.0.0.0/104. */
function isLoopback(address: string | undefined): boolean {
    if (address === '::1') return true;
    const v4 = address?.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
    return v4 !== undefined && isIPv4(v4) && v4.startsWith('127.');
}

/** One line per refused address a minute; entries a minute old go at each line. */
function logRefusal(lastLogged: Map<string, number>, peer: string): void {
    const now = Date.now();
    const last = lastLogged.get(peer);
    if (last !== undefined && now - last < REFUSAL_LOG_MS) return;
    for (const [address, at] of lastLogged) {
        if (now - at >= REFUSAL_LOG_MS) lastLogged.delete(address);
    }
    lastLogged.set(peer, now);
    log.warn({ peer }, 'Local API refused a request from another host');
}

function registerHealthRoutes(app: ReturnType<typeof Fastify>, engine: Engine): void {
    app.get('/api/v1/health', async () => {
        return {
            status: 'ok',
            uptime: process.uptime(),
            moduleCount: engine.moduleManager.size,
            memoryUsage: Math.round(process.memoryUsage().rss / 1024 / 1024),
        };
    });

    app.get('/api/v1/system', async () => {
        const os = await import('os');
        return {
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
            cpus: os.cpus().length,
            totalMemory: Math.round(os.totalmem() / 1024 / 1024),
            nodeVersion: process.version,
        };
    });
}

function registerEngineRoutes(app: ReturnType<typeof Fastify>, engine: Engine): void {
    // Live state of every manager path on the active profile (issue #692) —
    // polled by device-manager so its profile editor can show a dot per path.
    app.get('/api/v1/manager/status', async () => ({
        connected: engine.managerConnection.isConnected,
        paths: engine.managerConnection.pathDetails,
    }));
    app.get('/api/v1/engine/status', async () => {
        return {
            running: engine.running,
            moduleCount: engine.moduleManager.size,
            connectedToManager: engine.managerConnection.isConnected,
            plugins: engine.pluginLoader.getManifests().map((m) => m.pluginId),
        };
    });

    app.post('/api/v1/engine/start', async () => {
        await engine.startModules();
        return { ok: true };
    });

    app.post('/api/v1/engine/stop', async () => {
        await engine.stopModules();
        return { ok: true };
    });

    app.post('/api/v1/engine/restart', async () => {
        await engine.stopModules();
        await engine.startModules();
        return { ok: true };
    });
}

function registerProfileRoutes(app: ReturnType<typeof Fastify>, engine: Engine): void {
    app.get('/api/v1/profiles', async () => {
        return engine.profileStore.getAll();
    });

    app.post('/api/v1/profiles', async (req: FastifyRequest, reply: FastifyReply) => {
        const result = CreateEngineProfileSchema.safeParse(req.body);
        if (!result.success) {
            const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            log.warn({ details }, 'POST /api/v1/profiles validation failed');
            return reply.status(400).send({ error: 'Validation failed', details });
        }
        const body = result.data;

        const paths = body.paths ?? [{ host: body.managerHost, port: body.managerPort }];

        engine.profileStore.create({
            name: body.name,
            paths,
            encryptionKey: body.password,
        });

        return { ok: true, name: body.name };
    });

    app.get('/api/v1/profiles/:name', async (req: FastifyRequest) => {
        const { name } = req.params as { name: string };
        const profile = engine.profileStore.get(name);
        if (!profile) return { error: 'Profile not found' };
        return profile;
    });

    app.put('/api/v1/profiles/:name', async (req: FastifyRequest) => {
        const { name } = req.params as { name: string };
        const body = req.body as Record<string, unknown>;
        engine.profileStore.update(name, body);
        return { ok: true };
    });

    app.delete('/api/v1/profiles/:name', async (req: FastifyRequest) => {
        const { name } = req.params as { name: string };
        engine.profileStore.delete(name);
        return { ok: true };
    });

    app.post('/api/v1/profiles/:name/activate', async (req: FastifyRequest) => {
        const { name } = req.params as { name: string };
        engine.profileStore.activate(name);
        // Reconnect to manager with new profile
        await engine.reconnectManager();
        return { ok: true, active: name };
    });
}

/** `:type` matches the `x-deviceType` string in a plugin's configSchema. 404 for unregistered types. */
function registerSystemRoutes(app: ReturnType<typeof Fastify>, engine: Engine): void {
    app.get(
        '/api/v1/system/devices/:type',
        async (req: FastifyRequest<{ Params: { type: string } }>, reply: FastifyReply) => {
            try {
                return await engine.deviceProviders.getDevices(req.params.type);
            } catch (err) {
                reply.code(404);
                return { error: (err as Error).message };
            }
        },
    );
}

function registerAudioRoutes(app: ReturnType<typeof Fastify>, engine: Engine): void {
    const pwManager = engine.pipeWire;

    // pw-link state — still audio-specific because it's about PipeWire link
    // introspection, not device enumeration.
    app.get('/api/v1/audio/links', async () => {
        return pwManager.getLinks();
    });
}
