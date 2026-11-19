# Changelog

## Unreleased

- Preserve edited palettes when saving indexed files with legacy palette chunks.

## 0.1.0

First release: a TypeScript port of the Rust crate [`aseprite-io`](https://github.com/spebern/aseprite-io) (0.2.0).

- Read and write `.ase`/`.aseprite` files with byte-perfect round trips.
- Runs in browsers and Node.js 18+ (ESM + CommonJS, with type declarations).
- `write({ compressionLevel })` option.
- Interactive demo and API docs on GitHub Pages.
