# aseprite-io

Read and write [Aseprite](https://www.aseprite.org/) `.ase` / `.aseprite` files in TypeScript, in the **browser** and in **Node.js**.

A TypeScript port of the Rust crate [`aseprite-io`](https://github.com/spebern/aseprite-io) by spebern.

- **Read and write**, with **byte-perfect round trips**: reading a file and writing it back produces identical bytes.
- Full [file format](https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md) support: RGBA, grayscale and indexed color modes.
- All layer types (normal, group, tilemap) with blend modes, opacity and flags.
- Animation tags, slices (nine-patch and pivot), and user data with typed properties (including nested maps, vectors, 64-bit integers as `bigint`, and UUIDs).
- Tilesets (embedded and external), 32-bit tilemap cels (the width specified by the current ASE format), linked cels, cel extras, color profiles, external files, and legacy palette and mask chunks.
- Runs anywhere: it only needs `Uint8Array`, `DataView` and `TextEncoder`/`TextDecoder`. Its pure-JS zlib dependencies are [`fflate`](https://github.com/101arrowz/fflate) and [`pako`](https://github.com/nodeca/pako). No Node built-ins, no WASM, no async.
- Ships as ESM and CommonJS with TypeScript types, and is tree-shakeable (`sideEffects: false`).
- Fast: reading or writing a 2,000-frame file takes about 10 ms. See [benchmarks](docs/benchmarks.md).

**[Live demo](https://jensenchappell.com/aseprite-io/)** · **[Guide](docs/guide.md)** · **[API reference](https://jensenchappell.com/aseprite-io/api/)**

## Install

```sh
npm install aseprite-io
```

## Reading

```ts
import { AsepriteFile } from 'aseprite-io';

// Node.js
import { readFile } from 'node:fs/promises';
const file = AsepriteFile.read(await readFile('sprite.aseprite'));

// Browser
const file2 = AsepriteFile.read(await (await fetch('/sprite.aseprite')).arrayBuffer());

console.log(`${file.width}×${file.height}, ${file.frames.length} frames`);
for (const layer of file.layers) console.log('layer:', layer.name, layer.kind.type);
for (const tag of file.tags) console.log('tag:', tag.name, tag.fromFrame, '→', tag.toFrame);
```

`AsepriteFile.read` accepts a `Uint8Array` (including a Node `Buffer`), an `ArrayBuffer`, or any `ArrayBufferView`.

By default, reading enforces a 128 MiB input limit, a 64 MiB per decoded cel or tileset limit, a 256 MiB aggregate decoded-data limit, and a maximum canvas/cel/tile dimension of 16,384. The canvas pixel area is also limited to 64 MiB of decoded pixel data. Hosts can override individual limits:

```ts
const file = AsepriteFile.read(bytes, { maxTotalDecodedBytes: 64 * 1024 * 1024 });
```

`AsepriteFile.read` rejects oversized or truncated decoded streams with `AsepriteError`; limits are applied before decoded buffers are allocated.

### Getting pixels

Cels are stored per layer and frame. Use `resolveCel` to follow linked cels:

```ts
for (const { layer, frame } of file.cels()) {
  const cel = file.resolveCel(layer, frame);
  if (cel?.kind.type === 'compressed' || cel?.kind.type === 'raw') {
    const { pixels, x, y } = cel.kind;
    // pixels.data is RGBA (4 bytes/px), grayscale (2 bytes/px: value, alpha) or
    // indexed (1 byte/px, see file.palette), depending on file.colorMode.
  }
}
```

Drawing an RGBA cel onto a canvas in the browser:

```ts
const { pixels } = cel.kind;
const image = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
canvas.getContext('2d')!.putImageData(image, x, y);
```

## Writing

```ts
import { AsepriteFile, createPixels } from 'aseprite-io';

const file = new AsepriteFile(16, 16, 'rgba');
const layer = file.addLayer('Background');
const frame = file.addFrame(100); // duration in ms

const data = new Uint8Array(16 * 16 * 4).fill(255);
file.setCel(layer, frame, createPixels(data, 16, 16, 'rgba'));
file.addTag('idle', 0, 0, 'forward');

const bytes: Uint8Array = file.write();

// Node.js
import { writeFile } from 'node:fs/promises';
await writeFile('output.aseprite', bytes);

// Browser: trigger a download
const url = URL.createObjectURL(new Blob([bytes]));
Object.assign(document.createElement('a'), { href: url, download: 'output.aseprite' }).click();
```

### More of the builder API

```ts
const group = file.addGroup('Character', { collapsed: true });
const body = file.addLayer('Body', { parent: group, opacity: 200, blendMode: 'multiply' });

file.setCel(body, 0, pixels, { x: 4, y: -2, opacity: 128, zIndex: 1 });
file.setCel(body, 1, pixels, { raw: true }); // store uncompressed
file.setLinkedCel(body, 2, 0);               // frame 2 reuses frame 0's cel

file.setLayerUserData(body, {
  text: 'hero',
  color: { r: 255, g: 0, b: 0, a: 255 },
  properties: [{ key: 0, entries: [
    ['health', { type: 'int32', value: 100 }],
    ['spawn', { type: 'point', x: 10, y: 20 }],
  ] }],
});

file.addSlice({
  name: 'button', hasNinePatch: true, hasPivot: false,
  keys: [{ frame: 0, x: 0, y: 0, width: 16, height: 16,
           ninePatch: { centerX: 4, centerY: 4, centerWidth: 8, centerHeight: 8 } }],
});
```

Indexed files need a palette before they can be written: `file.setPalette([{ r, g, b, a }, ...])`.

## Round-trip fidelity

When you read a file, the library records the order of chunks and keeps the original zlib streams, so writing an unmodified file reproduces the input byte for byte. All 19 sample files from Aseprite's own test suite round-trip this way, in Node and in a real browser.

You can edit what you read and write it back:

- Compressed pixel, tilemap and tileset data is reused only while it still decompresses to the current data. If you edit `pixels.data` in place, it is recompressed automatically.
- If you add layers, tilesets, slices or tags to a file you read, the writer switches to its default chunk order so nothing is dropped. New cels on existing frames are appended to those frames.

## Errors

Every failure throws an `AsepriteError` with a machine-readable `code`:

```ts
import { AsepriteError } from 'aseprite-io';

try {
  AsepriteFile.read(bytes);
} catch (e) {
  if (e instanceof AsepriteError && e.code === 'InvalidMagic') {
    // not an Aseprite file
  }
}
```

The codes are `UnexpectedEof`, `InvalidMagic`, `UnsupportedColorDepth`, `FrameOutOfBounds`, `PixelSizeMismatch`, `InvalidFrameRange`, `MissingPalette`, `InvalidChunkSize`, `UnsupportedPropertyType`, `UnsupportedTileBitDepth`, `FormatLimitExceeded` and `DecompressionFailed`.

## Differences from the Rust crate

The data model and binary behavior follow the Rust crate. The API is adapted to TypeScript:

| Rust | TypeScript |
|---|---|
| `AsepriteFile::from_reader(r)` / `write_to(w)` | `AsepriteFile.read(bytes)` / `file.write()` |
| `enum`s such as `CelKind::Compressed { .. }` | Discriminated unions: `{ type: 'compressed', ... }` |
| `Option<T>` | Optional properties (`undefined`) |
| `add_layer_with`, `add_layer_in`, `set_cel_with`, `set_raw_cel`, … | One method each, with an options object (`{ parent, raw, x, y, ... }`) |
| `PropertyValue::Int64(i64)` | `{ type: 'int64', value: bigint }` |
| `LayerRef` / `GroupRef` | Branded `number` types (layer indices) |

Additions in the TypeScript version:

- Editing pixels in place is safe; see [Round-trip fidelity](#round-trip-fidelity).
- Layers, tilesets and slices added to a file you read are written out.
- Chunks are bounds-checked, so a malformed chunk throws instead of reading into the next one.
- Extra helpers: `cels()`, `removeCel()`, `setGrid()`, `setPixelRatio()`, and `write({ compressionLevel })`.
- Performance work, described in [docs/benchmarks.md](docs/benchmarks.md).

## Development

```sh
npm install
npm test               # vitest: fixture round trips, write/read and error tests
npm run test:coverage  # the same, failing if coverage drops below 90%
npm run typecheck      # library (no Node types), tests and demo
npm run build          # tsup: dist/index.{js,cjs,d.ts}
npm run check:browser  # bundle for the browser and run it in a sandbox without Node globals
npm run bench          # tinybench performance suite
npm run dev:demo       # demo with live rebuilds at http://127.0.0.1:5179
npm run site           # build the demo and API docs into site/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request and release process.

## License

[MIT](LICENSE). This is a port of the Rust crate [`aseprite-io`](https://github.com/spebern/aseprite-io) by spebern (MIT OR Apache-2.0), used here under its MIT option. The test fixtures in `test/fixtures` come from the Aseprite test suite and are MIT-licensed; see [test/fixtures/LICENSE](test/fixtures/LICENSE).
