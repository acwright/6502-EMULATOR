#!/usr/bin/env node
/**
 * Generate all app-icon formats from build/6502.png.
 *
 * Outputs:
 *   build/icon.iconset/  — PNG sizes required by macOS iconutil
 *   build/icon.icns      — macOS app icon
 *   build/icon.ico       — Windows app icon (multi-resolution)
 *   build/icon.png       — Linux app icon (512×512)
 *
 * Requirements: magick (ImageMagick 7) and iconutil (macOS).
 * Run: node build/gen-icon.mjs
 *      or:  npm run icons
 */

import { execSync } from 'child_process'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = resolve(__dirname, '6502.png')
const iconset = resolve(__dirname, 'icon.iconset')

if (!existsSync(src)) {
  console.error(`Source PNG not found: ${src}`)
  process.exit(1)
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' })
}

// ── macOS iconset ─────────────────────────────────────────────────────────────

if (existsSync(iconset)) rmSync(iconset, { recursive: true })
mkdirSync(iconset)

const iconsetSizes = [
  { file: 'icon_16x16.png',      px: 16 },
  { file: 'icon_16x16@2x.png',   px: 32 },
  { file: 'icon_32x32.png',      px: 32 },
  { file: 'icon_32x32@2x.png',   px: 64 },
  { file: 'icon_128x128.png',    px: 128 },
  { file: 'icon_128x128@2x.png', px: 256 },
  { file: 'icon_256x256.png',    px: 256 },
  { file: 'icon_256x256@2x.png', px: 512 },
  { file: 'icon_512x512.png',    px: 512 },
  { file: 'icon_512x512@2x.png', px: 1024 },
]

console.log('Generating iconset PNGs…')
for (const { file, px } of iconsetSizes) {
  run(`magick "${src}" -background black -flatten -resize ${px}x${px} "${iconset}/${file}"`)
  console.log(`  ${file} (${px}×${px})`)
}

// ── macOS .icns ───────────────────────────────────────────────────────────────

console.log('\nGenerating icon.icns…')
run(`iconutil -c icns -o "${resolve(__dirname, 'icon.icns')}" "${iconset}"`)

// ── Linux .png (512×512) ──────────────────────────────────────────────────────

console.log('Generating icon.png (512×512)…')
run(`magick "${src}" -background black -flatten -resize 512x512 "${resolve(__dirname, 'icon.png')}"`)

// ── Windows .ico (multi-resolution) ──────────────────────────────────────────

console.log('Generating icon.ico…')
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const tmpFiles = icoSizes.map((px) => {
  const tmp = `/tmp/6502_ico_${px}.png`
  run(`magick "${src}" -background black -flatten -resize ${px}x${px} "${tmp}"`)
  return tmp
})
run(`magick ${tmpFiles.map((f) => `"${f}"`).join(' ')} "${resolve(__dirname, 'icon.ico')}"`)
tmpFiles.forEach((f) => execSync(`rm -f "${f}"`))

console.log('\nDone:')
console.log('  build/icon.iconset/')
console.log('  build/icon.icns')
console.log('  build/icon.png')
console.log('  build/icon.ico')
