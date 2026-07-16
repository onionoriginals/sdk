import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Resolve polyfill packages to absolute paths so the aliases also apply to
// imports coming from the SDK's own dist files (outside this app's root).
const require = createRequire(import.meta.url);

// The Originals SDK is a server-first package: two modules statically import
// Node built-ins (fs in WebVHManager for optional DID-log persistence, zlib in
// the status-list code) that the browser demo never executes. These aliases
// satisfy the imports without pulling real implementations into the bundle.
const shim = (name: string) =>
  fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  resolve: {
    // Force ONE instance of these so the SDK's raw-served dist and the app's
    // own imports share it — otherwise @noble/ed25519's `hashes` export reads
    // undefined when the SDK's noble-init runs, and it crashes trying to define
    // `hashes` on the frozen ESM namespace ("Cannot redefine property: hashes").
    dedupe: ['@noble/ed25519'],
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
    'process.env': '{}'
  },
  optimizeDeps: {
    // Serve @noble/ed25519 as raw ESM (not esbuild-prebundled) so its `hashes`
    // export is populated when the SDK's noble-init mutates it.
    exclude: ['@noble/ed25519'],
    esbuildOptions: {
      define: { global: 'globalThis' }
    }
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600
  }
});
