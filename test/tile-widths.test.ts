import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AsepriteFile } from '../src/index.js';

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

/** Author a 2×2 tilemap with independently encoded little-endian tile values. */
function sample(bits: 8 | 16 | 32, values: number[]): Buffer {
  const file = new AsepriteFile(2, 2, 'rgba');
  const layer = file.addTilemapLayer('Map', 0);
  file.addFrame(100);
  file.setTilemapCel(layer, 0, [0, 0, 0, 0], 2, 2);
  const original = Buffer.from(file.write());
  const start = tilemapChunk(original);
  const previousSize = original.readUInt32LE(start);
  const raw = Buffer.alloc(values.length * bits / 8);
  for (let i = 0; i < values.length; i++) raw.writeUIntLE(values[i]!, i * bits / 8, bits / 8);
  const chunk = Buffer.concat([original.subarray(start, start + 54), deflateSync(raw)]);
  chunk.writeUInt32LE(chunk.length, 0);
  chunk.writeUInt16LE(bits, 26);
  const result = Buffer.concat([original.subarray(0, start), chunk, original.subarray(start + previousSize)]);
  result.writeUInt32LE(result.length, 0);
  result.writeUInt32LE(original.readUInt32LE(128) - previousSize + chunk.length, 128);
  return result;
}

describe('tilemap bit widths', () => {
  for (const bits of [8, 16, 32] as const) {
    it(`reads and writes ${bits}-bit tiles without losing values`, () => {
      const values = bits === 8 ? [1, 0x80, 0xff, 3] : bits === 16 ? [1, 0x8000, 0xffff, 3] : [1, 0x80000000, 0xffffffff, 3];
      const bytes = sample(bits, values);
      const doc = AsepriteFile.read(bytes);
      const cel = doc.cel(doc.layerRef(0)!, 0)!;
      if (cel.kind.type !== 'tilemap') throw new Error('expected tilemap');
      expect([...cel.kind.tiles]).toEqual(values);
      expect(Buffer.from(doc.write())).toEqual(bytes);
      cel.kind.tiles[0] = 7;
      const output = Buffer.from(doc.write());
      const start = tilemapChunk(output);
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
});
