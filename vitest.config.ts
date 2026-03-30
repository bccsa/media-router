import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'packages/manager-ui/src'),
        },
    },
    test: {
        globals: true,
        include: ['packages/*/src/**/*.test.ts', 'plugins/*/engine/**/*.test.ts'],
        // Ensure Vue/Pinia resolve from manager-ui's node_modules
        deps: {
            optimizer: {
                web: {
                    include: ['vue', 'pinia', '@vue/test-utils'],
                },
            },
        },
    },
});
