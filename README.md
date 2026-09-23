# issuerd_docs

Source of **https://issuerd.org** — the Issuerd documentation site, built with [Astro Starlight](https://starlight.astro.build/) and deployed to Cloudflare Pages.

## Content model

The reference documentation lives in the main repository at [`issuerd/docs/`](https://github.com/issuerd/issuerd/tree/main/docs). Those files are the baseline — do not edit them from here. Pages on this site are synced copies that may over time grow more detailed than the reference versions.

To (re)import pages from the reference docs:

```sh
npm run sync-docs                 # sync every *.md from ../issuerd/docs
npm run sync-docs -- security.md  # sync a single file
```

The script converts each document for Starlight (frontmatter title/description, route-style links, lowercased slugs, `README.md` → documentation overview page) and **overwrites** the destination file — if a page was expanded on the site, re-apply the expansion after syncing. The site landing page (`index.mdx`) is hand-maintained and never synced. Both repositories are expected as siblings (`issuerd/` and `issuerd_docs/` under one parent).

## Develop

```sh
npm install
npm run dev        # local dev server
npm run build      # static build to dist/
npm run preview    # serve the production build
```

## Deploy (Cloudflare Pages)

- Build command: `npm run build`
- Build output directory: `dist`
- Custom domain: `issuerd.org`
