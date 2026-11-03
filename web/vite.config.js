import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Versions of the libraries this build was made with, shown in Settings > System.
const version = (pkg) => { try { return JSON.parse(readFileSync(new URL(`./node_modules/${pkg}/package.json`, import.meta.url), 'utf8')).version; } catch { return null; } };
const WEB_LIBS = ['react', 'react-router-dom', '@xyflow/react', 'jssip', 'lucide-react', 'vite'];

// `npm run dev` proxies the API to a running AsterFi server. Put its address in web/.env.local (not committed):
//   ASTERFI_DEV_SERVER=https://<your-asterfi-server>
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { __WEB_VERSIONS__: JSON.stringify(Object.fromEntries(WEB_LIBS.map((p) => [p, version(p)]))) },
  server: { proxy: { '/api': { target: loadEnv(mode, process.cwd(), '').ASTERFI_DEV_SERVER || 'https://localhost', secure: false, changeOrigin: true } } },
  build: { chunkSizeWarningLimit: 1200 },
}));
