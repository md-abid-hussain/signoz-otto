import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Otto frontend. Proxies /api → the Otto backend (Fastify, port 8010) in dev.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: {
      '/api': { target: process.env.OTTO_API ?? 'http://localhost:8010', changeOrigin: true },
      // browser RUM export → SigNoz OTLP/HTTP (avoids CORS; keeps the endpoint same-origin)
      '/otlp': { target: process.env.OTTO_OTLP ?? 'http://localhost:4318', changeOrigin: true, rewrite: (p) => p.replace(/^\/otlp/, '') },
    },
  },
});
