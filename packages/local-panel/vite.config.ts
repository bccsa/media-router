import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        port: 5174, // Dev server on 5174, proxies to engine's LcpServer on 8081
        host: true,
        // Plugin UI components live in `<repo>/plugins/*/ui/*.vue`. Allow fs
        // access up to the workspace root so `import.meta.glob` can find them.
        fs: {
            allow: ['../..'],
        },
        proxy: {
            '/socket.io': {
                target: 'http://localhost:8081',
                ws: true,
            },
        },
    },
});
