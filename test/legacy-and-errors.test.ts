import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AsepriteError, AsepriteFile, TilesetFlags, createPixels } from '../src/index.js';

/** Appends raw chunks to frame 0 of a single-frame file and fixes up the sizes. */
function withExtraChunks(file: AsepriteFile, chunks: Array<{ type: number; data: number[] }>): Uint8Array {
  const base = file.write();
  const extra: number[] = [];
  for (const c of chunks) {
    const size = c.data.length + 6;
    extra.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, size >>> 24);
    extra.push(c.type & 0xff, c.type >> 8, ...c.data);
  }
  const out = new Uint8Array(base.length + extra.length);
  out.set(base);
  out.set(extra, base.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, true); // file size
  view.setUint32(128, view.getUint32(128, true) + extra.length, true); // frame size
  view.setUint16(134, view.getUint16(134, true) + chunks.length, true); // old chunk count
  view.setUint32(140, view.getUint32(140, true) + chunks.length, true); // new chunk count
  return out;
}

function replaceCompressedCel(file: AsepriteFile, width: number, height: number, compressed: Uint8Array): Uint8Array {
  const bytes = file.write();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 144;
  while (pos + 6 <= bytes.length) {
    const size = view.getUint32(pos, true);
    if (view.getUint16(pos + 4, true) === 0x2005) {
      const data = pos + 6;
      const output = new Uint8Array(bytes.length - size + 6 + 20 + compressed.length);
      output.set(bytes.subarray(0, data + 16));
      const outView = new DataView(output.buffer);
      outView.setUint16(data + 16, width, true);
      outView.setUint16(data + 18, height, true);
      output.set(compressed, data + 20);
      output.set(bytes.subarray(pos + size), data + 20 + compressed.length);
      outView.setUint32(pos, 26 + compressed.length, true);
      outView.setUint32(128, view.getUint32(128, true) - size + 26 + compressed.length, true);
      outView.setUint32(0, output.length, true);
      return output;
    }
    pos += size;
  }
  throw new Error('missing compressed cel');
}

function setTilemapBits(file: AsepriteFile, bitsPerTile: number): Uint8Array {
  const bytes = file.write();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 144; pos + 6 <= bytes.length;) {
    const size = view.getUint32(pos, true);
    if (view.getUint16(pos + 4, true) === 0x2005 && view.getUint16(pos + 13, true) === 3) {
      view.setUint16(pos + 6 + 20, bitsPerTile, true);
      return bytes;
    }
    pos += size;
  }
  throw new Error('missing tilemap cel');
}
function compressedCelPayload(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 144; pos + 6 <= bytes.length;) {
    const size = view.getUint32(pos, true);
    if (view.getUint16(pos + 4, true) === 0x2005 &&
        view.getUint16(pos + 13, true) === 2) {
      return bytes.subarray(pos + 26, pos + size);
    }
    pos += size;
  }
  throw new Error('missing compressed cel');
}
const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];

function baseFile(): AsepriteFile {
  const file = new AsepriteFile(2, 2, 'rgba');
  file.addLayer('L');
  file.addFrame(100);
  return file;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AsepriteError) return e.code;
    throw e;
  }
  return undefined;
}

describe('legacy chunks', () => {
  it('parses old palette 0x0004 and keeps it for round trips', () => {
    // 1 packet: skip 1, 2 colors.
    const bytes = withExtraChunks(baseFile(), [
      { type: 0x0004, data: [...u16(1), 1, 2, 10, 20, 30, 40, 50, 60] },
    ]);
    const file = AsepriteFile.read(bytes);
    expect(file.palette.slice(1, 3)).toEqual([
      { r: 10, g: 20, b: 30, a: 255 },
      { r: 40, g: 50, b: 60, a: 255 },
    ]);
    expect(file.write()).toEqual(bytes);
  });

  it('parses 6-bit old palette 0x0011 (count 0 = 256 colors)', () => {
    const data = [...u16(1), 0, 0];
    for (let i = 0; i < 256; i++) data.push(63, 32, 0);
    const bytes = withExtraChunks(baseFile(), [{ type: 0x0011, data }]);
    const file = AsepriteFile.read(bytes);
    expect(file.palette.length).toBe(256);
    expect(file.palette[0]).toEqual({ r: 255, g: 130, b: 0, a: 255 });
    expect(file.write()).toEqual(bytes);
  });

  it('parses legacy mask chunks into typed data', () => {
    const name = [...new TextEncoder().encode('mask')];
    const data = [...u16(10), ...u16(20), ...u16(8), ...u16(1), ...new Array(8).fill(0), ...u16(name.length), ...name, 0xff];
    const bytes = withExtraChunks(baseFile(), [
      { type: 0x2016, data },
      { type: 0x2016, data: [1, 2, 3] }, // too short: ignored but preserved
    ]);
    const file = AsepriteFile.read(bytes);
    expect(file.legacyMasks).toEqual([
      { x: 10, y: 20, width: 8, height: 1, name: 'mask', bitmap: new Uint8Array([0xff]) },
    ]);
    expect(file.write()).toEqual(bytes);
  });

  it('preserves unknown chunks, also when falling back to default order', () => {
    const bytes = withExtraChunks(baseFile(), [{ type: 0x7777, data: [1, 2, 3, 4] }]);
    const file = AsepriteFile.read(bytes);
    expect(file.write()).toEqual(bytes);
    file.addLayer('new'); // forces default chunk order
    const reread = AsepriteFile.read(file.write());
    expect(reread.layers.map((l) => l.name)).toEqual(['L', 'new']);
    expect(reread.write().includes(0x77)).toBe(true);
  });

  it('ignores cels with an unknown cel type', () => {
    const cel = [...u16(0), ...u16(0), ...u16(0), 255, ...u16(9), ...u16(0), 0, 0, 0, 0, 0];
    const file = AsepriteFile.read(withExtraChunks(baseFile(), [{ type: 0x2005, data: cel }]));
    expect([...file.cels()]).toEqual([]);
  });
});

describe('malformed input', () => {
  it('rejects chunk sizes below the header size', () => {
    const bytes = withExtraChunks(baseFile(), [{ type: 0x2020, data: [] }]);
    const view = new DataView(bytes.buffer);
    view.setUint32(bytes.length - 6, 3, true);
    expect(codeOf(() => AsepriteFile.read(bytes))).toBe('InvalidChunkSize');
  });

  it('rejects a bad frame magic number', () => {
    const bytes = baseFile().write();
    bytes[132] = 0;
    expect(codeOf(() => AsepriteFile.read(bytes))).toBe('InvalidMagic');
  });

  it('reports corrupt zlib data', () => {
    const cel = [...u16(0), ...u16(0), ...u16(0), 255, ...u16(2), ...u16(0), 0, 0, 0, 0, 0, ...u16(1), ...u16(1), 1, 2, 3, 4];
    const bytes = withExtraChunks(baseFile(), [{ type: 0x2005, data: cel }]);
    const err = (() => {
      try {
        AsepriteFile.read(bytes);
      } catch (e) {
        return e as AsepriteError;
      }
    })();
    expect(err?.code).toBe('DecompressionFailed');
    expect(err?.cause).toBeDefined();
  });

  it('rejects unknown property types', () => {
    const name = [...new TextEncoder().encode('p')];
    const props = [...u32(1), ...u32(0), ...u32(1), ...u16(name.length), ...name, ...u16(0x99)];
    const ud = [...u32(4), ...u32(4 + props.length), ...props];
    const bytes = withExtraChunks(baseFile(), [{ type: 0x2020, data: ud }]);
    expect(codeOf(() => AsepriteFile.read(bytes))).toBe('UnsupportedPropertyType');
  });

  it('rejects an invalid user data property block size', () => {
    const bytes = withExtraChunks(baseFile(), [{ type: 0x2020, data: [...u32(4), ...u32(2)] }]);
    expect(codeOf(() => AsepriteFile.read(bytes))).toBe('InvalidChunkSize');
  });

  it('rejects non-binary input types', () => {
    expect(() => AsepriteFile.read('nope' as unknown as Uint8Array)).toThrow(TypeError);
  });
});

describe('writer limits and edits', () => {
  it('rejects oversized dimensions, long strings and bad UUIDs', () => {
    expect(codeOf(() => new AsepriteFile(70000, 1, 'rgba').write())).toBe('FormatLimitExceeded');
    const file = baseFile();
    file.addLayer('x'.repeat(70000));
    expect(codeOf(() => file.write())).toBe('FormatLimitExceeded');
    const uuid = baseFile();
    uuid.setSpriteUserData({ properties: [{ key: 0, entries: [['id', { type: 'uuid', value: new Uint8Array(3) }]] }] });
    expect(codeOf(() => uuid.write())).toBe('FormatLimitExceeded');
  });

  it('validates tilemap cel sizes', () => {
    const file = baseFile();
    const layer = file.addTilemapLayer('T', 0);
    expect(codeOf(() => file.setTilemapCel(layer, 0, [1, 2, 3], 2, 2))).toBe('PixelSizeMismatch');
  });

  it('writes user data, extras and cels added to a file that was read', () => {
    const src = baseFile();
    const layer = src.layerRef(0)!;
    src.addFrame(100);
    src.addSlice({ name: 's', hasNinePatch: false, hasPivot: false, keys: [{ frame: 0, x: 0, y: 0, width: 1, height: 1 }] });
    src.setPalette([{ r: 1, g: 2, b: 3, a: 255 }]);
    src.setCel(layer, 0, createPixels(new Uint8Array(16), 2, 2, 'rgba'));

    const file = AsepriteFile.read(src.write());
    file.setLayerUserData(layer, { text: 'layer', properties: [] });
    file.setCelUserData(layer, 0, { text: 'cel', properties: [] });
    file.setCelExtra(layer, 0, { preciseX: 1, preciseY: 2, width: 3, height: 4 });
    file.setSpriteUserData({ text: 'sprite', properties: [] });
    file._slices[0]!.userData = { text: 'slice', properties: [] };
    file.setCel(layer, 1, createPixels(new Uint8Array(16).fill(5), 2, 2, 'rgba'), {
      userData: { text: 'new cel', properties: [] },
      extra: { preciseX: 5, preciseY: 6, width: 7, height: 8 },
    });

    const out = AsepriteFile.read(file.write());
    expect(out.layers[0]!.userData?.text).toBe('layer');
    expect(out.cel(layer, 0)!.userData?.text).toBe('cel');
    expect(out.cel(layer, 0)!.extra).toEqual({ preciseX: 1, preciseY: 2, width: 3, height: 4 });
    expect(out.spriteUserData?.text).toBe('sprite');
    expect(out.slices[0]!.userData?.text).toBe('slice');
    expect(out.cel(layer, 1)!.userData?.text).toBe('new cel');
    expect(out.cel(layer, 1)!.extra?.preciseX).toBe(5);
  });

  it('writes sprite user data without a palette by adding a minimal one', () => {
    const file = baseFile();
    file.setSpriteUserData({ text: 'hi', properties: [] });
    expect(AsepriteFile.read(file.write()).spriteUserData?.text).toBe('hi');
  });

  it('writes an empty embedded tileset when flags and data disagree', () => {
    const file = baseFile();
    file.addTileset({
      id: 0, flags: 3, name: 't', tileCount: 0, tileWidth: 1, tileHeight: 1, baseIndex: 1,
      data: { type: 'empty' }, tileUserData: [],
    });
    const ts = AsepriteFile.read(file.write()).tilesets[0]!;
    expect(ts.data.type).toBe('embedded');
  });

  it('writes slice keys missing nine-patch or pivot data as zeros', () => {
    const file = baseFile();
    file.addSlice({ name: 's', hasNinePatch: true, hasPivot: true, keys: [{ frame: 0, x: 1, y: 1, width: 1, height: 1 }] });
    const key = AsepriteFile.read(file.write()).slices[0]!.keys[0]!;
    expect(key.ninePatch).toEqual({ centerX: 0, centerY: 0, centerWidth: 0, centerHeight: 0 });
    expect(key.pivot).toEqual({ x: 0, y: 0 });
  });

  it('resolveCel returns undefined for dangling links', () => {
    const file = baseFile();
    file.addFrame(100);
    file.setLinkedCel(file.layerRef(0)!, 1, 0);
    expect(file.resolveCel(0, 1)).toBeUndefined();
    expect(file.resolveCel(0, 0)).toBeUndefined();
  });
});

describe('zlib helpers', async () => {
  const { adler32, inflate, deflate } = await import('../src/zlib.js');
  it('adler32 matches the zlib trailer for many sizes', () => {
    for (const n of [0, 1, 7, 8, 9, 5551, 5552, 5553, 20000, 100003]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + (i >> 3)) & 0xff);
      const z = deflate(data);
      const trailer = ((z[z.length - 4]! << 24) | (z[z.length - 3]! << 16) | (z[z.length - 2]! << 8) | z[z.length - 1]!) >>> 0;
      expect(adler32(data)).toBe(trailer);
    }
  });
  it('rejects zero-sized cel bombs, mismatched and truncated output', () => {
    const bomb = deflate(new Uint8Array(1024 * 1024));
    const file = baseFile();
    file.setCel(file.layerRef(0)!, 0, { data: new Uint8Array(16), width: 2, height: 2 });
    const zeroCel = replaceCompressedCel(file, 0, 0, bomb);
    expect(codeOf(() => AsepriteFile.read(zeroCel))).toBe('DecompressionFailed');
    expect(codeOf(() => inflate(bomb, 0))).toBe('DecompressionFailed');
    expect(codeOf(() => inflate(deflate(new Uint8Array(10)), 9))).toBe('DecompressionFailed');
    expect(codeOf(() => inflate(deflate(new Uint8Array(10)), 11))).toBe('DecompressionFailed');
    expect(codeOf(() => inflate(bomb, 32))).toBe('DecompressionFailed');
    expect(codeOf(() => inflate(deflate(new Uint8Array(32)).subarray(0, 7), 32))).toBe('DecompressionFailed');
  });
  it('preserves valid empty and ordinary streams', () => {
    const data = new Uint8Array(100).map((_, i) => i);
    expect(inflate(deflate(data), data.length)).toEqual(data);
    expect(inflate(deflate(new Uint8Array(0)), 0)).toEqual(new Uint8Array(0));
  });

  it('enforces per-buffer, aggregate, canvas and tile dimensions', () => {

    const largeCel = new AsepriteFile(1, 1, 'rgba');
    const largeLayer = largeCel.addLayer('L');
    largeCel.addFrame(100);
    largeCel.setCel(largeLayer, 0, { data: new Uint8Array(16), width: 2, height: 2 });
    expect(codeOf(() => AsepriteFile.read(largeCel.write(), { maxDecodedBytes: 15 }))).toBe('FormatLimitExceeded');
    expect(codeOf(() => AsepriteFile.read(largeCel.write(), { maxDimension: 1 }))).toBe('FormatLimitExceeded');
    expect(codeOf(() => AsepriteFile.read(baseFile().write(), { maxDecodedBytes: undefined } as never))).toBeUndefined();
    const overDimension = baseFile().write();
    const overDimensionView = new DataView(overDimension.buffer);
    overDimensionView.setUint16(8, 20000, true);
    overDimensionView.setUint16(10, 1, true);
    expect(codeOf(() => AsepriteFile.read(overDimension))).toBe('FormatLimitExceeded');
    expect(codeOf(() => AsepriteFile.read(baseFile().write(), { maxDecodedBytes: 15 }))).toBe('FormatLimitExceeded');

    const aggregate = baseFile();
    const aggregateLayer = aggregate.layerRef(0)!;
    aggregate.setCel(aggregateLayer, 0, { data: new Uint8Array(16), width: 2, height: 2 });
    aggregate.addFrame(100);
    aggregate.setCel(aggregateLayer, 1, { data: new Uint8Array(16), width: 2, height: 2 });
    expect(codeOf(() => AsepriteFile.read(aggregate.write(), { maxTotalDecodedBytes: 31 }))).toBe('FormatLimitExceeded');

    const external = baseFile();
    external.addTileset({
      id: 0, flags: TilesetFlags.ExternalLink, name: 'external', tileCount: 0,
      tileWidth: 8, tileHeight: 8, baseIndex: 1,
      data: { type: 'external', externalFileId: 1, tilesetIdInExternal: 0 }, tileUserData: [],
    });
    expect(codeOf(() => AsepriteFile.read(external.write(), { maxDimension: 4 }))).toBe('FormatLimitExceeded');
  });

  it('rejects a narrow tilemap header over 32-bit payload data', () => {
    const file = baseFile();
    const tileset = file.addTileset({
      id: 0, flags: TilesetFlags.EmbeddedTiles, name: 't', tileCount: 1,
      tileWidth: 1, tileHeight: 1, baseIndex: 1,
      data: { type: 'embedded', pixels: new Uint8Array(4) }, tileUserData: [],
    });
    const layer = file.addTilemapLayer('tiles', tileset);
    file.setTilemapCel(layer, 0, [1], 1, 1);
    for (const bitDepth of [8, 16]) {
      expect(codeOf(() => AsepriteFile.read(setTilemapBits(file, bitDepth)))).toBe('DecompressionFailed');
    }
  });
  it('rejects compressed suffixes, incomplete blocks and checksum mismatches', () => {
    const data = new Uint8Array(64).fill(9);
    const valid = deflate(data, 0);
    const suffixed = new Uint8Array(valid.length + 1);
    suffixed.set(valid);
    suffixed[suffixed.length - 1] = 0xaa;
    expect(codeOf(() => inflate(suffixed, data.length))).toBe('DecompressionFailed');
    const matchingChecksumSuffix = new Uint8Array(valid.length + 4);
    matchingChecksumSuffix.set(valid);
    const checksum = adler32(data);
    new DataView(matchingChecksumSuffix.buffer).setUint32(valid.length, checksum, false);
    expect(codeOf(() => inflate(matchingChecksumSuffix, data.length))).toBe('DecompressionFailed');
    const nonFinal = valid.slice();
    nonFinal[2] = (nonFinal[2]! & 0xfe);
    expect(codeOf(() => inflate(nonFinal, data.length))).toBe('DecompressionFailed');
    const badChecksum = valid.slice();
    const last = badChecksum.length - 1;
    badChecksum[last] = (badChecksum[last]! ^ 1);
    expect(codeOf(() => inflate(badChecksum, data.length))).toBe('DecompressionFailed');
  });
  it('writes valid stored streams at exact block boundaries', () => {
    for (const size of [65535, 131070]) {
      const height = size / 65535;
      const file = new AsepriteFile(65535, height, 'indexed');
      file.setPalette([{ r: 0, g: 0, b: 0, a: 255 }]);
      const layer = file.addLayer('indexed');
      file.addFrame(100);
      const data = new Uint8Array(size).map((_, i) => i & 0xff);
      file.setCel(layer, 0, { data, width: 65535, height });
      const written = file.write({ compressionLevel: 0 });
      expect(new Uint8Array(inflateSync(compressedCelPayload(written)))).toEqual(data);
    }
  });

  it('rejects input larger than configured limits', () => {
    const file = baseFile();
    expect(codeOf(() => AsepriteFile.read(file.write(), { maxInputBytes: 1 }))).toBe('FormatLimitExceeded');
  });
});

describe('write options', () => {
  it('supports compression levels and rejects invalid ones', () => {
    const file = new AsepriteFile(64, 64, 'rgba');
    const layer = file.addLayer('L');
    file.addFrame(100);
    file.setCel(layer, 0, createPixels(new Uint8Array(64 * 64 * 4).map((_, i) => (i >> 6) & 0xff), 64, 64, 'rgba'));
    const fast = file.write({ compressionLevel: 1 });
    const small = file.write({ compressionLevel: 9 });
    const stored = file.write({ compressionLevel: 0 });
    expect(stored.length).toBeGreaterThan(fast.length);
    expect(fast.length).toBeGreaterThanOrEqual(small.length);
    for (const bytes of [fast, small, stored]) {
      const cel = AsepriteFile.read(bytes).cel(layer, 0)!;
      expect(cel.kind.type === 'compressed' && cel.kind.pixels.data.length).toBe(64 * 64 * 4);
    }
    expect(() => file.write({ compressionLevel: 12 as never })).toThrow(RangeError);
  });
});
