import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into the API's public folder; the API serves it at /admin-panel (same origin as /admin-api).
export default defineConfig({
  plugins: [react()],
  base: '/admin-panel/',
  build: { outDir: '../public/admin-panel', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { port: 5174, proxy: { '/admin-api': 'http://localhost:5000' } },
});
