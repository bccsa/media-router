// Test-only helper (not shipped: excluded from the plugin build).
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sink under test runs the ENGINE's compiled paced sink in a real thread or
 * process, outside vitest's source aliases. A missing build fails; an older one
 * only warns (an incremental tsc skips unchanged files, so mtime can lie).
 */
export function requireFreshEngineBuild(): void {
    const engine = join(__dirname, '../../../../packages/engine');
    const hint = 'run: pnpm --filter @media-router/engine build';
    for (const f of ['PacedUnixStreamTsSink', 'PacedTsSink']) {
        const built = join(engine, `dist/plugins/${f}.js`);
        if (!existsSync(built)) throw new Error(`${built} is missing; ${hint}`);
        if (statSync(built).mtimeMs < statSync(join(engine, `src/plugins/${f}.ts`)).mtimeMs) {
            console.warn(`${built} may be stale (older than its source); ${hint}`);
        }
    }
}
