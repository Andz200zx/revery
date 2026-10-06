import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1',
    port: 4310,
    strictPort: true,
    watch: { usePolling: true },
    proxy: { '/api': 'http://127.0.0.1:4311' },
  },
  build: { target: 'es2022' },
});
