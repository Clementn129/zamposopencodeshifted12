// Bundles the harness (rewriting the `react` import to the local shim) then
// runs it. Usage: node scripts/barcode-sim/build.mjs
import esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..', '..');
const shim = path.join(dir, 'react-shim.mjs');
const outfile = path.join(os.tmpdir(), 'opencode-barcode-sim.mjs');

await esbuild.build({
  entryPoints: [path.join(dir, 'entry.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile,
  absWorkingDir: root,
  logLevel: 'warning',
  plugins: [
    {
      name: 'react-shim',
      setup(build) {
        build.onResolve({ filter: /^react$/ }, () => ({ path: shim }));
      },
    },
  ],
});

await import(pathToFileURL(outfile).href);
