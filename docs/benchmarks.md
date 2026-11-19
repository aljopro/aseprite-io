# Benchmarks

Run them with:

```sh
npm run bench   # builds dist/, then runs bench/run.mjs with tinybench
```

The suite measures the built package (`dist/`) on four workloads:

- **small**: `file-tests-props.aseprite` from Aseprite's test suite (64×64, 4 layers, 6 frames).
- **medium**: a generated 64×64 RGBA sprite with 4 layers and 100 frames (400 compressed cels), the workload from [issue #15](https://github.com/aljopro/aseprite-io/issues/15).
- **large**: a generated 128×128 RGBA sprite with 6 layers and 120 frames (720 cels, about 1.2 MiB), with blocky pixel art plus noise so it compresses like real art.
- **many frames**: 8×8 pixels, 4 layers, 2,000 frames. This stresses per-frame and per-chunk overhead rather than zlib.

## Results

These were measured on Node 26 on Apple Silicon. Numbers are the mean in ms per operation; lower is better.

| Benchmark | Initial port | Optimized | Speedup |
|---|---:|---:|---:|
| small: read | 0.366 | 0.092 | 4.0× |
| small: read + write | 0.888 | 0.184 | 4.8× |
| large: read | 110.6 | 89.4 | 1.2× |
| large: write after read (reuses compressed data) | 154.1 | 59.6 | 2.6× |
| large: write new (deflate every cel, level 6) | 482.7 | 477.4 | — |
| large: write new, `compressionLevel: 1` | — | 287.7 | 1.7× vs level 6 |
| many frames: read | 145.6 | 9.7 | 15× |
| many frames: write after read | 2,098.8 | 9.2 | 229× |

## What changed

1. **Writing is linear in file size.** The initial writer re-scanned every cel, recorded chunk and unknown chunk once per frame, so cost grew quadratically with frame count. It now groups them by frame once per write.
2. **Untouched data is reused without decompressing it.** See [Reusing compressed data](#reusing-compressed-data).
3. **Sized inflate.** Cels, tilemaps and tilesets are decompressed straight into a buffer of the known size (`w × h × bytes per pixel`), as Aseprite does, instead of a buffer that grows as it goes.
4. **Single output buffer.** Frames and chunks are written into one growing buffer, and size fields are patched afterwards. Previously each frame was assembled separately and then copied again.
5. **Faster Adler-32.** The checksum loop is unrolled 8×, which roughly doubles its throughput in V8.

Writing brand-new pixel data is dominated by deflate (fflate, pure JS). If speed matters more than size, `file.write({ compressionLevel: 1 })` is about 1.7× faster and produces files about 2.5× larger. Level 6, the default, matches Aseprite.

## Reusing compressed data

To write an unmodified file back byte for byte, the writer reuses each cel's, tilemap's and tileset's original zlib stream when the decoded data still matches it. Deciding that must be exact: 0.1.0 compared only Adler-32 checksums, and a colliding edit was silently discarded ([#11](https://github.com/aljopro/aseprite-io/issues/11)).

The reader stores each decoded buffer behind an accessor property (`pixels.data`, `tiles`, a tileset's `pixels`) that records when it is first read or assigned. Until then, no code outside the library has a reference to the buffer, so it cannot have changed, and the writer reuses the original stream with no work at all. Once the buffer has been handed out, the writer checks it exactly: an Adler-32 comparison rejects most edits cheaply, and when the checksums agree, the original stream is decompressed and compared byte for byte. Copying the object (for example `{ ...pixels }` or `structuredClone`) counts as reading it.

This adds no memory: nothing is copied or cached. The cost is a small, fixed setup per cel when reading, about 0.6 µs, which shows up only on files with thousands of tiny cels.

Measured on Node 26 (Apple Silicon), mean ms per operation:

| Benchmark | Exact check on every write | Accessor tracking |
|---|---:|---:|
| medium: read | 28.6 | 27.9 |
| medium: write after read | 46.3 | 0.70 |
| medium: write after reading every cel's pixels | 46.3 | 40.3 |
| large: write after read | 240.7 | 1.78 |
| many frames: read | 43.2 | 46.5 |
| many frames: write after read | 54.5 | 6.6 |

A copy of the decoded pixels taken at read time would make the "write after reading every cel's pixels" case about as fast as an untouched write, but it doubles the memory held for pixels, so it isn't used.
