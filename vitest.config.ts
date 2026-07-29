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
        include: [
            'packages/*/src/**/*.test.ts',
            'plugins/*/engine/**/*.test.ts',
            'plugins/*/tests/**/*.test.ts',
        ],
        coverage: {
            include: ['packages/*/src/**/*.ts', 'plugins/*/engine/**/*.ts'],
            exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts', 'packages/manager-ui/**', 'packages/local-panel/**', 'packages/profile-manager/**', 'v1/**', '**/dist/**', '**/node_modules/**'],
            all: false,
            reporter: ['text'],
        },
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
