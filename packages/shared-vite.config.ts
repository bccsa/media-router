import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

/** Shared Vite base config for all Vue UI packages. */
export default defineConfig({
    plugins: [vue(), tailwindcss()],
    server: {
        host: true,
    },
});
