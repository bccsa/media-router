import { Server as HttpServer, createServer, type IncomingMessage, type ServerResponse } from 'http';
import { EventEmitter } from 'events';
import * as path from 'path';
import type { Dashboard } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import { StaticSite } from './staticSite.js';

const log = createLogger('LocalServer');

/** The router's own port: LCP, dashboards and router tree. The one place it is set. */
export const LOCAL_PORT = 8081;

/** Where a sibling package's build can sit relative to the engine (dev, dist, Yocto cwd). */
const candidates = (build: string) => [
    path.resolve(__dirname, '../../..', build),
    path.resolve(__dirname, '../../../..', build),
    path.resolve(process.cwd(), '..', build),
    path.resolve(process.cwd(), build),
    path.resolve(process.cwd(), 'packages', build),
];
/** The LCP build, served at `/` while it is kept (ADR-0026); the dashboard viewer at `/d/`. */
const LCP_CANDIDATES = candidates('local-panel/dist');
const VIEWER_CANDIDATES = candidates('manager-ui/dist-dashboard');

/**
 * The router's own server on :8081 (ADR-0026): the LCP at `/` (its Socket.IO
 * is LcpServer), dashboards at `/d/` (`/` → `/d/` without an LCP build), the
 * router tree the engine attaches to `http` (ADR-0024), and the change events
 * the tree and the LCP follow.
 *
 * Emits:
 *   - 'local:config' (ops, exceptSocketId?) — every config change the engine applies
 *   - 'local:running' (running) — every run-intent change
 */
export class LocalServer extends EventEmitter {
    private readonly httpServer: HttpServer;
    private readonly viewer: StaticSite | null;
    private readonly lcp: StaticSite | null;
    /** The running profile's dashboards, for `/d/dashboards.json`. Set by Engine. */
    _getDashboards: (() => Record<string, Dashboard>) | null = null;

    /** `sites`: where to look for the builds (tests); defaults to the install layout. */
    constructor(
        readonly port = LOCAL_PORT,
        sites: { viewer?: string[]; lcp?: string[] } = {},
    ) {
        super();
        this.viewer = StaticSite.find(sites.viewer ?? VIEWER_CANDIDATES);
        if (this.viewer) log.info({ path: this.viewer.dir }, 'Found the dashboard viewer');
        else log.warn('Dashboard viewer not found (manager-ui/dist-dashboard)');
        this.lcp = StaticSite.find(sites.lcp ?? LCP_CANDIDATES);
        if (this.lcp) log.info({ path: this.lcp.dir }, 'Found the LCP');
        this.httpServer = createServer((req, res) => this.handle(req, res));
    }

    /** The HTTP server, so the router tree can share port 8081. */
    get http(): HttpServer {
        return this.httpServer;
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve) => this.httpServer.listen(this.port, resolve));
        log.info({ port: this.port }, 'Listening');
    }

    async stop(): Promise<void> {
        this.removeAllListeners();
        await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    }

    /** Config ops the engine applied; `exceptSocketId` wrote them itself. */
    configChanged(ops: unknown[], exceptSocketId?: string): void {
        this.emit('local:config', ops, exceptSocketId);
    }

    runningChanged(running: boolean): void {
        this.emit('local:running', running);
    }

    /** Changes when the dashboard viewer is redeployed; open viewers reload on it. */
    dashboardBuild(): string {
        return this.viewer?.buildId() ?? 'none';
    }

    private handle(req: IncomingMessage, res: ServerResponse): void {
        const urlPath = (req.url ?? '/').split('?')[0];
        const dashboards = urlPath === '/d' || urlPath.startsWith('/d/');
        if (urlPath === '/d/dashboards.json') {
            this.sendDashboardNames(res);
        } else if (dashboards && this.viewer) {
            this.viewer.serve(urlPath.slice(2) || '/', res);
        } else if (!dashboards && this.lcp) {
            this.lcp.serve(urlPath, res);
        } else if (urlPath === '/') {
            res.writeHead(302, { Location: '/d/' });
            res.end();
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end(this.viewer ? 'Not found' : 'Dashboard viewer not built');
        }
    }

    /** Names for device-manager's display picker (another origin on this box). */
    private sendDashboardNames(res: ServerResponse): void {
        const list = Object.entries(this._getDashboards?.() ?? {})
            .map(([id, d]) => ({ id, name: d.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(list));
    }
}
