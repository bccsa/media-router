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
 * Register the HTTP surface. After the v2.0 API consolidation + the
 * all-socket move for plugin uploads (previews fetched via the
 * `plugin:upload-get` RPC and rendered as `data:` URLs), HTTP is now just:
 *
 *   - `GET /health` for external monitoring
 *   - Static asset serving for the built manager-ui SPA
 *   - SPA fallback for client-side router paths
 *
 * Every application + plugin API lives on Socket.IO.
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
        // Non-hashed root files (favicon.svg, logo_*.svg, index.html). We
        // tag *index.html* with `Cache-Control: no-store` so a redeploy
        // can't leave a stale index pointing at chunk hashes that have
        // since changed — that's what burned us when the new
        // `plugin:upload-get` watcher shipped but cached routing bundles
        // were still being loaded. Other root files revalidate each load
        // (their content can change but their URL doesn't, so we can't
        // use the immutable trick that the hashed assets get).
        app.use(
            express.static(uiDistPath, {
                etag: false,
                setHeaders: (res, filePath) => {
                    if (path.basename(filePath) === 'index.html') {
                        res.setHeader('Cache-Control', 'no-store');
                    } else {
                        res.setHeader('Cache-Control', 'no-cache');
                    }
                },
            }),
        );
        // SPA fallback for client-side routes (`/routing`, `/profiles/…`).
        app.get('/{*path}', (req, res) => {
            if (req.path.startsWith('/health') || req.path.startsWith('/socket.io')) {
                // /socket.io is served by the Socket.IO engine, not us — let
                // 404 surface there if anything else hits the prefix.
                res.status(404).json({ error: 'Not found' });
                return;
            }
            res.setHeader('Cache-Control', 'no-store');
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
