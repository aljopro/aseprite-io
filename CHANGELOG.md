# Changelog

## Unreleased

## 1.0.0

First stable release. The public API now follows semantic versioning: breaking changes only in major versions.

### Security and correctness
- Bound reader input, decoded buffers and aggregate pixel allocations; reject truncated, overlong or mismatched zlib streams. `AsepriteFile.read(input, limits)` accepts optional `ReadLimits` overrides ([#10](https://github.com/aljopro/aseprite-io/issues/10)).
- Verify cached compressed data against exact decoded bytes so Adler-32 collisions can no longer discard pixel edits ([#11](https://github.com/aljopro/aseprite-io/issues/11)).
- Preserve edited palettes when saving indexed files with legacy palette chunks ([#9](https://github.com/aljopro/aseprite-io/issues/9)).
- Preserve 8-, 16- and 32-bit tilemap entries when reading and saving ([#16](https://github.com/aljopro/aseprite-io/issues/16)).
- Write valid zlib streams at compression level 0 for payloads whose length is a multiple of 65,535 bytes; strict decoders rejected the previous output.

### Performance
- Reuse compressed data without decompressing it when the decoded pixels, tiles or tileset were never read or replaced. Writing an unchanged file is about 65–135× faster than with the exact check alone, with no extra memory ([#15](https://github.com/aljopro/aseprite-io/issues/15)).

### Upgrade notes
- Files with corrupt or mismatched zlib data that 0.1.0 accepted now throw `DecompressionFailed`, and files over the read limits throw `FormatLimitExceeded`. Raise the limits with the second argument to `AsepriteFile.read` if you read very large files.
- New error code `UnsupportedTileBitDepth`.
- On objects returned by `AsepriteFile.read`, `pixels.data`, tilemap `tiles` and embedded tileset `pixels` are now accessor properties. Reading, assigning, spreading and cloning them work as before.

## 0.1.0

First release: a TypeScript port of the Rust crate [`aseprite-io`](https://github.com/spebern/aseprite-io) (0.2.0).

- Read and write `.ase`/`.aseprite` files with byte-perfect round trips.
- Runs in browsers and Node.js 18+ (ESM + CommonJS, with type declarations).
- `write({ compressionLevel })` option.
- Interactive demo and API docs on GitHub Pages.
