# Benchmarks

Run them with:

```sh
npm run bench   # builds dist/, then runs bench/run.mjs with tinybench
```

The suite measures the built package (`dist/`) on three workloads:

- **small**: `file-tests-props.aseprite` from Aseprite's test suite (64×64, 4 layers, 6 frames).
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
2. **Changes are detected with Adler-32 instead of decompression.** To decide whether a cel's original zlib bytes can be reused, the writer compares an Adler-32 of the current pixels with the checksum stored in the zlib stream's trailer. That costs one pass over the bytes instead of a full inflate.
3. **Sized inflate.** Cels, tilemaps and tilesets are decompressed straight into a buffer of the known size (`w × h × bytes per pixel`), as Aseprite does, instead of a buffer that grows as it goes.
4. **Single output buffer.** Frames and chunks are written into one growing buffer, and size fields are patched afterwards. Previously each frame was assembled separately and then copied again.
5. **Faster Adler-32.** The checksum loop is unrolled 8×, which roughly doubles its throughput in V8.

Writing brand-new pixel data is dominated by deflate (fflate, pure JS). If speed matters more than size, `file.write({ compressionLevel: 1 })` is about 1.7× faster and produces files about 2.5× larger. Level 6, the default, matches Aseprite.
