import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
    server: {
        port: 5173,
        host: true,
        proxy: {
            '/api': 'http://localhost:8080',
            '/health': 'http://localhost:8080',
            '/socket.io': {
                target: 'http://localhost:8080',
                ws: true,
            },
        },
    },
});
