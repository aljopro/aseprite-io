// Benchmarks the built library (dist/). Run with `npm run bench` (builds first).
import { readFileSync } from 'node:fs';
import { Bench } from 'tinybench';
import { AsepriteFile, createPixels } from '../dist/index.js';

const fixture = new Uint8Array(readFileSync(new URL('../test/fixtures/file-tests-props.aseprite', import.meta.url)));

/** A large, realistic sprite: 128×128 RGBA, 6 layers, 120 frames, blocky pixel art with noise. */
function makeLarge() {
  const W = 128, H = 128;
  const file = new AsepriteFile(W, H, 'rgba');
  const layers = Array.from({ length: 6 }, (_, i) => file.addLayer(`Layer ${i}`));
  let seed = 1;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let f = 0; f < 120; f++) {
    file.addFrame(100);
    layers.forEach((layer, li) => {
      if (f > 0 && (f + li) % 4 === 3) return file.setLinkedCel(layer, f, f - 1);
      const data = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          const block = ((x >> 3) + (y >> 3) + f + li) % 7;
          if (block === 0) continue;
          data[o] = block * 36;
          data[o + 1] = (block * 53 + (rand() < 0.05 ? 40 : 0)) & 0xff;
          data[o + 2] = 255 - block * 30;
          data[o + 3] = 255;
        }
      }
      file.setCel(layer, f, createPixels(data, W, H, 'rgba'));
    });
  }
  file.addTag('all', 0, 119);
  return file;
}

/** Many tiny frames: stresses per-frame/per-chunk overhead rather than zlib. */
function makeManyFrames() {
  const file = new AsepriteFile(8, 8, 'rgba');
  const layers = Array.from({ length: 4 }, (_, i) => file.addLayer(`L${i}`));
  for (let f = 0; f < 2000; f++) {
    file.addFrame(16);
    for (const layer of layers) file.setCel(layer, f, createPixels(new Uint8Array(256).fill(f & 0xff), 8, 8, 'rgba'));
  }
  return file;
}

const large = makeLarge();
const largeBytes = large.write();
const largeRead = AsepriteFile.read(largeBytes);
const many = makeManyFrames();
const manyBytes = many.write();
const manyRead = AsepriteFile.read(manyBytes);
console.log(`large: ${(largeBytes.length / 1024).toFixed(0)} KiB / ${[...largeRead.cels()].length} cels; many-frames: ${(manyBytes.length / 1024).toFixed(0)} KiB / ${many.frames.length} frames`);

const bench = new Bench({ time: 1500, warmupTime: 300 });
bench
  .add('small: read', () => AsepriteFile.read(fixture))
  .add('small: read + write', () => AsepriteFile.read(fixture).write())
  .add('large: read', () => AsepriteFile.read(largeBytes))
  .add('large: write after read (reuse compressed)', () => largeRead.write())
  .add('large: write new (deflate every cel)', () => large.write())
  .add('large: write new, compressionLevel 1', () => large.write({ compressionLevel: 1 }))
  .add('many frames: read', () => AsepriteFile.read(manyBytes))
  .add('many frames: write after read', () => manyRead.write());

await bench.run();
console.table(
  bench.tasks.map((t) => ({
    task: t.name,
    'ops/s': Math.round(t.result.throughput?.mean ?? t.result.hz ?? 0).toLocaleString(),
    'mean (ms)': (t.result.latency?.mean ?? t.result.mean ?? 0).toFixed(3),
    '±%': (t.result.latency?.rme ?? t.result.rme ?? 0).toFixed(1),
  })),
);
