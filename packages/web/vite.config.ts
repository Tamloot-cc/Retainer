import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip as gzipCallback } from 'node:zlib';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Keep the browser's Host header: the API's CSRF check compares Origin to the
// request origin, and Vite's string shorthand would rewrite Host to :8787.
const brotli = promisify(brotliCompress);
const gzip = promisify(gzipCallback);

const api = { target: 'http://127.0.0.1:8787', changeOrigin: false };

/**
 * Writes a Brotli and a gzip copy next to each script and stylesheet, which
 * the server sends to browsers that accept them (`precompressed` in
 * packages/server/src/api/app.ts). Compressing once here costs the server
 * nothing per request, and the hosted service's CDN does not compress.
 */
function precompress(): Plugin {
  return {
    name: 'retainer-precompress',
    apply: 'build',
    // After the files are written: earlier hooks see code that Vite still rewrites.
    async writeBundle({ dir }, bundle) {
      if (!dir) return;
      const files = Object.keys(bundle).filter((name) => /\.(js|css|svg|html)$/.test(name));
      await Promise.all(
        files.map(async (name) => {
          const path = join(dir, name);
          const bytes = await readFile(path);
          if (bytes.length < 1024) return;
          const [br, gz] = await Promise.all([
            brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
            gzip(bytes, { level: 9 }),
          ]);
          await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gz)]);
        }),
      );
    },
  };
}

export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss(), precompress()],
  server: {
    proxy: {
      '/v1': api,
      '/auth': api,
      '/account': api,
      '/health': api,
    },
  },
});
