import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locate a native helper binary (mr-tssplit, mr-bus-fanout — built from the
 * repo's `native/` tree). `MR_NATIVE_BIN_DIR`, when set, is AUTHORITATIVE
 * (a dev override that silently fell back would defeat its purpose).
 * Otherwise: `/usr/bin` (packaged `make install`), then the repo's
 * `native/<name>/<name>` build output (dev checkouts where `make -C native`
 * or build-dev.sh ran in place). Returns null when nothing is found —
 * callers surface a health error pointing at native/README.md.
 */
export function resolveNativeBinary(name: string): string | null {
    if (process.env.MR_NATIVE_BIN_DIR) {
        const p = join(process.env.MR_NATIVE_BIN_DIR, name);
        return existsSync(p) ? p : null;
    }
    const candidates: string[] = [join('/usr/bin', name)];
    try {
        // dist/index.js -> packages/engine/dist -> repo root native/
        const engineMain = require.resolve('@media-router/engine');
        candidates.push(join(engineMain, '..', '..', '..', '..', 'native', name, name));
    } catch {
        /* engine not resolvable (isolated unit tests) — skip repo fallback */
    }
    return candidates.find((p) => existsSync(p)) ?? null;
}
