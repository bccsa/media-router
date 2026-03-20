import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../shared-vite.config.js';
import { resolve } from 'path';

export default mergeConfig(baseConfig, defineConfig({
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:8080',
            '/health': 'http://localhost:8080',
            '/socket.io': {
                target: 'http://localhost:8080',
                ws: true,
            },
        },
    },
}));
