import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Standalone build of the authoring panel.
 *
 * The main build emits the game and the editor together, which makes Rollup
 * hoist their shared modules into a separate chunk — fine over HTTP, fatal for
 * a file that has to run from file:// with no server. Building the editor as
 * the sole entry leaves nothing to share, so it collapses to one chunk that
 * tools/pack-editor.mjs can inline whole.
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist-editor',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { editor: resolve(__dirname, 'editor.html') },
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
