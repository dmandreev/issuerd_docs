#!/usr/bin/env node
/**
 * Generates public/og-image.png (1200×630) — the social preview card
 * referenced by the og:image / twitter:image meta tags in astro.config.mjs.
 *
 * The issuerd wordmark is inlined as vector paths extracted from
 * src/assets/white-logo.svg, so the logo needs no font; the tagline uses a
 * system sans font rasterized by sharp.
 *
 * Usage:
 *   node scripts/generate-social-card.mjs
 *
 * Re-run when the logo or tagline changes, and commit public/og-image.png.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public', 'og-image.png');

const W = 1200;
const H = 630;
const BG = '#0b0e14';
const TEXT = '#e8ecf1';
const MUTED = '#9aa4b2';
const DIM = '#7d8590';

// All artwork paths in white-logo.svg are plain white fills; reuse them
// verbatim inside the card so the wordmark renders without any font.
const logo = readFileSync(join(root, 'src', 'assets', 'white-logo.svg'), 'utf8');
const paths = logo.match(/<path[\s\S]*?\/>/g);
if (!paths?.length) throw new Error('no <path> elements found in white-logo.svg');
// white-logo.svg viewBox is 1037×253 (mark + "issuerd" wordmark).
const LOGO_BOX_W = 1037;
const LOGO_BOX_H = 253;

const logoW = 640;
const logoH = (LOGO_BOX_H / LOGO_BOX_W) * logoW;
const logoX = (W - logoW) / 2;
const logoY = 168;
const scale = logoW / LOGO_BOX_W;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <g transform="translate(${logoX}, ${logoY}) scale(${scale})">
    ${paths.join('\n    ')}
  </g>
  <text x="${W / 2}" y="430" font-family="Arial, sans-serif" font-size="42"
        fill="${TEXT}" text-anchor="middle">Identity &amp; Access Management in Rust</text>
  <text x="${W / 2}" y="492" font-family="Arial, sans-serif" font-size="28"
        fill="${MUTED}" text-anchor="middle">Conformance-tested OIDC/OAuth2 — Keycloak-compatible — horizontally scalable</text>
  <text x="${W / 2}" y="576" font-family="Arial, sans-serif" font-size="26"
        fill="${DIM}" text-anchor="middle">issuerd.org</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`generated: public/og-image.png (${W}x${H})`);
