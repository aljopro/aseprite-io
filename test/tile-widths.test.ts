import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AsepriteFile } from '../src/index.js';

interface Masks {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly d: number;
}

const MASKS: Record<8 | 16 | 32, Masks> = {
  8: { id: 0x1f, x: 0x20, y: 0x40, d: 0x80 },
  16: { id: 0x0fff, x: 0x1000, y: 0x2000, d: 0x4000 },
  32: { id: 0x1fffffff, x: 0x20000000, y: 0x40000000, d: 0x80000000 },
};

/** Locate the first frame's tilemap cel without using the library reader. */
function tilemapChunk(bytes: Uint8Array): number {
  const b = Buffer.from(bytes);
  let offset = 144;
  while (offset < b.length) {
    if (b.readUInt16LE(offset + 4) === 0x2005 && b.readUInt16LE(offset + 13) === 3) return offset;
    offset += b.readUInt32LE(offset);
  }
  throw new Error('tilemap cel missing');
}

/**
 * Author a 2×2 tilemap with independently encoded little-endian tile values and
 * width-appropriate masks. The stored stream uses level 0 so a writer that
 * recompresses instead of reusing the original bytes cannot fake equality.
 */
function sample(bits: 8 | 16 | 32, values: number[]): Buffer {
  const masks = MASKS[bits];
  const file = new AsepriteFile(2, 2, 'rgba');
  const layer = file.addTilemapLayer('Map', 0);
  file.addFrame(100);
  file.setTilemapCel(layer, 0, [0, 0, 0, 0], 2, 2);
  const original = Buffer.from(file.write({ compressionLevel: 0 }));
  const start = tilemapChunk(original);
  const previousSize = original.readUInt32LE(start);
  const raw = Buffer.alloc(values.length * bits / 8);
  for (let i = 0; i < values.length; i++) raw.writeUIntLE(values[i]!, i * bits / 8, bits / 8);
  const chunk = Buffer.concat([original.subarray(start, start + 54), deflateSync(raw, { level: 0 })]);
  chunk.writeUInt32LE(chunk.length, 0);
  chunk.writeUInt16LE(bits, 26);
  chunk.writeUInt32LE(masks.id, 28);
  chunk.writeUInt32LE(masks.x, 32);
  chunk.writeUInt32LE(masks.y, 36);
  chunk.writeUInt32LE(masks.d, 40);
  const result = Buffer.concat([original.subarray(0, start), chunk, original.subarray(start + previousSize)]);
  result.writeUInt32LE(result.length, 0);
  result.writeUInt32LE(original.readUInt32LE(128) - previousSize + chunk.length, 128);
  return result;
}

describe('tilemap bit widths', () => {
  for (const bits of [8, 16, 32] as const) {
    it(`reads and writes ${bits}-bit tiles with their own masks and no recompressed false match`, () => {
      const masks = MASKS[bits];
      const values = bits === 8
        ? [1, masks.x | 2, masks.id, 3]
        : bits === 16
          ? [1, masks.x | 2, masks.id, 3]
          : [1, (masks.x | 2) >>> 0, masks.id, 3];
      const bytes = sample(bits, values);
      const doc = AsepriteFile.read(bytes);
      const cel = doc.cel(doc.layerRef(0)!, 0)!;
      if (cel.kind.type !== 'tilemap') throw new Error('expected tilemap');
      expect([...cel.kind.tiles]).toEqual(values);
      expect([cel.kind.tileIdBitmask, cel.kind.xFlipBitmask, cel.kind.yFlipBitmask, cel.kind.dFlipBitmask])
        .toEqual([masks.id, masks.x, masks.y, masks.d]);
      expect((values[1]! & masks.x) !== 0).toBe(true);
      expect((values[1]! & masks.id)).toBe(2);
      expect(Buffer.from(doc.write())).toEqual(bytes);
      cel.kind.tiles[0] = 7;
      const output = Buffer.from(doc.write());
      const start = tilemapChunk(output);
      expect(output.readUInt32LE(start + 28)).toBe(masks.id);
      expect(output.readUInt32LE(start + 32)).toBe(masks.x);
      expect(output.readUInt32LE(start + 36)).toBe(masks.y);
      expect(output.readUInt32LE(start + 40)).toBe(masks.d);
      expect(output.readUInt16LE(start + 26)).toBe(bits);
      const raw = inflateSync(output.subarray(start + 54, start + output.readUInt32LE(start)));
      expect(raw.length).toBe(4 * bits / 8);
      expect(raw.readUIntLE(0, bits / 8)).toBe(7);
      for (let i = 1; i < values.length; i++) expect(raw.readUIntLE(i * bits / 8, bits / 8)).toBe(values[i]);
      const reopened = AsepriteFile.read(output).cel(doc.layerRef(0)!, 0)!;
      if (reopened.kind.type !== 'tilemap') throw new Error('expected tilemap');
      expect([...reopened.kind.tiles]).toEqual([7, ...values.slice(1)]);
    });
  }

  it('refuses an edit too large for the original tile width', () => {
    const doc = AsepriteFile.read(sample(8, [1, 2, 3, 4]));
    const cel = doc.cel(doc.layerRef(0)!, 0)!;
    if (cel.kind.type !== 'tilemap') throw new Error('expected tilemap');
    cel.kind.tiles[0] = 256;
    expect(() => doc.write()).toThrow(/exceeds 8 bits/);
  });

  it('rejects a malformed width instead of silently decoding 32-bit values', () => {
    const bytes = sample(8, [1, 2, 3, 4]);
    bytes.writeUInt16LE(24, tilemapChunk(bytes) + 26);
    expect(() => AsepriteFile.read(bytes)).toThrow(/unsupported tile bit depth 24/);
  });
});
