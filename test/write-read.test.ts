import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AsepriteError,
  AsepriteFile,
  TilesetFlags,
  createPixels,
  type Color,
  type UserData,
} from '../src/index.js';

const fixture = (name: string) =>
  AsepriteFile.read(readFileSync(join(import.meta.dirname, 'fixtures', name)));

const roundTrip = (file: AsepriteFile) => AsepriteFile.read(file.write());

function rgba(w: number, h: number, fill = 0) {
  return createPixels(new Uint8Array(w * h * 4).fill(fill), w, h, 'rgba');
}

function expectError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AsepriteError);
    expect((e as AsepriteError).code).toBe(code);
    return;
  }
  throw new Error(`expected AsepriteError ${code}`);
}

describe('write → read', () => {
  it('single layer, single frame', () => {
    const file = new AsepriteFile(4, 4, 'rgba');
    const layer = file.addLayer('Background');
    const frame = file.addFrame(100);
    file.setCel(layer, frame, rgba(4, 4, 255));

    const out = roundTrip(file);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(out.colorMode).toBe('rgba');
    expect(out.layers.map((l) => l.name)).toEqual(['Background']);
    expect(out.frames).toEqual([{ durationMs: 100 }]);
    const cel = out.cel(layer, 0)!;
    expect(cel.kind.type).toBe('compressed');
    if (cel.kind.type !== 'compressed') return;
    expect(cel.kind.x).toBe(0);
    expect(cel.kind.pixels.width).toBe(4);
    expect(cel.kind.pixels.data.length).toBe(64);
    expect(cel.kind.pixels.data.every((b) => b === 255)).toBe(true);
  });

  it('nested groups', () => {
    const file = new AsepriteFile(4, 4, 'rgba');
    file.addLayer('Background');
    const character = file.addGroup('Character');
    file.addLayer('Body', { parent: character });
    const accessories = file.addGroup('Accessories', { parent: character });
    file.addLayer('Hat', { parent: accessories });
    file.addFrame(100);

    const out = roundTrip(file);
    expect(out.layers.map((l) => [l.name, l.kind.type, l.parent])).toEqual([
      ['Background', 'normal', undefined],
      ['Character', 'group', undefined],
      ['Body', 'normal', 1],
      ['Accessories', 'group', 1],
      ['Hat', 'normal', 3],
    ]);
  });

  it('multiple frames and durations, including zero', () => {
    const file = new AsepriteFile(2, 2, 'rgba');
    file.addLayer('L');
    file.addFrame(100);
    file.addFrame(200);
    file.addFrame(0);
    expect(roundTrip(file).frames.map((f) => f.durationMs)).toEqual([100, 200, 0]);
  });

  it('linked cels and resolveCel', () => {
    const file = new AsepriteFile(4, 4, 'rgba');
    const layer = file.addLayer('Layer');
    file.addFrame(100);
    file.addFrame(100);
    file.setCel(layer, 0, rgba(4, 4, 9));
    file.setLinkedCel(layer, 1, 0, {
      x: 15,
      y: -5,
      opacity: 180,
      zIndex: 3,
      userData: { text: 'Linked Custom Text', properties: [] },
      extra: { preciseX: 10, preciseY: 20, width: 30, height: 40 },
    });

    const out = roundTrip(file);
    const linked = out.cel(layer, 1)!;
    expect(linked.kind).toEqual({ type: 'linked', sourceFrame: 0, x: 15, y: -5 });
    expect(linked.opacity).toBe(180);
    expect(linked.zIndex).toBe(3);
    expect(linked.userData?.text).toBe('Linked Custom Text');
    expect(linked.extra).toEqual({ preciseX: 10, preciseY: 20, width: 30, height: 40 });
    expect(out.resolveCel(layer, 1)).toBe(out.cel(layer, 0));
    expect(out.resolveCel(layer, 1)!.kind.type).toBe('compressed');
  });

  it('tags with directions and repeat', () => {
    const file = new AsepriteFile(2, 2, 'rgba');
    file.addLayer('L');
    file.addFrame(100);
    file.addFrame(100);
    file.addFrame(100);
    file.addTag('idle', 0, 0);
    file.addTag('walk', 1, 2, 'ping-pong', 3);

    const out = roundTrip(file);
    expect(out.tags).toEqual([
      { name: 'idle', fromFrame: 0, toFrame: 0, direction: 'forward', repeat: 0 },
      { name: 'walk', fromFrame: 1, toFrame: 2, direction: 'ping-pong', repeat: 3 },
    ]);
  });

  it('indexed mode with palette', () => {
    const file = new AsepriteFile(2, 2, 'indexed');
    const layer = file.addLayer('L');
    file.addFrame(100);
    file.setCel(layer, 0, createPixels([0, 1, 2, 1], 2, 2, 'indexed'));
    const palette: Color[] = [
      { r: 0, g: 0, b: 0, a: 0 },
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
    ];
    file.setPalette(palette);
    file.setTransparentIndex(0);

    const out = roundTrip(file);
    expect(out.colorMode).toBe('indexed');
    expect(out.transparentIndex).toBe(0);
    expect(out.palette).toEqual(palette);
    const cel = out.cel(layer, 0)!;
    if (cel.kind.type !== 'compressed') throw new Error('expected compressed');
    expect([...cel.kind.pixels.data]).toEqual([0, 1, 2, 1]);
  });

  it('palette entry names and max size', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    file.addLayer('L');
    file.addFrame(100);
    const palette: Color[] = Array.from({ length: 256 }, (_, i) => ({ r: i, g: i, b: i, a: 255 }));
    palette[1] = { r: 1, g: 2, b: 3, a: 4, name: 'Skin' };
    palette[2] = { r: 5, g: 6, b: 7, a: 8, name: '' };
    file.setPalette(palette);
    expect(roundTrip(file).palette).toEqual(palette);
  });

  it('grayscale mode', () => {
    const file = new AsepriteFile(2, 2, 'grayscale');
    const layer = file.addLayer('L');
    file.addFrame(100);
    const data = [128, 255, 64, 255, 0, 255, 200, 128];
    file.setCel(layer, 0, createPixels(data, 2, 2, 'grayscale'));
    const cel = roundTrip(file).cel(layer, 0)!;
    if (cel.kind.type !== 'compressed') throw new Error('expected compressed');
    expect([...cel.kind.pixels.data]).toEqual(data);
  });

  it('raw cels, cel options and negative offsets', () => {
    const file = new AsepriteFile(4, 4, 'rgba');
    const layer = file.addLayer('L');
    file.addFrame(100);
    file.setCel(layer, 0, rgba(2, 2, 1), { raw: true, x: -1, y: -2, opacity: 128, zIndex: 2 });
    const cel = roundTrip(file).cel(layer, 0)!;
    expect(cel.opacity).toBe(128);
    expect(cel.zIndex).toBe(2);
    expect(cel.kind.type).toBe('raw');
    if (cel.kind.type !== 'raw') return;
    expect([cel.kind.x, cel.kind.y]).toEqual([-1, -2]);
    expect(cel.kind.pixels.data.every((b) => b === 1)).toBe(true);
  });

  it('layer options', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    file.addLayer('Hidden', { visible: false, opacity: 128, blendMode: 'multiply', lockMovement: true });
    const g = file.addGroup('G', { collapsed: true, blendMode: 'divide' });
    file.addLayer('Ref', { parent: g, referenceLayer: true, background: true, preferLinkedCels: true, editable: false });
    file.addFrame(100);

    const [hidden, group, ref] = roundTrip(file).layers;
    expect(hidden).toMatchObject({ visible: false, opacity: 128, blendMode: 'multiply', lockMovement: true });
    expect(group).toMatchObject({ collapsed: true, blendMode: 'divide' });
    expect(ref).toMatchObject({
      parent: 1,
      referenceLayer: true,
      background: true,
      preferLinkedCels: true,
      editable: false,
    });
  });

  it('color profiles', () => {
    for (const profile of [
      { type: 'srgb', flags: 0, gamma: 0 },
      { type: 'icc', flags: 1, gamma: 0x10000, data: new Uint8Array([1, 2, 3]) },
      { type: 'none' },
    ] as const) {
      const file = new AsepriteFile(1, 1, 'rgba');
      file.addFrame(100);
      file.setColorProfile(profile);
      expect(roundTrip(file).colorProfile).toEqual(profile);
    }
  });

  it('empty frame has no cels', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    const layer = file.addLayer('Layer');
    file.addFrame(100);
    const out = roundTrip(file);
    expect(out.cel(layer, 0)).toBeUndefined();
    expect([...out.cels()]).toEqual([]);
  });

  it('grid, pixel ratio and header fields', () => {
    const file = new AsepriteFile(300, 200, 'rgba');
    file.addFrame(100);
    file.setGrid({ x: -3, y: 4, width: 8, height: 12 });
    file.setPixelRatio(2, 1);
    const out = roundTrip(file);
    expect([out.width, out.height]).toEqual([300, 200]);
    expect(out.grid).toEqual({ x: -3, y: 4, width: 8, height: 12 });
    expect(out.pixelRatio).toEqual({ width: 2, height: 1 });
  });
});

describe('user data', () => {
  it('on layers, groups and the sprite (text + color)', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    const layer = file.addLayer('L');
    const group = file.addGroup('G');
    file.addFrame(100);
    file.setLayerUserData(layer, { text: 'hello', properties: [] });
    file.setLayerUserData(group, { color: { r: 1, g: 2, b: 3, a: 4 }, properties: [] });
    file.setSpriteUserData({ text: 'sprite info', color: { r: 255, g: 0, b: 0, a: 255 }, properties: [] });

    const out = roundTrip(file);
    expect(out.layers[0]!.userData?.text).toBe('hello');
    expect(out.layers[1]!.userData?.color).toEqual({ r: 1, g: 2, b: 3, a: 4 });
    expect(out.spriteUserData).toEqual({
      text: 'sprite info',
      color: { r: 255, g: 0, b: 0, a: 255 },
      properties: [],
    });
  });

  it('typed properties of every kind', () => {
    const ud: UserData = {
      text: 'unicode ✓ 日本',
      properties: [
        {
          key: 0,
          entries: [
            ['name', { type: 'string', value: 'hero' }],
            ['health', { type: 'int32', value: -100 }],
            ['alive', { type: 'bool', value: true }],
            ['speed', { type: 'float', value: 3.5 }],
            ['score', { type: 'int64', value: -999999999999n }],
            ['big', { type: 'uint64', value: 0xffffffffffffffffn }],
            ['i8', { type: 'int8', value: -5 }],
            ['u8', { type: 'uint8', value: 250 }],
            ['i16', { type: 'int16', value: -30000 }],
            ['u16', { type: 'uint16', value: 60000 }],
            ['u32', { type: 'uint32', value: 0xfffffff0 }],
            ['fixed', { type: 'fixed', value: 0x18000 }],
            ['pi', { type: 'double', value: Math.PI }],
            ['origin', { type: 'point', x: 10, y: -20 }],
            ['dimensions', { type: 'size', width: 64, height: 64 }],
            ['bounds', { type: 'rect', x: 0, y: 0, width: 100, height: 200 }],
            ['list', { type: 'vector', value: [{ type: 'int32', value: 1 }, { type: 'int32', value: 2 }] }],
            ['mixed', { type: 'vector', value: [{ type: 'bool', value: false }, { type: 'string', value: 'x' }] }],
            ['empty', { type: 'vector', value: [] }],
            ['nested', { type: 'properties', value: [['inner', { type: 'uint8', value: 7 }]] }],
            ['id', { type: 'uuid', value: new Uint8Array(16).map((_, i) => i) }],
          ],
        },
        { key: 42, entries: [['ext', { type: 'string', value: 'extension data' }]] },
      ],
    };
    const file = new AsepriteFile(1, 1, 'rgba');
    const layer = file.addLayer('L');
    file.addFrame(100);
    file.setLayerUserData(layer, ud);
    expect(roundTrip(file).layers[0]!.userData).toEqual(ud);
  });

  it('on tags, preserving gaps', () => {
    const file = new AsepriteFile(2, 2, 'rgba');
    file.addLayer('L');
    file.addFrame(100);
    file.addFrame(100);
    file.addFrame(100);
    file.addTag('idle', 0, 0);
    const run = file.addTag('run', 1, 2);
    file.setTagUserData(run, { text: 'running animation', properties: [] });

    const out = roundTrip(file);
    expect(out.tags[0]!.userData?.text).toBeUndefined();
    expect(out.tags[1]!.userData?.text).toBe('running animation');
  });

  it('on cels, with cel extra', () => {
    const file = new AsepriteFile(4, 4, 'rgba');
    const layer = file.addLayer('L');
    file.addFrame(100);
    file.setCel(layer, 0, rgba(4, 4));
    file.setCelUserData(layer, 0, { text: 'cel note', properties: [] });
    file.setCelExtra(layer, 0, { preciseX: 0x10000, preciseY: 0x20000, width: 0x40000, height: 0x40000 });
    const cel = roundTrip(file).cel(layer, 0)!;
    expect(cel.userData?.text).toBe('cel note');
    expect(cel.extra).toEqual({ preciseX: 0x10000, preciseY: 0x20000, width: 0x40000, height: 0x40000 });
  });
});

describe('slices', () => {
  it('basic, nine-patch, pivot, animated and user data', () => {
    const file = new AsepriteFile(32, 32, 'rgba');
    file.addLayer('L');
    file.addFrame(100);
    file.addFrame(100);
    file.addSlice({ name: 'basic', hasNinePatch: false, hasPivot: false, keys: [{ frame: 0, x: 1, y: 2, width: 3, height: 4 }] });
    file.addSlice({
      name: 'button',
      hasNinePatch: true,
      hasPivot: true,
      keys: [
        { frame: 0, x: -4, y: 0, width: 16, height: 16, ninePatch: { centerX: 4, centerY: 4, centerWidth: 8, centerHeight: 8 }, pivot: { x: 8, y: 16 } },
        { frame: 1, x: 2, y: 2, width: 20, height: 20, ninePatch: { centerX: 5, centerY: 5, centerWidth: 10, centerHeight: 10 }, pivot: { x: 0, y: 0 } },
      ],
      userData: { text: 'clickable', properties: [] },
    });
    expect(roundTrip(file).slices).toEqual(file.slices);
  });
});

describe('tilesets and tilemaps', () => {
  it('embedded tileset with tilemap layer and cel', () => {
    const file = new AsepriteFile(4, 4, 'rgba');
    const tilePixels = new Uint8Array(2 * 2 * 4 * 3).map((_, i) => i);
    const ts = file.addTileset({
      id: 0,
      flags: TilesetFlags.EmbeddedTiles | TilesetFlags.EmptyTileIsZero,
      name: 'terrain',
      tileCount: 3,
      tileWidth: 2,
      tileHeight: 2,
      baseIndex: 1,
      data: { type: 'embedded', pixels: tilePixels },
      userData: { text: 'tileset ud', properties: [] },
      tileUserData: [undefined, { text: 'grass', properties: [] }, undefined],
    });
    const layer = file.addTilemapLayer('Tiles', ts);
    file.addFrame(100);
    file.setTilemapCel(layer, 0, [0, 1, 2 | 0x20000000, 1], 2, 2);

    const out = roundTrip(file);
    expect(out.layers[0]!.kind).toEqual({ type: 'tilemap', tilesetIndex: 0 });
    const tileset = out.tilesets[0]!;
    expect(tileset.name).toBe('terrain');
    expect(tileset.baseIndex).toBe(1);
    expect(tileset.data.type === 'embedded' && [...tileset.data.pixels]).toEqual([...tilePixels]);
    expect(tileset.userData?.text).toBe('tileset ud');
    expect(tileset.tileUserData[1]?.text).toBe('grass');
    expect(tileset.tileUserData[0]?.text).toBeUndefined();
    const cel = out.cel(layer, 0)!;
    if (cel.kind.type !== 'tilemap') throw new Error('expected tilemap');
    expect([...cel.kind.tiles]).toEqual([0, 1, 2 | 0x20000000, 1]);
    expect(cel.kind.tileIdBitmask).toBe(0x1fffffff);
  });

  it('external tileset and external files', () => {
    const file = new AsepriteFile(4, 4, 'rgba');
    file.addExternalFile({ id: 7, fileType: 'tileset', name: 'shared.aseprite' });
    file.addExternalFile({ id: 8, fileType: 'extension-properties', name: 'my-ext' });
    file.addTileset({
      id: 0,
      flags: TilesetFlags.ExternalLink,
      name: 'ext',
      tileCount: 0,
      tileWidth: 8,
      tileHeight: 8,
      baseIndex: 1,
      data: { type: 'external', externalFileId: 7, tilesetIdInExternal: 3 },
      tileUserData: [],
    });
    file.addFrame(100);
    const out = roundTrip(file);
    expect(out.externalFiles).toEqual(file.externalFiles);
    expect(out.tilesets[0]!.data).toEqual({ type: 'external', externalFileId: 7, tilesetIdInExternal: 3 });
  });
});

describe('fixtures', () => {
  it('tags3', () => {
    const file = fixture('tags3.aseprite');
    expect(file.tags.length).toBe(3);
    expect(file.tags.every((t) => t.name.length > 0)).toBe(true);
  });

  it('groups3abc', () => {
    const file = fixture('groups3abc.aseprite');
    expect(file.layers.length).toBeGreaterThanOrEqual(3);
    expect(file.layers.some((l) => l.kind.type === 'group')).toBe(true);
  });

  it('slices', () => {
    const file = fixture('slices.aseprite');
    expect(file.slices.length).toBeGreaterThan(0);
    expect(file.slices[0]!.name).not.toBe('');
    expect(file.slices[0]!.keys.length).toBeGreaterThan(0);
  });

  it('2x2tilemap2x2tile', () => {
    const file = fixture('2x2tilemap2x2tile.aseprite');
    expect(file.tilesets.length).toBeGreaterThan(0);
    expect(file.layers.some((l) => l.kind.type === 'tilemap')).toBe(true);
  });

  it('file-tests-props has typed properties', () => {
    const file = fixture('file-tests-props.aseprite');
    const all = [
      file.spriteUserData,
      ...file.layers.map((l) => l.userData),
      ...[...file.cels()].map((c) => c.cel.userData),
      ...file.tags.map((t) => t.userData),
      ...file.tilesets.map((t) => t.userData),
    ];
    expect(all.some((ud) => (ud?.properties.length ?? 0) > 0)).toBe(true);
  });

  it('link has linked cels that resolve', () => {
    const file = fixture('link.aseprite');
    const linked = [...file.cels()].filter((c) => c.cel.kind.type === 'linked');
    expect(linked.length).toBeGreaterThan(0);
    for (const { layer, frame } of linked) expect(file.resolveCel(layer, frame)).toBeDefined();
  });

  it('saves edited indexed palettes while replaying unchanged fixtures byte-for-byte', () => {
    const bytes = readFileSync(join(import.meta.dirname, 'fixtures', '4f-index-4x4.aseprite'));
    const file = AsepriteFile.read(bytes);
    expect([...file.write()]).toEqual([...bytes]);

    const originalPalette = file.palette;
    const palette = originalPalette.map((color) => ({ ...color }));
    palette[2] = { r: 17, g: 83, b: 201, a: 255 };
    file.setPalette(palette);

    const reopened = AsepriteFile.read(file.write());
    expect(reopened.palette[2]).toEqual(palette[2]);
    expect(reopened.palette.filter((_, i) => i !== 2)).toEqual(
      originalPalette.filter((_, i) => i !== 2),
    );
    expect(reopened.colorProfile).toEqual(file.colorProfile);
    expect(reopened.frames).toEqual(file.frames);
    expect([...reopened.cels()].map(({ layer, frame }) => [layer, frame])).toEqual(
      [...file.cels()].map(({ layer, frame }) => [layer, frame]),
    );
  });
});

describe('handles', () => {
  it('layerRef / groupRef discriminate by kind', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    const layer = file.addLayer('L');
    const group = file.addGroup('G');
    expect(file.layerRef(0)).toBe(layer);
    expect(file.layerRef(1)).toBeUndefined();
    expect(file.groupRef(1)).toBe(group);
    expect(file.groupRef(0)).toBeUndefined();
    expect(file.layerRef(99)).toBeUndefined();
  });

  it('removeCel', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    const layer = file.addLayer('L');
    file.addFrame(100);
    file.setCel(layer, 0, rgba(1, 1));
    expect(file.removeCel(layer, 0)).toBe(true);
    expect(file.cel(layer, 0)).toBeUndefined();
  });
});

describe('errors', () => {
  it('rejects bad magic', () => {
    const bytes = new Uint8Array(128);
    expectError(() => AsepriteFile.read(bytes), 'InvalidMagic');
  });

  it('rejects truncated input', () => {
    const full = fixture('abcd.aseprite').write();
    expectError(() => AsepriteFile.read(full.subarray(0, 10)), 'UnexpectedEof');
    expectError(() => AsepriteFile.read(full.subarray(0, full.length - 10)), 'UnexpectedEof');
  });

  it('rejects unsupported color depth', () => {
    const bytes = fixture('abcd.aseprite').write();
    bytes[12] = 24;
    expectError(() => AsepriteFile.read(bytes), 'UnsupportedColorDepth');
  });

  it('createPixels validates size', () => {
    expectError(() => createPixels(new Uint8Array(3), 1, 1, 'rgba'), 'PixelSizeMismatch');
  });

  it('frame out of bounds', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    const layer = file.addLayer('L');
    expectError(() => file.setCel(layer, 0, rgba(1, 1)), 'FrameOutOfBounds');
    file.addFrame(100);
    expectError(() => file.setLinkedCel(layer, 0, 5), 'FrameOutOfBounds');
  });

  it('pixel size must match the file color mode', () => {
    const file = new AsepriteFile(1, 1, 'indexed');
    const layer = file.addLayer('L');
    file.addFrame(100);
    expectError(() => file.setCel(layer, 0, rgba(1, 1)), 'PixelSizeMismatch');
  });

  it('palette too large', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    const colors = Array.from({ length: 257 }, () => ({ r: 0, g: 0, b: 0, a: 255 }));
    expectError(() => file.setPalette(colors), 'FormatLimitExceeded');
  });

  it('invalid tag range', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    file.addFrame(100);
    expectError(() => file.addTag('t', 0, 5), 'InvalidFrameRange');
    expectError(() => file.addTag('t', 1, 0), 'InvalidFrameRange');
  });

  it('indexed files need a palette to be written', () => {
    const file = new AsepriteFile(1, 1, 'indexed');
    file.addFrame(100);
    expectError(() => file.write(), 'MissingPalette');
  });

  it('is an Error with a readable message', () => {
    const err = new AsepriteError('InvalidMagic', 'invalid magic number');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AsepriteError');
    expect(String(err)).toContain('invalid magic number');
  });
});
