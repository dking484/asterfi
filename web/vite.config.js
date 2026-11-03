import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies the API to a running AsterFi server. Put its address in web/.env.local (not committed):
//   ASTERFI_DEV_SERVER=https://<your-asterfi-server>
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { proxy: { '/api': { target: loadEnv(mode, process.cwd(), '').ASTERFI_DEV_SERVER || 'https://localhost', secure: false, changeOrigin: true } } },
  build: { chunkSizeWarningLimit: 1200 },
}));
