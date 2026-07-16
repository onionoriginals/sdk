import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { site } from './src/content';

// Resolve polyfill packages to absolute paths so the aliases also apply to
// imports coming from the SDK's own dist files (outside this app's root).
const require = createRequire(import.meta.url);

// The Originals SDK is a server-first package: two modules statically import
// Node built-ins (fs in WebVHManager for optional DID-log persistence, zlib in
// the status-list code) that the browser demo never executes. These aliases
// satisfy the imports without pulling real implementations into the bundle.
const shim = (name: string) =>
  fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url));

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Injects title/description/URL from src/content.ts into index.html so page
// copy stays in the single content file, and guards the one production-URL
// constant (site.url): robots.txt and sitemap.xml are static files in
// public/ that must reference the same origin, so a mismatch fails the build
// instead of shipping a half-swapped domain (see issue #330).
function injectSiteMeta(): Plugin {
  const tokens: Record<string, string> = {
    '%SITE_TITLE%': site.title,
    '%SITE_DESCRIPTION%': site.description,
    '%SITE_URL%': site.url.replace(/\/$/, ''),
    '%SITE_WORDMARK%': site.wordmark,
    '%SITE_OG_IMAGE_ALT%': site.ogImageAlt
  };
  return {
    name: 'originals:inject-site-meta',
    buildStart() {
      // Match the actual directives, not just any occurrence of the URL —
      // both files also mention the domain in comments.
      const url = site.url.replace(/\/$/, '');
      const checks = [
        { file: 'robots.txt', needle: `Sitemap: ${url}/sitemap.xml` },
        { file: 'sitemap.xml', needle: `<loc>${url}/</loc>` }
      ];
      for (const { file, needle } of checks) {
        const path = fileURLToPath(new URL(`./public/${file}`, import.meta.url));
        if (!readFileSync(path, 'utf8').includes(needle)) {
          throw new Error(
            `public/${file} does not contain "${needle}" — when swapping the ` +
              `production domain, update site.url in src/content.ts AND the ` +
              `absolute URLs in public/robots.txt and public/sitemap.xml.`
          );
        }
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replace(/%SITE_[A-Z_]+%/g, (token) => {
          const value = tokens[token];
          if (value === undefined) {
            throw new Error(`index.html uses unknown token ${token}`);
          }
          return escapeAttr(value);
        })
    }
  };
}

export default defineConfig({
  plugins: [react(), injectSiteMeta()],
  // Same-origin proxy so the browser reaches the unified Bun server
  // (serve.ts on :8787: auth + PUT /api/host/*) without CORS and cookies work.
  server: {
    proxy: {
      '/api': 'http://localhost:8787'
    }
  },
  resolve: {
    alias: [
      { find: /^(node:)?fs\/promises$/, replacement: shim('fs-promises') },
      { find: /^(node:)?fs$/, replacement: shim('fs') },
      { find: /^(node:)?crypto$/, replacement: shim('crypto') },
      { find: /^(node:)?zlib$/, replacement: shim('zlib') },
      { find: /^(node:)?path$/, replacement: require.resolve('path-browserify') },
      { find: /^buffer$/, replacement: require.resolve('buffer/') }
    ]
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'process.env': '{}',
    // Some deps (buffer polyfill) reference bare `global`. In Vite 8 the
    // Rolldown dep optimizer inherits top-level `define`, so this replaces the
    // now-deprecated optimizeDeps.esbuildOptions.define.
    global: 'globalThis'
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600
  }
});
