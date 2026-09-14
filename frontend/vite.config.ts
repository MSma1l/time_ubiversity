import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    // Dev server only: temporary tunnel hosts change on every test session. Not used by the production build.
    allowedHosts: true,
    proxy: { '/api': 'http://127.0.0.1:3001', '/telegram': 'http://127.0.0.1:3001' },
  },
  build: {
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
  },
})
