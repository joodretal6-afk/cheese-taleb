#!/usr/bin/env node
/**
 * Folds the built editor into one self-contained HTML file.
 *
 * The multi-file build needs a web server, because a browser refuses to fetch
 * sibling modules over file://. Inlining the stylesheet and the bundle removes
 * every external request, so the result opens by double-clicking it — no
 * Node, no Python, no terminal. That matters: the person authoring textures is
 * not necessarily the person who can run a dev server.
 *
 * Run after `vite build --config vite.editor.config.ts`.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist-editor')
const outPath = join(root, 'dist-editor', 'admin-panel-standalone.html')

/**
 * A literal `</script>` anywhere in the bundle would close the tag early and
 * dump the rest of the program into the page as text.
 */
const escapeForInlineScript = (code) => code.replaceAll('</script', '<\\/script')

async function main() {
  let html = await readFile(join(distDir, 'editor.html'), 'utf8')
  const assets = await readdir(join(distDir, 'assets'))

  // --- Stylesheets --------------------------------------------------------
  const linkPattern = /<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g
  for (const [tag, href] of [...html.matchAll(linkPattern)]) {
    const name = href.split('/').pop()
    if (!assets.includes(name)) continue
    const css = await readFile(join(distDir, 'assets', name), 'utf8')
    html = html.replace(tag, `<style>\n${css}\n</style>`)
  }

  // --- Scripts ------------------------------------------------------------
  const scriptPattern = /<script[^>]*src="([^"]+)"[^>]*><\/script>/g
  for (const [tag, src] of [...html.matchAll(scriptPattern)]) {
    const name = src.split('/').pop()
    if (!assets.includes(name)) continue
    const js = await readFile(join(distDir, 'assets', name), 'utf8')
    // Kept as a module: an inline module has no external imports to resolve,
    // so it runs happily from file:// where a src= module would not.
    html = html.replace(tag, `<script type="module">\n${escapeForInlineScript(js)}\n</script>`)
  }

  const remaining = [...html.matchAll(/(?:src|href)="\.?\/?assets\//g)]
  if (remaining.length > 0) {
    throw new Error(`${remaining.length} asset reference(s) left un-inlined; the file would not open offline`)
  }

  await writeFile(outPath, html)
  const kb = Math.round(Buffer.byteLength(html) / 1024)
  process.stderr.write(`✅ ${outPath} (${kb} KB, opens with no server)\n`)
}

main().catch((error) => {
  process.stderr.write(`❌ ${error.message}\n`)
  process.exit(1)
})
