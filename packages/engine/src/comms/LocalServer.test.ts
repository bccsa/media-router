import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalServer } from './LocalServer.js';

let port = 18881 + Math.floor(Math.random() * 1000);
let viewerDir: string;
let lcpDir: string;

beforeAll(() => {
    viewerDir = mkdtempSync(join(tmpdir(), 'viewer-'));
    lcpDir = mkdtempSync(join(tmpdir(), 'lcp-'));
    writeFileSync(join(viewerDir, 'index.html'), '<html>viewer</html>');
    writeFileSync(join(lcpDir, 'index.html'), '<html>lcp</html>');
});
afterAll(() => {
    rmSync(viewerDir, { recursive: true, force: true });
    rmSync(lcpDir, { recursive: true, force: true });
});

describe('LocalServer (:8081, ADR-0026)', () => {
    let server: LocalServer;
    const url = (p: string) => `http://localhost:${port}${p}`;
    async function start(withLcp: boolean) {
        port += 1;
        server = new LocalServer(port, { viewer: [viewerDir], lcp: withLcp ? [lcpDir] : ['/nonexistent'] });
        await server.start();
    }
    afterEach(async () => {
        await server.stop();
    });

    it('serves the LCP at / while it is kept, dashboards under /d/', async () => {
        await start(true);
        expect(await (await fetch(url('/'))).text()).toBe('<html>lcp</html>');
        expect(await (await fetch(url('/d/Stage%20A'))).text()).toBe('<html>viewer</html>');
    });

    it('without an LCP build the front page is the dashboard list', async () => {
        await start(false);
        const res = await fetch(url('/'), { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/d/');
        expect((await fetch(url('/index.html'))).status).toBe(404);
    });

    it("lists the running profile's dashboards by name for device-manager (CORS open)", async () => {
        await start(true);
        server._getDashboards = () => ({ d2: { name: 'Stage' }, d1: { name: 'Foyer' } }) as any;
        const res = await fetch(url('/d/dashboards.json'));
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(await res.json()).toEqual([{ id: 'd1', name: 'Foyer' }, { id: 'd2', name: 'Stage' }]);
    });

    it('announces config and run-intent changes for the router tree and the LCP', async () => {
        await start(true);
        const config = vi.fn();
        const running = vi.fn();
        server.on('local:config', config);
        server.on('local:running', running);
        server.configChanged([{ op: 'replace', path: '/modules/m1/settings/volume', value: 1 }], 's1');
        server.runningChanged(true);
        expect(config).toHaveBeenCalledWith([{ op: 'replace', path: '/modules/m1/settings/volume', value: 1 }], 's1');
        expect(running).toHaveBeenCalledWith(true);
    });
});
