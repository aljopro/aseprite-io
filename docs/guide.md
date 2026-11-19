---
title: Guide
---

# Using aseprite-io

This guide walks through the main tasks: reading, rendering, creating, editing and saving Aseprite files. For every type and method, see the [API reference](https://jensenchappell.com/aseprite-io/api/).

- [Concepts](#concepts)
- [Reading files](#reading-files)
- [Getting pixels](#getting-pixels)
- [Rendering a frame](#rendering-a-frame)
- [Creating files](#creating-files)
- [Editing an existing file](#editing-an-existing-file)
- [User data and properties](#user-data-and-properties)
- [Tilesets and tilemaps](#tilesets-and-tilemaps)
- [Saving files](#saving-files)
- [Errors](#errors)
- [Performance tips](#performance-tips)

## Concepts

An Aseprite document is a grid of **layers × frames**. Each cell of that grid can hold a **cel**:

```
             frame 0     frame 1     frame 2
layer 2  ┃  [cel]       [linked→0]  [cel]       ← top
layer 1  ┃  [cel]                   [cel]
layer 0  ┃  [cel]       [cel]       [cel]       ← bottom (often the background)
```

- **Layers** are listed bottom to top in `file.layers`. A layer is `normal`, a `group` (a folder for other layers; it never holds cels), or a `tilemap`. Nesting is expressed with `layer.parent`, the index of the parent group.
- **Frames** have a duration in milliseconds (`file.frames[i].durationMs`).
- **Cels** have a position (`x`, `y`) on the canvas and an opacity. A cel holds `raw` or `compressed` pixels, a `linked` reference to a cel in another frame, or `tilemap` data.
- **Tags** name ranges of frames (`idle`, `walk`, …) with a loop direction.
- **Slices** are named rectangles, optionally with nine-patch centers and pivots.
- **User data** (text, a color and typed properties) can be attached to the sprite, layers, cels, tags, slices, tilesets and individual tiles.

Pixel buffers depend on the file's `colorMode`:

| Color mode | Bytes per pixel | Layout |
|---|---|---|
| `'rgba'` | 4 | R, G, B, A (straight, not premultiplied) |
| `'grayscale'` | 2 | value, alpha |
| `'indexed'` | 1 | palette index (`file.palette`; `file.transparentIndex` is transparent on non-background layers) |

## Reading files

`AsepriteFile.read` is synchronous and accepts a `Uint8Array` (including a Node `Buffer`), an `ArrayBuffer` or a `DataView`.

```ts
import { AsepriteFile } from 'aseprite-io';

// Browser: from a URL
const res = await fetch('/sprites/hero.aseprite');
const file = AsepriteFile.read(await res.arrayBuffer());

// Browser: from <input type="file"> or drag and drop
input.addEventListener('change', async () => {
  const sprite = AsepriteFile.read(await input.files![0].arrayBuffer());
});

// Node.js
import { readFileSync } from 'node:fs';
const fromDisk = AsepriteFile.read(readFileSync('hero.aseprite'));
```

Inspect the document:

```ts
file.width; file.height; file.colorMode;
file.layers.map((l) => `${l.name} (${l.kind.type})`);
file.frames.map((f) => f.durationMs);
file.tags.map((t) => `${t.name}: ${t.fromFrame}–${t.toFrame} ${t.direction}`);
```

## Getting pixels

`file.cel(layer, frame)` returns the cel exactly as stored, which may be a `linked` cel. `file.resolveCel(layer, frame)` follows the link for you:

```ts
const cel = file.resolveCel(layerIndex, frameIndex);
if (cel && (cel.kind.type === 'compressed' || cel.kind.type === 'raw')) {
  const { pixels, x, y } = cel.kind;
  pixels.width; pixels.height; pixels.data; // Uint8Array
}
```

Note that the position of a linked cel is stored on the linked cel itself (`file.cel(layer, frame).kind.x`), not on its source.

To visit every cel, use `file.cels()`, which yields cels ordered by layer and then frame:

```ts
for (const { layer, frame, cel } of file.cels()) {
  console.log(layer, frame, cel.kind.type);
}
```

## Rendering a frame

aseprite-io parses and writes files; it does not include a renderer. Compositing a frame is short, though. Here is a minimal version for RGBA files that uses `normal` blending, respects layer visibility and opacity, and draws onto a canvas. The [demo's renderer](https://github.com/aljopro/aseprite-io/blob/main/demo/render.ts) also handles grayscale, indexed colors and tilemaps.

```ts
function drawFrame(file: AsepriteFile, frame: number, ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, file.width, file.height);
  file.layers.forEach((layer, index) => {
    if (layer.kind.type === 'group' || !isVisible(file, index)) return;
    const own = file.cel(index, frame);
    const cel = file.resolveCel(index, frame);
    if (!own || !cel || (cel.kind.type !== 'compressed' && cel.kind.type !== 'raw')) return;
    const { pixels } = cel.kind;
    const pos = own.kind.type === 'linked' ? own.kind : cel.kind;
    const bitmap = new OffscreenCanvas(pixels.width, pixels.height);
    bitmap.getContext('2d')!.putImageData(
      new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
    ctx.globalAlpha = (layer.opacity / 255) * (own.opacity / 255);
    ctx.drawImage(bitmap, pos.x, pos.y);
  });
  ctx.globalAlpha = 1;
}

function isVisible(file: AsepriteFile, index: number): boolean {
  for (let i: number | undefined = index; i !== undefined; i = file.layers[i].parent) {
    if (!file.layers[i].visible) return false;
  }
  return true;
}
```

Set `image-rendering: pixelated` on the canvas when you scale it up with CSS.

## Creating files

```ts
import { AsepriteFile, createPixels } from 'aseprite-io';

const file = new AsepriteFile(32, 32, 'rgba');

// Layers are added bottom to top.
const bg = file.addLayer('Background', { background: true });
const character = file.addGroup('Character');
const body = file.addLayer('Body', { parent: character });
const hat = file.addLayer('Hat', { parent: character, opacity: 200, blendMode: 'multiply' });

// Frames
const f0 = file.addFrame(100);
const f1 = file.addFrame(100);

// Cels. createPixels checks that the buffer size matches.
file.setCel(bg, f0, createPixels(bgPixels, 32, 32, 'rgba'));
file.setLinkedCel(bg, f1, f0); // reuse frame 0's background
file.setCel(body, f0, createPixels(bodyA, 16, 16, 'rgba'), { x: 8, y: 12 });
file.setCel(body, f1, createPixels(bodyB, 16, 16, 'rgba'), { x: 8, y: 11 });

// Tags
file.addTag('idle', f0, f1, 'ping-pong');

const bytes = file.write();
```

Cels are zlib-compressed by default. Pass `{ raw: true }` to `setCel` to store them uncompressed.

### From canvases

A canvas's `ImageData` is already straight RGBA, so it maps directly onto a cel:

```ts
const { data } = canvas.getContext('2d')!.getImageData(0, 0, w, h);
file.setCel(layer, frame, createPixels(new Uint8Array(data.buffer), w, h, 'rgba'));
```

The demo's "Canvas → Aseprite" tab builds a whole layered, animated sprite this way.

### Indexed sprites

```ts
const file = new AsepriteFile(8, 8, 'indexed');
file.setPalette([
  { r: 0, g: 0, b: 0, a: 0 },            // 0: transparent
  { r: 34, g: 32, b: 52, a: 255 },       // 1
  { r: 255, g: 255, b: 255, a: 255, name: 'White' },
]);
file.setTransparentIndex(0);
```

Indexed files must have a palette before `write()`; otherwise it throws `MissingPalette`.

## Editing an existing file

Everything returned by the accessors is a plain object, so you can modify it in place and write the file back:

```ts
const file = AsepriteFile.read(bytes);

file.layers[0].name = 'Renamed';
file.layers[0].visible = false;
file.tags[0].direction = 'reverse';

const cel = file.cel(0, 0);
if (cel?.kind.type === 'compressed') {
  cel.kind.pixels.data.fill(0); // edit pixels in place
}

const updated = file.write();
```

Unmodified data is written back byte for byte. Edited pixel data is detected and recompressed, and layers, slices or tilesets you add are included.

## User data and properties

```ts
file.setLayerUserData(body, {
  text: 'Player body',
  color: { r: 255, g: 0, b: 0, a: 255 },
  properties: [
    {
      key: 0, // 0 = user properties; other keys belong to extensions
      entries: [
        ['hp', { type: 'int32', value: 100 }],
        ['speed', { type: 'float', value: 1.5 }],
        ['id', { type: 'uint64', value: 123456789012345678n }],
        ['spawn', { type: 'point', x: 4, y: 8 }],
        ['tags', { type: 'vector', value: [{ type: 'string', value: 'hero' }] }],
        ['stats', { type: 'properties', value: [['str', { type: 'uint8', value: 7 }]] }],
      ],
    },
  ],
});
```

Every property value is a `{ type, ... }` object, so you can `switch` on `type`. 64-bit integers are `bigint`. `fixed` values are the raw 16.16 integer; divide by 65536 for the number.

User data can be set on the sprite (`setSpriteUserData`), layers and groups (`setLayerUserData`), cels (`setCelUserData`, or `userData` in the `setCel` options), tags (`setTagUserData`), slices (`userData` on the slice) and tilesets and tiles (`userData` and `tileUserData` on the tileset).

## Tilesets and tilemaps

```ts
import { TilesetFlags } from 'aseprite-io';

const ts = file.addTileset({
  id: 0,
  flags: TilesetFlags.EmbeddedTiles,
  name: 'Terrain',
  tileCount: 4,
  tileWidth: 8,
  tileHeight: 8,
  baseIndex: 1,
  // All tiles stacked vertically: 8 × (8 × 4) pixels, in the file's color mode.
  data: { type: 'embedded', pixels: tilePixels },
  tileUserData: [undefined, undefined, undefined, undefined],
});

const map = file.addTilemapLayer('Ground', ts);
// Tile entries: tile ID in the low 29 bits, then X, Y and diagonal flip bits.
file.setTilemapCel(map, 0, [1, 2, 2, 3 | 0x20000000], 2, 2);
```

Tile ID 0 is the empty tile.

## Saving files

```ts
const bytes = file.write();

// Node.js
import { writeFileSync } from 'node:fs';
writeFileSync('out.aseprite', bytes);

// Browser download
const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
const a = Object.assign(document.createElement('a'), { href: url, download: 'out.aseprite' });
a.click();
URL.revokeObjectURL(url);
```

## Errors

Everything that can fail throws `AsepriteError`, which has a `code`:

| Code | When |
|---|---|
| `UnexpectedEof` | The input is truncated. |
| `InvalidMagic` | The input is not an Aseprite file, or a frame header is corrupt. |
| `UnsupportedColorDepth` | The color depth is not 8, 16 or 32 bits. |
| `InvalidChunkSize` | A chunk declares an impossible size. |
| `UnsupportedPropertyType` | User data contains an unknown property type. |
| `DecompressionFailed` | zlib data is corrupt (`error.cause` has details). |
| `FrameOutOfBounds` | A cel or link points past the last frame. |
| `PixelSizeMismatch` | A pixel or tile buffer does not match its size and the color mode. |
| `InvalidFrameRange` | A tag's range is reversed or out of bounds. |
| `MissingPalette` | An indexed file has no palette when written. |
| `FormatLimitExceeded` | A value is too large for the format (more than 65,535 frames or layers, more than 256 colors, strings over 64 KiB). |

## Performance tips

- Reading and writing are synchronous. For very large files in a browser, run them in a Web Worker; the library works there unchanged.
- `file.write({ compressionLevel: 1 })` writes new pixel data about 1.7× faster, at the cost of larger files. Data you didn't change is reused as-is at any level.
- Prefer `file.cels()` or `file.cel()` lookups over scanning all layers × frames.

See [benchmarks](./benchmarks.md) for numbers.
