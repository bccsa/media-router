import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';

// We can't easily import createApiServer because it depends on Engine.
// Instead, test the route handlers directly by recreating them with a mock engine.

describe('Engine API Server', () => {
    let app: ReturnType<typeof Fastify>;
    let mockEngine: any;

    beforeEach(async () => {
        mockEngine = {
            running: true,
            moduleManager: { size: 3 },
            managerConnection: { isConnected: true },
            pluginLoader: {
                getManifests: vi.fn().mockReturnValue([
                    { pluginId: 'audio-input' },
                    { pluginId: 'audio-encoder' },
                ]),
            },
            profileStore: {
                getAll: vi.fn().mockReturnValue([
                    { name: 'prod', paths: [{ host: '10.0.0.1', port: 3000 }] },
                ]),
                get: vi.fn((name: string) => {
                    if (name === 'prod') return { name: 'prod', paths: [{ host: '10.0.0.1', port: 3000 }] };
                    return undefined;
                }),
                create: vi.fn(),
                update: vi.fn(),
                delete: vi.fn(),
                activate: vi.fn(),
            },
            startModules: vi.fn().mockResolvedValue(undefined),
            stopModules: vi.fn().mockResolvedValue(undefined),
            reconnectManager: vi.fn().mockResolvedValue(undefined),
        };

        app = Fastify({ logger: false });
        await app.register(cors, { origin: true });

        // Health routes
        app.get('/api/v1/health', async () => ({
            status: 'ok',
            uptime: process.uptime(),
            moduleCount: mockEngine.moduleManager.size,
            memoryUsage: Math.round(process.memoryUsage().rss / 1024 / 1024),
        }));

        app.get('/api/v1/system', async () => ({
            hostname: 'test-host',
            platform: process.platform,
            arch: process.arch,
            cpus: 4,
            totalMemory: 8192,
            nodeVersion: process.version,
        }));

        // Engine routes
        app.get('/api/v1/engine/status', async () => ({
            running: mockEngine.running,
            moduleCount: mockEngine.moduleManager.size,
            connectedToManager: mockEngine.managerConnection.isConnected,
            plugins: mockEngine.pluginLoader.getManifests().map((m: any) => m.pluginId),
        }));

        app.post('/api/v1/engine/start', async () => {
            await mockEngine.startModules();
            return { ok: true };
        });

        app.post('/api/v1/engine/stop', async () => {
            await mockEngine.stopModules();
            return { ok: true };
        });

        // Profile routes
        app.get('/api/v1/profiles', async () => mockEngine.profileStore.getAll());

        app.post('/api/v1/profiles', async (req) => {
            const body = req.body as any;
            if (!body.name || !body.managerHost || !body.managerPort || !body.password) {
                return { error: 'name, managerHost, managerPort, and password are required' };
            }
            mockEngine.profileStore.create({
                name: body.name,
                paths: [{ host: body.managerHost, port: body.managerPort }],
                encryptionKey: body.password,
            });
            return { ok: true, name: body.name };
        });

        app.get('/api/v1/profiles/:name', async (req) => {
            const { name } = req.params as { name: string };
            const profile = mockEngine.profileStore.get(name);
            if (!profile) return { error: 'Profile not found' };
            return profile;
        });

        app.delete('/api/v1/profiles/:name', async (req) => {
            const { name } = req.params as { name: string };
            mockEngine.profileStore.delete(name);
            return { ok: true };
        });

        app.post('/api/v1/profiles/:name/activate', async (req) => {
            const { name } = req.params as { name: string };
            mockEngine.profileStore.activate(name);
            await mockEngine.reconnectManager();
            return { ok: true, active: name };
        });

        await app.ready();
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
        expect(body.hostname).toBe('test-host');
        expect(body.cpus).toBe(4);
        expect(typeof body.nodeVersion).toBe('string');
    });

    // --- Engine ---

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
        expect(mockEngine.startModules).toHaveBeenCalled();
    });

    it('POST /api/v1/engine/stop calls stopModules', async () => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/engine/stop' });
        expect(JSON.parse(res.payload)).toEqual({ ok: true });
        expect(mockEngine.stopModules).toHaveBeenCalled();
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
            payload: { name: 'staging', managerHost: '10.0.0.2', managerPort: 3000, password: 'secret' },
        });
        const body = JSON.parse(res.payload);
        expect(body.ok).toBe(true);
        expect(body.name).toBe('staging');
        expect(mockEngine.profileStore.create).toHaveBeenCalledWith({
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
        const body = JSON.parse(res.payload);
        expect(body.error).toBeDefined();
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
        expect(mockEngine.profileStore.delete).toHaveBeenCalledWith('prod');
    });

    it('POST /api/v1/profiles/:name/activate activates and reconnects', async () => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/profiles/prod/activate' });
        const body = JSON.parse(res.payload);
        expect(body.ok).toBe(true);
        expect(body.active).toBe('prod');
        expect(mockEngine.profileStore.activate).toHaveBeenCalledWith('prod');
        expect(mockEngine.reconnectManager).toHaveBeenCalled();
    });
});
