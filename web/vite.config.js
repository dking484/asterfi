import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'https://192.0.2.10', secure: false, changeOrigin: true } } },
  build: { chunkSizeWarningLimit: 1200 },
});
