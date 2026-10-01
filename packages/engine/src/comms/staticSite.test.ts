import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ServerResponse } from 'http';
import { StaticSite } from './staticSite.js';

function fakeRes(): Promise<{ status: number; type?: string; body: string }> & { res: ServerResponse } {
    let resolve!: (v: { status: number; type?: string; body: string }) => void;
    const done = new Promise<{ status: number; type?: string; body: string }>((r) => (resolve = r));
    let status = 0;
    let type: string | undefined;
    const res = {
        writeHead: (s: number, h?: Record<string, string>) => {
            status = s;
            type = h?.['Content-Type'];
        },
        end: (body?: Buffer | string) => resolve({ status, type, body: String(body ?? '') }),
    } as unknown as ServerResponse;
    return Object.assign(done, { res });
}

describe('StaticSite', () => {
    let dir: string;
    let site: StaticSite;
    const get = (rel: string) => {
        const r = fakeRes();
        site.serve(rel, r.res);
        return r;
    };

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'site-'));
        mkdirSync(join(dir, 'assets'));
        writeFileSync(join(dir, 'index.html'), '<html>app</html>');
        writeFileSync(join(dir, 'assets', 'app.js'), 'js');
        site = StaticSite.find(['/nonexistent-site', dir])!;
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('is found in the first candidate holding an index.html', () => {
        expect(site.dir).toBe(dir);
        expect(StaticSite.find(['/nonexistent-site'])).toBeNull();
        expect(site.buildId()).toMatch(/^\d+-\d+$/);
    });

    it('serves files with their type, page routes as index.html, missing assets as 404', async () => {
        expect(await get('/assets/app.js')).toEqual({ status: 200, type: 'application/javascript', body: 'js' });
        expect(await get('/')).toMatchObject({ status: 200, body: '<html>app</html>' });
        expect(await get('/Stage%20A')).toMatchObject({ status: 200, type: 'text/html', body: '<html>app</html>' });
        expect(await get('/assets/gone.js')).toMatchObject({ status: 404 });
        // A dashboard may be called anything, "Stage.json" included.
        expect(await get('/Stage.json')).toMatchObject({ status: 200, type: 'text/html', body: '<html>app</html>' });
    });

    it('refuses paths that climb out of the site', async () => {
        expect(await get('/../../etc/passwd')).toMatchObject({ status: 403 });
    });

    it('a site whose index.html vanished answers 404, not a loop', async () => {
        const gone = mkdtempSync(join(tmpdir(), 'site-'));
        writeFileSync(join(gone, 'index.html'), 'x');
        const s = StaticSite.find([gone])!;
        rmSync(gone, { recursive: true, force: true });
        const r = fakeRes();
        s.serve('/any/page', r.res);
        expect(await r).toMatchObject({ status: 404 });
    });
});
