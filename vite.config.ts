import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Electron/Tauri load from file:// — relative base keeps asset URLs valid.
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
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
