import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { createLogger } from '@media-router/shared-types';
import type { Engine } from '../Engine.js';

const log = createLogger('ApiServer');

/**
 * Create and configure the Fastify Local API server.
 */
export async function createApiServer(engine: Engine, port = 3001) {
    const app = Fastify({ logger: false });

    await app.register(cors, { origin: true });

    // Register route modules
    registerHealthRoutes(app, engine);
    registerEngineRoutes(app, engine);
    registerProfileRoutes(app, engine);
    registerAudioRoutes(app, engine);

    await app.listen({ port, host: '0.0.0.0' });
    log.info({ port }, 'Local API listening');
    return app;
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

    app.post('/api/v1/profiles', async (req: FastifyRequest) => {
        const body = req.body as {
            name: string;
            managerHost: string;
            managerPort: number;
            password: string;
            paths?: Array<{ host: string; port: number; bindInterface?: string; bindAddress?: string }>;
        };

        if (!body.name || !body.managerHost || !body.managerPort || !body.password) {
            return { error: 'name, managerHost, managerPort, and password are required' };
        }

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

function registerAudioRoutes(app: ReturnType<typeof Fastify>, engine: Engine): void {
    const pwManager = engine.pipeWire;

    app.get('/api/v1/audio/devices', async () => {
        return pwManager.listDevices();
    });

    app.get('/api/v1/audio/links', async () => {
        return pwManager.getLinks();
    });
}
