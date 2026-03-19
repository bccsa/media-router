import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    plugins: [vue(), tailwindcss()],
    server: {
        port: 8082,
        host: true,
        proxy: {
            '/api': 'http://localhost:3001',
        },
    },
});
