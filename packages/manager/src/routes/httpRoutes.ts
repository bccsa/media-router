import type { Application } from 'express';
import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('HttpRoutes');

export interface HttpRouteDeps {
    app: Application;
}

/**
 * Register the HTTP surface. After the v2.0 API consolidation this is just:
 *
 *   - `GET /health` for external monitoring
 *   - Static asset serving for the built manager-ui SPA
 *   - SPA fallback for client-side router paths
 *
 * The application API (engines, groups, profiles, plugins, devices) moved
 * to Socket.IO RPC events with ack callbacks — see `socket/rpcHandlers.ts`.
 * One channel, one auth boundary, one place for the state-change broadcasts
 * that the same channel was already doing.
 */
export function registerHttpRoutes(deps: HttpRouteDeps): void {
    const { app } = deps;

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });

    const uiDistPath = path.resolve(__dirname, '../../../manager-ui/dist');
    if (fs.existsSync(uiDistPath)) {
        // Hashed assets (*.js, *.css) — cache forever (hash changes on rebuild).
        app.use(
            '/assets',
            express.static(path.join(uiDistPath, 'assets'), {
                maxAge: '1y',
                immutable: true,
            }),
        );
        // index.html — never cache (so browser always gets latest asset references).
        app.use(express.static(uiDistPath, { maxAge: 0, etag: false }));
        app.get('/{*path}', (req, res) => {
            // /socket.io is served by the Socket.IO engine, not us — let
            // 404 surface there if anything else hits the prefix. Health
            // stays the only HTTP API endpoint.
            if (req.path.startsWith('/health') || req.path.startsWith('/socket.io')) {
                res.status(404).json({ error: 'Not found' });
                return;
            }
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.sendFile(path.join(uiDistPath, 'index.html'));
        });
    } else {
        app.get('/', (_req, res) => {
            res.json({
                status: 'ok',
                message:
                    'Manager running. UI not built — run: pnpm --filter @media-router/manager-ui build',
            });
        });
        log.info('manager-ui/dist not found — static asset serving disabled');
    }
}
