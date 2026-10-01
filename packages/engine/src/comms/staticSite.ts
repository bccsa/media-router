import type { ServerResponse } from 'http';
import * as fs from 'fs';
import * as path from 'path';

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

// Built assets live in a folder (`/assets/…`); a top-level `/Stage.json` is a page route.
const ASSET = /^\/.+\/.*\.(js|css|png|svg|ico|json|woff2?)$/;

/** A built single-page app: its files, else `index.html` for any page route. */
export class StaticSite {
    private constructor(readonly dir: string) {}

    /** The first candidate directory holding an `index.html`, or null. */
    static find(candidates: string[]): StaticSite | null {
        const dir = candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
        return dir ? new StaticSite(dir) : null;
    }

    /** Serve `rel` (the URL path below the site's mount point, starting with '/'). */
    serve(rel: string, res: ServerResponse): void {
        const file = path.join(this.dir, rel === '/' ? '/index.html' : rel);
        if (!file.startsWith(this.dir + path.sep)) {
            res.writeHead(403);
            res.end();
            return;
        }
        fs.readFile(file, (err, data) => {
            if (!err) {
                res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] ?? 'application/octet-stream' });
                res.end(data);
            } else if (rel === '/' || ASSET.test(rel)) {
                res.writeHead(404);
                res.end('Not found');
            } else {
                this.serve('/', res);
            }
        });
    }

    /** Changes whenever the site is rebuilt. */
    buildId(): string {
        try {
            const st = fs.statSync(path.join(this.dir, 'index.html'));
            return `${Math.round(st.mtimeMs)}-${st.size}`;
        } catch {
            return 'none';
        }
    }
}
