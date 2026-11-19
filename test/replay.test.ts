import { describe, expect, it } from 'vitest';
import { AsepriteFile, TilesetFlags, createPixels, type UserData } from '../src/index.js';

const ud = (text: string): UserData => ({ text, properties: [] });

/** A file with user data on every kind of entity that can carry it. */
function richFile(): AsepriteFile {
  const file = new AsepriteFile(2, 2, 'rgba');
  file.addTileset({
    id: 0,
    flags: TilesetFlags.EmbeddedTiles,
    name: 'ts',
    tileCount: 2,
    tileWidth: 1,
    tileHeight: 1,
    baseIndex: 1,
    data: { type: 'embedded', pixels: new Uint8Array(8) },
    userData: ud('tileset'),
    tileUserData: [ud('tile0'), ud('tile1')],
  });
  const layer = file.addLayer('L');
  file.setLayerUserData(layer, ud('layer'));
  file.addFrame(100);
  file.addFrame(100);
  file.setPalette([{ r: 0, g: 0, b: 0, a: 255 }]);
  file.setSpriteUserData(ud('sprite'));
  file.addTag('a', 0, 0);
  file.addTag('b', 1, 1);
  file.setTagUserData(0, ud('tag a'));
  file.setTagUserData(1, ud('tag b'));
  file.addSlice({ name: 's', hasNinePatch: false, hasPivot: false, keys: [{ frame: 0, x: 0, y: 0, width: 1, height: 1 }], userData: ud('slice') });
  file.setCel(layer, 0, createPixels(new Uint8Array(16), 2, 2, 'rgba'), {
    userData: ud('cel'),
    extra: { preciseX: 1, preciseY: 1, width: 1, height: 1 },
  });
  return file;
}

describe('recorded chunk order replay', () => {
  it('round-trips user data on every entity type', () => {
    const bytes = richFile().write();
    const file = AsepriteFile.read(bytes);
    expect(file.tilesets[0]!.userData?.text).toBe('tileset');
    expect(file.tilesets[0]!.tileUserData.map((u) => u?.text)).toEqual(['tile0', 'tile1']);
    expect(file.layers[0]!.userData?.text).toBe('layer');
    expect(file.spriteUserData?.text).toBe('sprite');
    expect(file.tags.map((t) => t.userData?.text)).toEqual(['tag a', 'tag b']);
    expect(file.slices[0]!.userData?.text).toBe('slice');
    expect(file.cel(0, 0)!.userData?.text).toBe('cel');
    expect(file.write()).toEqual(bytes);
  });

  it('writes empty user data where it was removed after reading', () => {
    const file = AsepriteFile.read(richFile().write());
    const layer = file.layerRef(0)!;
    delete file._layers[0]!.userData;
    delete file.cel(layer, 0)!.userData;
    delete file.cel(layer, 0)!.extra;
    delete file._tags[0]!.userData;
    delete file._tags[1]!.userData;
    delete file._slices[0]!.userData;
    file._spriteUserData = undefined;
    file._tilesets[0]!.userData = undefined;
    file._tilesets[0]!.tileUserData = [undefined, undefined];

    const out = AsepriteFile.read(file.write());
    const all = [
      out.layers[0]!.userData,
      out.cel(layer, 0)!.userData,
      ...out.tags.map((t) => t.userData),
      out.slices[0]!.userData,
      out.spriteUserData,
      out.tilesets[0]!.userData,
      ...out.tilesets[0]!.tileUserData,
    ];
    for (const u of all) expect(u?.text).toBeUndefined();
    expect(out.cel(layer, 0)!.extra).toBeUndefined();
  });

  it('drops chunks whose content was removed after reading', () => {
    const src = richFile();
    src.setColorProfile({ type: 'srgb', flags: 0, gamma: 0 });
    src.addExternalFile({ id: 1, fileType: 'palette', name: 'p' });
    const file = AsepriteFile.read(src.write());
    file._colorProfile = undefined;
    file._externalFiles = [];
    file._tags = [];
    file.removeCel(file.layerRef(0)!, 0);
    const out = AsepriteFile.read(file.write());
    expect(out.colorProfile).toBeUndefined();
    expect(out.externalFiles).toEqual([]);
    expect(out.tags).toEqual([]);
    expect([...out.cels()]).toEqual([]);
  });

  it('falls back to default order when tags, palette, profile or external files are added', () => {
    for (const edit of [
      (f: AsepriteFile) => f.addTag('t', 0, 0),
      (f: AsepriteFile) => f.setPalette([{ r: 9, g: 9, b: 9, a: 255 }]),
      (f: AsepriteFile) => f.setColorProfile({ type: 'none' }),
      (f: AsepriteFile) => f.addExternalFile({ id: 2, fileType: 'tileset', name: 'x' }),
    ]) {
      const base = new AsepriteFile(1, 1, 'rgba');
      base.addLayer('L');
      base.addFrame(100);
      const file = AsepriteFile.read(base.write());
      edit(file);
      const out = AsepriteFile.read(file.write());
      expect(out.tags.length + out.palette.length + (out.colorProfile ? 1 : 0) + out.externalFiles.length).toBe(1);
    }
  });
});

describe('edge cases', () => {
  it('treats a zero pixel ratio as 1:1', () => {
    const bytes = new AsepriteFile(1, 1, 'rgba').write();
    bytes[34] = 0;
    bytes[35] = 0;
    expect(AsepriteFile.read(bytes).pixelRatio).toEqual({ width: 1, height: 1 });
  });

  it('maps unknown enum values to defaults', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    file.addLayer('L', { blendMode: 'bogus' as never });
    file.addFrame(100);
    file.addTag('t', 0, 0, 'bogus' as never);
    file.addExternalFile({ id: 1, fileType: 'bogus' as never, name: 'x' });
    const out = AsepriteFile.read(file.write());
    expect(out.layers[0]!.blendMode).toBe('normal');
    expect(out.tags[0]!.direction).toBe('forward');
    expect(out.externalFiles[0]!.fileType).toBe('palette');
  });

  it('accepts Uint32Array tiles and writes external tilesets with missing link data', () => {
    const file = new AsepriteFile(2, 2, 'rgba');
    file.addTileset({
      id: 0, flags: TilesetFlags.ExternalLink, name: 'x', tileCount: 0, tileWidth: 1, tileHeight: 1,
      baseIndex: 1, data: { type: 'empty' }, tileUserData: [],
    });
    const layer = file.addTilemapLayer('T', 0);
    file.addFrame(100);
    file.setTilemapCel(layer, 0, new Uint32Array([1, 2, 3, 4]), 2, 2, { x: 1, y: 2, opacity: 9, zIndex: 1 });
    const out = AsepriteFile.read(file.write());
    expect(out.tilesets[0]!.data).toEqual({ type: 'external', externalFileId: 0, tilesetIdInExternal: 0 });
    const cel = out.cel(layer, 0)!;
    expect(cel.opacity).toBe(9);
    expect(cel.kind.type === 'tilemap' && [...cel.kind.tiles]).toEqual([1, 2, 3, 4]);
  });

  it('recompresses when the kept compressed bytes are corrupt', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    const layer = file.addLayer('L');
    file.addFrame(100);
    file.setCel(layer, 0, createPixels([1, 2, 3, 4], 1, 1, 'rgba'));
    const read = AsepriteFile.read(file.write());
    const kind = read.cel(layer, 0)!.kind;
    if (kind.type !== 'compressed') throw new Error('expected compressed');
    kind.originalCompressed = new Uint8Array([9, 9, 9]);
    const out = AsepriteFile.read(read.write()).cel(layer, 0)!.kind;
    expect(out.type === 'compressed' && [...out.pixels.data]).toEqual([1, 2, 3, 4]);
  });

  it('accepts plain number arrays for pixels and handles user data with no target', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    file.addFrame(100);
    file.setLayerUserData(5 as never, ud('nothing'));
    file.setCelUserData(0 as never, 0, ud('nothing'));
    file.setCelExtra(0 as never, 0, { preciseX: 0, preciseY: 0, width: 0, height: 0 });
    file.setTagUserData(3, ud('nothing'));
    expect(AsepriteFile.read(file.write()).layers).toEqual([]);
  });
});
