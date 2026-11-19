// Dependency-free smoke test of the built package (ESM and CommonJS) for old
// Node versions that the dev tooling no longer supports. Run after `npm run build`.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const esm = await import('../dist/index.js');
const cjs = createRequire(import.meta.url)('../dist/index.cjs');
const dir = new URL('../test/fixtures/', import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.aseprite'));

let failures = 0;
for (const [label, lib] of [['esm', esm], ['cjs', cjs]]) {
  for (const name of fixtures) {
    const input = new Uint8Array(readFileSync(new URL(name, dir)));
    const output = lib.AsepriteFile.read(input).write();
    const same = output.length === input.length && output.every((b, i) => b === input[i]);
    if (!same) {
      failures++;
      console.error(`✗ ${label} ${name}: round trip differs`);
    }
  }
  const file = new lib.AsepriteFile(2, 2, 'rgba');
  const layer = file.addLayer('L');
  file.addFrame(100);
  file.setCel(layer, 0, lib.createPixels(new Uint8Array(16).fill(9), 2, 2, 'rgba'));
  const back = lib.AsepriteFile.read(file.write());
  if (back.layers[0].name !== 'L') {
    failures++;
    console.error(`✗ ${label}: create/write/read failed`);
  }
}
if (failures) process.exit(1);
console.log(`smoke OK on Node ${process.version}: ${fixtures.length} fixtures × esm/cjs round-trip byte-identically`);
