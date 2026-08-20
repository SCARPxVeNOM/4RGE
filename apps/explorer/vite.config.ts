import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // The API is a separate service; proxying keeps the browser on one origin
    // during development without needing CORS to be permissive locally.
    proxy: { '/api': process.env.EXPLORER_API ?? 'http://127.0.0.1:8711' },
  },
  // preview needs the same proxy as dev, so the built bundle can be exercised
  // against a real API without deploying anything.
  preview: {
    proxy: { '/api': process.env.EXPLORER_API ?? 'http://127.0.0.1:8711' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
