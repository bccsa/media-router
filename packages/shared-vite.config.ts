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
});
