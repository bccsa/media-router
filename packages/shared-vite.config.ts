import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

/** Shared Vite base config for all Vue UI packages. */
export default defineConfig({
    plugins: [vue(), tailwindcss()],
    server: {
        host: true,
        // Plugin UI components live in `<repo>/plugins/*/ui/*.vue` — outside each
        // package's root. Allow fs access up to the workspace root so
        // `import.meta.glob('../../plugins/*/ui/*.vue')` works in dev mode.
        fs: {
            allow: ['../..'],
        },
    },
    // Vite skips pre-bundling for pnpm-symlinked workspace packages by default,
    // so the CJS dist of `@media-router/shared-types` reaches the browser raw
    // → "ReferenceError: exports is not defined" at runtime. Force esbuild to
    // pre-bundle it (and convert CJS → ESM) in dev mode. The `build` block
    // below handles the same problem at production build time via Rollup.
    optimizeDeps: {
        include: ['@media-router/shared-types'],
    },
    build: {
        commonjsOptions: {
            // Workspace packages are pnpm-symlinked from `<repo>/packages/*`,
            // which sits outside `node_modules`. Rollup's commonjs plugin
            // defaults to `[/node_modules/]` and skips workspace symlinks, so
            // CJS-built packages (e.g. `@media-router/shared-types`, which is
            // shared with the CJS Node engine/manager runtimes) ended up in
            // the browser bundle as raw CJS — `exports` is undefined in the
            // browser → "ReferenceError: exports is not defined" at runtime.
            // Including the workspace path makes the plugin transform them.
            include: [/node_modules/, /[\\/]packages[\\/]/],
        },
    },
});
