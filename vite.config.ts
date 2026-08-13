import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Tauri expects a fixed dev server port so the Rust side can point the
// webview at it. 1420 is the Tauri convention.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // prevent vite from obscuring rust errors
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // WebKitGTK 会磁盘缓存 dev 模块（实测 ~/.local/share/com.helix.desktop/
    // WebKitCache 攒到 253M，React.lazy 的 chunk 被缓存后窗口一直显示旧 UI，
    // 重启 dev 也无效）。dev 模式禁止缓存，让 webview 每次拿最新模块。
    headers: {
      'Cache-Control': 'no-store',
    },
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**', '**/hermes-agent/**'],
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2021',
    sourcemap: true,
  },
})
