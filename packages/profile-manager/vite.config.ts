import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../shared-vite.config.js';

export default mergeConfig(baseConfig, defineConfig({
    server: {
        port: 8082,
        proxy: {
            '/api': 'http://localhost:3001',
        },
    },
}));
