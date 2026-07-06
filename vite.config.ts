import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend lives in app/. It proxies /api and /assets to the Node server so the
// asset iframe stays same-origin with the editor (same-origin architecture).
export default defineConfig({
  root: 'app',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5174',
      '/assets': 'http://localhost:5174',
      '/brands': 'http://localhost:5174',
      '/exports': 'http://localhost:5174',
      '/export': 'http://localhost:5174',
      '/fonts': 'http://localhost:5174',
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Frontend chunks go to /app-assets/, NOT /assets/ — the CLI server serves the
    // USER's folder at /assets/, so the two must not collide.
    assetsDir: 'app-assets',
  },
});
