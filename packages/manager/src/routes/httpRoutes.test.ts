import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { ConfigStore } from '../config/ConfigStore.js';
import { registerHttpRoutes } from './httpRoutes.js';

/**
 * Smoke tests for the engine HTTP routes — focused on the contract the UI
 * relies on and on guarding against credential leaks (issue 1 in the recent
 * review).
 *
 * The dependencies that are NOT under test here (EngineConnectionManager,
 * PluginRegistry, EngineEventForwarder) are mocked to the minimum surface the
 * engine routes touch — `isEngineOnline` and `refreshEncryptionKeys`.
 */

interface TestServer {
    server: http.Server;
    port: number;
    configStore: ConfigStore;
}

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());

    const configStore = new ConfigStore(':memory:');
    const engineManager = {
        isEngineOnline: () => false,
        refreshEncryptionKeys: () => {},
    } as unknown as Parameters<typeof registerHttpRoutes>[0]['engineManager'];
    const pluginRegistry = {
        getAll: () => [],
    } as unknown as Parameters<typeof registerHttpRoutes>[0]['pluginRegistry'];
    const eventForwarder = {
        getEngineData: () => undefined,
    } as unknown as Parameters<typeof registerHttpRoutes>[0]['eventForwarder'];
    const httpServer = http.createServer(app);
    const io = new SocketIOServer(httpServer);

    registerHttpRoutes({
        app,
        configStore,
        engineManager,
        pluginRegistry,
        io,
        eventForwarder,
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    return { server: httpServer, port, configStore };
}

async function stopServer(s: TestServer): Promise<void> {
    s.configStore.close();
    await new Promise<void>((resolve, reject) =>
        s.server.close((err) => (err ? reject(err) : resolve())),
    );
}

interface Response<T> {
    status: number;
    body: T;
}

function request<T = unknown>(
    port: number,
    method: string,
    path: string,
    body?: unknown,
): Promise<Response<T>> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method,
                headers: payload
                    ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
                    : {},
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    let parsed: unknown = text;
                    try {
                        parsed = text ? JSON.parse(text) : null;
                    } catch {
                        /* leave as text */
                    }
                    resolve({ status: res.statusCode ?? 0, body: parsed as T });
                });
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('engine HTTP routes', () => {
    let s: TestServer;

    beforeEach(async () => {
        s = await startServer();
    });

    afterEach(async () => {
        await stopServer(s);
    });

    it('POST /api/v1/engines creates an engine and the response omits the password', async () => {
        const res = await request<Record<string, unknown>>(s.port, 'POST', '/api/v1/engines', {
            engineId: 'eng-1',
            displayName: 'Engine One',
            password: 'super-secret',
        });
        expect(res.status).toBe(201);
        expect(res.body.engine_id).toBe('eng-1');
        expect(res.body.display_name).toBe('Engine One');
        expect(res.body).not.toHaveProperty('password');
        expect(s.configStore.getEngine('eng-1')?.password).toBe('super-secret');
    });

    it('GET /api/v1/engines never returns the password — the dgram-comms shared secret must stay server-side', async () => {
        s.configStore.createEngine('eng-1', 'Engine One', 'super-secret');
        const res = await request<Array<Record<string, unknown>>>(s.port, 'GET', '/api/v1/engines');
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].engine_id).toBe('eng-1');
        expect(res.body[0].display_name).toBe('Engine One');
        expect(res.body[0]).not.toHaveProperty('password');
    });

    it('GET /api/v1/engines/:id is intentionally not exposed — round-tripping the password to the client would defeat the leak fix', async () => {
        s.configStore.createEngine('eng-1', 'Engine One', 'super-secret');
        const res = await request(s.port, 'GET', '/api/v1/engines/eng-1');
        // Express falls through to the SPA fallback / 404 for unmapped API
        // paths — either way, the password must not appear in any response.
        expect(JSON.stringify(res.body)).not.toContain('super-secret');
    });

    it('PUT /api/v1/engines/:id updates the display name without touching the password when password is omitted', async () => {
        s.configStore.createEngine('eng-1', 'Old Name', 'super-secret');
        const res = await request<Record<string, unknown>>(s.port, 'PUT', '/api/v1/engines/eng-1', {
            displayName: 'New Name',
        });
        expect(res.status).toBe(200);
        expect(res.body.display_name).toBe('New Name');
        expect(res.body).not.toHaveProperty('password');
        // Password unchanged in the store.
        expect(s.configStore.getEngine('eng-1')?.password).toBe('super-secret');
    });

    it('PUT /api/v1/engines/:id changes the password when one is supplied', async () => {
        s.configStore.createEngine('eng-1', 'Engine One', 'old-secret');
        const res = await request<Record<string, unknown>>(s.port, 'PUT', '/api/v1/engines/eng-1', {
            displayName: 'Engine One',
            password: 'new-secret',
        });
        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty('password');
        expect(s.configStore.getEngine('eng-1')?.password).toBe('new-secret');
    });

    it('PUT /api/v1/engines/:id 404s for unknown engines', async () => {
        const res = await request<Record<string, unknown>>(
            s.port,
            'PUT',
            '/api/v1/engines/missing',
            { displayName: 'X' },
        );
        expect(res.status).toBe(404);
    });

    it('PUT /api/v1/engines/:id rejects an empty displayName via Zod validation', async () => {
        s.configStore.createEngine('eng-1', 'Engine One', 'pw');
        const res = await request<Record<string, unknown>>(s.port, 'PUT', '/api/v1/engines/eng-1', {
            displayName: '',
        });
        expect(res.status).toBe(400);
    });
});
