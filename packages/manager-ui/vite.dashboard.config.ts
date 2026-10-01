import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'path';
import baseConfig from '../shared-vite.config.js';

// The router's dashboard viewer (ADR-0026), served by the engine at :8081/d/.
export default mergeConfig(
    baseConfig,
    defineConfig({
        root: resolve(__dirname, 'viewer'),
        base: '/d/',
        // The manager UI's icon and logos, so the router's page has its favicon.
        publicDir: resolve(__dirname, 'public'),
        resolve: {
            alias: {
                '@': resolve(__dirname, 'src'),
            },
        },
        build: {
            outDir: resolve(__dirname, 'dist-dashboard'),
            emptyOutDir: true,
        },
    }),
);
