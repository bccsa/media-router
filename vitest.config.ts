import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import path from 'path';

/**
 * Our own packages resolve to their SOURCE in tests, never to a build that may
 * be stale (a test would otherwise pass against old compiled code). Exact
 * matches only, so deep imports keep resolving normally.
 */
const workspaceSources: Record<string, string> = {
    '@media-router/shared-types': 'packages/shared-types/src/index.ts',
    '@media-router/engine': 'packages/engine/src/index.ts',
    '@media-router/topic-tree': 'packages/topic-tree/src/index.ts',
    '@media-router/topic-tree/testing': 'packages/topic-tree/src/testing.ts',
    '@media-router/dgram-comms': 'packages/dgram-comms/src/index.ts',
    '@media-router/plugin-audio-302m-core': 'plugins/audio-302m-core/engine/index.ts',
    '@media-router/plugin-subtitle-core': 'plugins/subtitle-core/engine/index.ts',
    '@media-router/plugin-mpegts-core': 'plugins/mpegts-core/engine/index.ts',
};
const exact = (id: string) => new RegExp(`^${id.replace(/[/.-]/g, (c) => `\\${c}`)}$`);

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: [
            { find: '@', replacement: path.resolve(__dirname, 'packages/manager-ui/src') },
            ...Object.entries(workspaceSources).map(([id, file]) => ({
                find: exact(id),
                replacement: path.resolve(__dirname, file),
            })),
        ],
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
