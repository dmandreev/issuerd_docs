#!/usr/bin/env node
/**
 * Generates public/favicon.png (192×192) and public/apple-touch-icon.png
 * (180×180) — the white "d" keyhole mark centered on the brand-dark
 * rounded square, so the icon stays visible on dark surfaces (browser
 * dark themes, Telegram's link-preview badge).
 *
 * The mark is inlined as vector paths extracted from
 * src/assets/logo-small-white.svg, so no font is needed.
 *
 * Usage:
 *   node scripts/generate-favicon.mjs
 *
 * Re-run when the logo or brand color changes, and commit the PNGs.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#0b0e14';

const logo = readFileSync(join(root, 'src', 'assets', 'logo-small-white.svg'), 'utf8');
const paths = logo.match(/<path[\s\S]*?\/>/g);
if (!paths?.length) throw new Error('no <path> elements found in logo-small-white.svg');
// logo-small-white.svg viewBox is 65×65 (the "d" keyhole mark).
const MARK_BOX = 65;

async function render(size, out) {
  const pad = Math.round(size * 0.14);
  const mark = size - pad * 2;
  const scale = mark / MARK_BOX;
  const rx = Math.round(size * 0.21);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="${BG}"/>
  <g transform="translate(${pad}, ${pad}) scale(${scale})">
    ${paths.join('\n    ')}
  </g>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(`generated: ${out} (${size}x${size})`);
}

await render(192, join(root, 'public', 'favicon.png'));
await render(180, join(root, 'public', 'apple-touch-icon.png'));
