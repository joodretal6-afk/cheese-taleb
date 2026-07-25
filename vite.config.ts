import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Electron/Tauri load from file:// — relative base keeps asset URLs valid.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    // The texture service runs separately (npm run texture-service). Proxying it
    // keeps the app on one origin, so VITE_TEXTURE_API can stay a relative path
    // and no CORS is involved in development.
    proxy: {
      '/api/texture': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/texture/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Vite 8 builds with rolldown, which only accepts the function form.
        manualChunks(id: string) {
          if (id.includes('@dimforge/rapier3d')) return 'rapier'
          if (id.includes('@babylonjs')) return 'babylon'
          if (id.includes('node_modules/react')) return 'react'
          return undefined
        },
      },
    },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
})
