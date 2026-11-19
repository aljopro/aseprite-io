# Changelog

## Unreleased
- Bound reader input, decoded buffers and aggregate pixel allocations; reject truncated, overlong or mismatched zlib streams. `AsepriteFile.read` accepts optional read-limit overrides.
- Verify cached compressed data against exact decoded bytes so Adler-32 collisions cannot discard pixel edits.
- Reuse compressed data without decompressing it when the decoded pixels, tiles or tileset were never read or replaced. Writing an unchanged file is about 65–135× faster than with the exact check alone, with no extra memory ([#15](https://github.com/aljopro/aseprite-io/issues/15)).
- Bound canvas and tile allocations, and reject tilemap bit widths the data model cannot preserve.
- Write valid zlib streams at compression level 0 for payloads whose length is a multiple of 65,535 bytes; the previous output ended the stream after a block marked final and was rejected by strict decoders.

- Preserve edited palettes when saving indexed files with legacy palette chunks.
- Preserve 8-, 16- and 32-bit tilemap entries when reading and saving.

## 0.1.0

First release: a TypeScript port of the Rust crate [`aseprite-io`](https://github.com/spebern/aseprite-io) (0.2.0).

- Read and write `.ase`/`.aseprite` files with byte-perfect round trips.
- Runs in browsers and Node.js 18+ (ESM + CommonJS, with type declarations).
- `write({ compressionLevel })` option.
- Interactive demo and API docs on GitHub Pages.
