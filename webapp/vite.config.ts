import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 生产：vite build 产物由 agent-shell 的 webshell 静态托管（同端口，API 天然同源）。
// 开发：vite dev server 起在 5173，/api 代理到后端 web-host（ws:true 让 WS 也走代理）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.WEB_HOST_ORIGIN ?? 'http://127.0.0.1:8787',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
