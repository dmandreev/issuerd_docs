#!/usr/bin/env node
/**
 * Syncs the reference documentation from ../issuerd/docs into
 * src/content/docs, adapting it for Starlight:
 *
 *   - the first `# Heading` becomes frontmatter `title` (and is removed
 *     from the body, Starlight renders its own heading);
 *   - the first intro paragraph becomes frontmatter `description` (SEO);
 *   - sibling links `(page.md)` / `(page.md#anchor)` become routes
 *     `(/page/)` / `(/page/#anchor)`;
 *   - links outside docs/ (`../tests/…`, `../README.md`) become absolute
 *     GitHub URLs;
 *   - images under docs/images/ are mirrored into public/images/ and their
 *     links rewritten to root-absolute paths;
 *   - <img> tags pointing outside docs/ (e.g. ../.github/assets/demo.gif)
 *     are copied into public/images/ as well and rewritten likewise;
 *   - file names are lowercased; README.md becomes docs-overview.md (the site
 *     landing page index.mdx is hand-maintained and never synced).
 *   - ROOT_FILES (e.g. TRADEMARK.md) live in the repository root rather than
 *     docs/; they are synced the same way, except that their root-relative
 *     links (webclientsrc/…, docs/…) become absolute GitHub URLs.
 *
 * Usage:
 *   node scripts/sync-docs.mjs              # sync all *.md from ../issuerd/docs + ROOT_FILES
 *   node scripts/sync-docs.mjs security.md  # sync one file
 *
 * WARNING: this overwrites the destination file wholesale. If the site copy
 * has been expanded beyond the reference document, re-apply those changes
 * after syncing (or sync selectively).
 */
import { cpSync, copyFileSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(root, '..', 'issuerd');
const SRC = join(REPO, 'docs');
const DEST = join(root, 'src', 'content', 'docs');
const IMG_DEST = join(root, 'public', 'images');
const GITHUB_BLOB = 'https://github.com/issuerd/issuerd/blob/main/';

// Files synced from the repository root (not docs/). Their relative links
// are root-relative, so every relative link becomes an absolute GitHub URL.
const ROOT_FILES = ['TRADEMARK.md'];

const args = process.argv.slice(2);
const available = readdirSync(SRC).filter((f) => f.endsWith('.md'));
const wanted = args.length ? args : [...available, ...ROOT_FILES];

mkdirSync(DEST, { recursive: true });
mkdirSync(IMG_DEST, { recursive: true });

// Mirror docs/images/ into public/images/ so root-absolute links resolve.
cpSync(join(SRC, 'images'), IMG_DEST, { recursive: true });

for (const file of wanted) {
  const isRootFile = ROOT_FILES.includes(file);
  if (!isRootFile && !available.includes(file)) {
    console.error(`skip: ${file} not found in ${SRC} (have: ${available.join(', ')})`);
    continue;
  }
  const text = readFileSync(join(isRootFile ? REPO : SRC, file), 'utf8');
  const isIndex = file.toLowerCase() === 'readme.md';
  const slug = isIndex ? 'docs-overview' : file.replace(/\.md$/i, '').toLowerCase();
  const { title, description, body } = transform(text, { rootRelative: isRootFile });
  const fm = ['---', `title: ${yamlString(title)}`];
  if (description) fm.push(`description: ${yamlString(description)}`);
  fm.push('---');
  writeFileSync(join(DEST, `${slug}.md`), `${fm.join('\n')}\n\n${body}`);
  console.log(`synced: ${isRootFile ? '' : 'docs/'}${file} -> src/content/docs/${slug}.md`);
}

function transform(text, { rootRelative = false } = {}) {
  const lines = text.split('\n');
  let title = 'Untitled';
  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 !== -1) {
    title = stripMd(lines[h1].replace(/^#\s+/, '').trim());
    lines.splice(h1, 1);
  }
  const description = firstParagraph(lines);
  let body = lines.join('\n').replace(/^\s*\n/, '');
  body = body
    // <img> pointing outside docs/ -> copy the asset into public/images/
    .replace(/(<img[^>]+src=")(?:\.\.\/)+([^"]+)(")/g, (m, pre, rel, post) => {
      const name = basename(rel);
      copyFileSync(join(SRC, '..', rel), join(IMG_DEST, name));
      console.log(`asset:  ${rel} -> public/images/${name}`);
      return `${pre}/images/${name}${post}`;
    })
    // ../path links leave the docs set -> point at the GitHub repo
    .replace(/\]\((?:\.\.\/)+([^)#]+?)(#[^)]*)?\)/g, `](${GITHUB_BLOB}$1$2)`)
    // images shipped in docs/images/ -> root-absolute public/ paths
    .replace(/(!\[[^\]]*\]\()images\//g, '$1/images/')
    .replace(/(<img[^>]+src=")images\//g, '$1/images/')
    // README.md sibling links -> the documentation overview route
    .replace(/\]\(README\.md(#[^)]*)?\)/gi, '](/docs-overview/$1)')
    // sibling page.md links -> site routes
    .replace(/\]\(([A-Za-z0-9_-]+)\.md(#[^)]*)?\)/g, (_, p, a) => `](/${p.toLowerCase()}/${a ?? ''})`)
    // fence languages unknown to Expressive Code
    .replace(/```cron\b/g, '```txt');
  if (rootRelative) {
    // Repo-root files: every remaining relative link leaves the docs set.
    body = body.replace(/\]\((?!https?:|\/|#|mailto:)([^)]+)\)/g, `](${GITHUB_BLOB}$1)`);
  }
  return { title, description, body };
}

function firstParagraph(lines) {
  const collected = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (!line.trim()) {
      if (collected.length) break;
      continue;
    }
    if (/^(#|>|-|\||:)/.test(line.trim())) {
      if (collected.length) break;
      continue;
    }
    collected.push(line.trim());
  }
  let text = stripMd(collected.join(' ')).replace(/\s+/g, ' ').trim();
  if (text.length < 20) return '';
  if (text.length > 200) text = text.slice(0, 197).replace(/\s+\S*$/, '') + '…';
  return text;
}

function stripMd(s) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '');
}

/** A JSON string is a valid YAML double-quoted scalar. */
function yamlString(s) {
  return JSON.stringify(s);
}
