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

describe('engine groups + ordering HTTP routes', () => {
    let s: TestServer;

    beforeEach(async () => {
        s = await startServer();
    });

    afterEach(async () => {
        await stopServer(s);
    });

    it('GET /api/v1/engine-groups returns the default Ungrouped group on first start', async () => {
        const res = await request<Array<Record<string, unknown>>>(
            s.port,
            'GET',
            '/api/v1/engine-groups',
        );
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].id).toBe('ungrouped');
    });

    it('POST /api/v1/engine-groups creates a group and returns it', async () => {
        const res = await request<Record<string, unknown>>(
            s.port,
            'POST',
            '/api/v1/engine-groups',
            { name: 'Studio' },
        );
        expect(res.status).toBe(201);
        expect(res.body.name).toBe('Studio');
        expect(typeof res.body.id).toBe('string');
    });

    it('PUT /api/v1/engine-groups/:id updates a group', async () => {
        s.configStore.createGroup('grp1', 'Studio');
        const res = await request<Record<string, unknown>>(
            s.port,
            'PUT',
            '/api/v1/engine-groups/grp1',
            { name: 'On-Air', collapsed: true },
        );
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('On-Air');
        expect(res.body.collapsed).toBe(1);
    });

    it('DELETE /api/v1/engine-groups/:id refuses to remove the default group', async () => {
        const res = await request<Record<string, unknown>>(
            s.port,
            'DELETE',
            '/api/v1/engine-groups/ungrouped',
        );
        expect(res.status).toBe(400);
    });

    it('DELETE /api/v1/engine-groups/:id removes a custom group and reassigns engines', async () => {
        s.configStore.createEngine('e1', 'E1', 'p');
        s.configStore.createGroup('grp1', 'Studio');
        s.configStore.reorderEngines([
            { engineId: 'e1', groupId: 'grp1', sortOrder: 0 },
        ]);
        const res = await request<Record<string, unknown>>(
            s.port,
            'DELETE',
            '/api/v1/engine-groups/grp1',
        );
        expect(res.status).toBe(200);
        expect(s.configStore.getGroup('grp1')).toBeUndefined();
        expect(s.configStore.getEngine('e1')!.group_id).toBe('ungrouped');
    });

    it('PUT /api/v1/engine-groups/reorder reorders groups', async () => {
        s.configStore.createGroup('a', 'A');
        s.configStore.createGroup('b', 'B');
        const res = await request<Record<string, unknown>>(
            s.port,
            'PUT',
            '/api/v1/engine-groups/reorder',
            { orderedIds: ['b', 'a', 'ungrouped'] },
        );
        expect(res.status).toBe(200);
        const groups = s.configStore.getAllGroups();
        expect(groups.map((g) => g.id)).toEqual(['b', 'a', 'ungrouped']);
    });

    it('PUT /api/v1/engines/reorder moves engines between groups', async () => {
        s.configStore.createEngine('e1', 'E1', 'p');
        s.configStore.createEngine('e2', 'E2', 'p');
        s.configStore.createGroup('grp1', 'Studio');
        const res = await request<Record<string, unknown>>(
            s.port,
            'PUT',
            '/api/v1/engines/reorder',
            {
                updates: [
                    { engineId: 'e1', groupId: 'grp1', sortOrder: 0 },
                    { engineId: 'e2', groupId: 'ungrouped', sortOrder: 0 },
                ],
            },
        );
        expect(res.status).toBe(200);
        expect(s.configStore.getEngine('e1')!.group_id).toBe('grp1');
        expect(s.configStore.getEngine('e2')!.group_id).toBe('ungrouped');
    });

    it('PUT /api/v1/engines/reorder rejects moves into unknown groups', async () => {
        s.configStore.createEngine('e1', 'E1', 'p');
        const res = await request<Record<string, unknown>>(
            s.port,
            'PUT',
            '/api/v1/engines/reorder',
            {
                updates: [{ engineId: 'e1', groupId: 'nonexistent', sortOrder: 0 }],
            },
        );
        expect(res.status).toBe(400);
    });

    it('POST /api/v1/engine-groups accepts a color and rejects malformed hex', async () => {
        const ok = await request<Record<string, unknown>>(s.port, 'POST', '/api/v1/engine-groups', {
            name: 'Studio',
            color: '#10b981',
        });
        expect(ok.status).toBe(201);
        expect(ok.body.color).toBe('#10b981');

        const bad = await request<Record<string, unknown>>(
            s.port,
            'POST',
            '/api/v1/engine-groups',
            { name: 'Bad', color: 'not-a-color' },
        );
        expect(bad.status).toBe(400);
    });

    it('PUT /api/v1/engine-groups/:id can clear color via null', async () => {
        s.configStore.createGroup('grp1', 'Studio', '#10b981');
        const res = await request<Record<string, unknown>>(
            s.port,
            'PUT',
            '/api/v1/engine-groups/grp1',
            { color: null },
        );
        expect(res.status).toBe(200);
        expect(res.body.color).toBeNull();
    });

    it('GET /api/v1/engines returns engines sorted by sort_order with group_id', async () => {
        s.configStore.createEngine('first', 'First', 'p');
        s.configStore.createEngine('second', 'Second', 'p');
        s.configStore.reorderEngines([
            { engineId: 'second', groupId: 'ungrouped', sortOrder: 0 },
            { engineId: 'first', groupId: 'ungrouped', sortOrder: 1 },
        ]);
        const res = await request<Array<Record<string, unknown>>>(
            s.port,
            'GET',
            '/api/v1/engines',
        );
        expect(res.status).toBe(200);
        expect(res.body.map((e) => e.engine_id)).toEqual(['second', 'first']);
        expect(res.body[0].group_id).toBe('ungrouped');
    });
});
