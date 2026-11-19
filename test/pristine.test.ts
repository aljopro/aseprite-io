import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AsepriteFile, createPixels } from '../src/index.js';
import { bytesEqual } from '../src/zlib.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)));

function compressedCel(file: AsepriteFile) {
  for (const { cel } of file.cels()) if (cel.kind.type === 'compressed') return cel.kind;
  throw new Error('no compressed cel');
}

function tilemapCel(file: AsepriteFile) {
  for (const { cel } of file.cels()) if (cel.kind.type === 'tilemap') return cel.kind;
  throw new Error('no tilemap cel');
}

function sprite(): Uint8Array {
  const file = new AsepriteFile(4, 4, 'rgba');
  const layer = file.addLayer('L');
  file.addFrame(100);
  file.setCel(layer, 0, createPixels(new Uint8Array(64).fill(7), 4, 4, 'rgba'));
  return file.write();
}

describe('reuse of untouched decoded data (#15)', () => {
  it('writes untouched cels, tilemaps and tilesets back byte for byte', () => {
    for (const name of ['abcd.aseprite', '2x2tilemap2x2tile.aseprite', '3x2tilemap-grayscale.aseprite']) {
      const bytes = fixture(name);
      expect(AsepriteFile.read(bytes).write()).toEqual(bytes);
    }
  });

  it('detects in-place edits after the pixels were read', () => {
    const file = AsepriteFile.read(sprite());
    compressedCel(file).pixels.data[0] = 99;
    const pixels = compressedCel(AsepriteFile.read(file.write())).pixels.data;
    expect(pixels[0]).toBe(99);
  });

  it('detects a replaced pixel buffer', () => {
    const file = AsepriteFile.read(sprite());
    const kind = compressedCel(file);
    kind.pixels.data = new Uint8Array(64).fill(3);
    expect(compressedCel(AsepriteFile.read(file.write())).pixels.data).toEqual(new Uint8Array(64).fill(3));
  });

  it('detects a replaced pixels object', () => {
    const file = AsepriteFile.read(sprite());
    const kind = compressedCel(file);
    kind.pixels = createPixels(new Uint8Array(64).fill(5), 4, 4, 'rgba');
    expect(compressedCel(AsepriteFile.read(file.write())).pixels.data).toEqual(new Uint8Array(64).fill(5));
  });

  it('does not trust a replaced originalCompressed while the pixels are untouched', () => {
    // A valid stream for different pixels, swapped in without touching the decoded data.
    const edited = AsepriteFile.read(sprite());
    compressedCel(edited).pixels.data.fill(1);
    const foreign = compressedCel(AsepriteFile.read(edited.write())).originalCompressed;

    const file = AsepriteFile.read(sprite());
    compressedCel(file).originalCompressed = foreign;
    expect(compressedCel(AsepriteFile.read(file.write())).pixels.data).toEqual(new Uint8Array(64).fill(7));
  });

  it('treats copying the pixels object as exposing the buffer', () => {
    const file = AsepriteFile.read(sprite());
    const kind = compressedCel(file);
    const copy = { ...kind.pixels };
    copy.data[1] = 42;
    expect(compressedCel(AsepriteFile.read(file.write())).pixels.data[1]).toBe(42);
  });

  it('exposes the pixel buffer as an enumerable own property', () => {
    const kind = compressedCel(AsepriteFile.read(sprite()));
    expect(Object.keys(kind.pixels).sort()).toEqual(['data', 'height', 'width']);
    expect(kind.pixels).toEqual({ data: new Uint8Array(64).fill(7), width: 4, height: 4 });
  });

  it('re-encodes untouched tiles when the tile bit depth changes', () => {
    const file = AsepriteFile.read(fixture('2x2tilemap2x2tile.aseprite'));
    const kind = tilemapCel(file);
    const original = kind.originalCompressed!;
    kind.bitsPerTile = 16;
    const out = tilemapCel(AsepriteFile.read(file.write()));
    expect(out.bitsPerTile).toBe(16);
    expect(out.originalCompressed).not.toEqual(original);
    expect(Array.from(out.tiles)).toEqual(Array.from(tilemapCel(AsepriteFile.read(fixture('2x2tilemap2x2tile.aseprite'))).tiles));
  });

  it('detects edited tiles and tileset pixels after they were read', () => {
    const file = AsepriteFile.read(fixture('2x2tilemap2x2tile.aseprite'));
    tilemapCel(file).tiles[0] = 2;
    const ts = file.tilesets[0]!;
    if (ts.data.type !== 'embedded') throw new Error('expected embedded tiles');
    ts.data.pixels[0] = ts.data.pixels[0]! ^ 0xff;
    const expected = ts.data.pixels[0];
    const out = AsepriteFile.read(file.write());
    expect(tilemapCel(out).tiles[0]).toBe(2);
    const data = out.tilesets[0]!.data;
    expect(data.type === 'embedded' && data.pixels[0]).toBe(expected);
  });
});

describe('bytesEqual', () => {
  it('compares aligned and unaligned views', () => {
    const buf = new Uint8Array(23).map((_, i) => i);
    expect(bytesEqual(buf, buf.slice())).toBe(true);
    expect(bytesEqual(buf.subarray(1), buf.slice(1))).toBe(true);
    const tail = buf.slice();
    tail[22] = 0;
    expect(bytesEqual(buf, tail)).toBe(false);
    const head = buf.slice();
    head[2] = 0;
    expect(bytesEqual(buf, head)).toBe(false);
    expect(bytesEqual(buf, buf.subarray(1))).toBe(false);
  });
});
