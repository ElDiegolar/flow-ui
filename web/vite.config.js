import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Ports are env-driven so a second instance is a prefix, not a fork of this
// file. Defaults match start.sh and the README; run a beta alongside with:
//   WEB_PORT=5181 DAEMON_PORT=8766 npm run dev
const WEB_PORT = Number(process.env.WEB_PORT ?? 5180)
const DAEMON_PORT = Number(process.env.DAEMON_PORT ?? 8765)
const DAEMON = process.env.DAEMON_URL ?? `http://127.0.0.1:${DAEMON_PORT}`

export default defineConfig({
  plugins: [vue()],
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': { target: DAEMON, changeOrigin: true, ws: true },
    },
  },
  build: {
    // main.js uses top-level await (bootstrapToken); needs a modern target.
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
