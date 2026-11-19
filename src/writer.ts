import { ByteWriter } from './binary.js';
import { AsepriteError } from './errors.js';
import type { AsepriteFile } from './file.js';
import { computeChildLevel } from './reader.js';
import {
  BLEND_MODES,
  EXTERNAL_FILE_TYPES,
  LOOP_DIRECTIONS,
  TilesetFlags,
  colorModeToDepth,
  isNonEmptyUserData,
  type Cel,
  type CelExtra,
  type ChunkOrderEntry,
  type UnknownChunk,
  type Color,
  type ColorProfile,
  type ExternalFile,
  type Layer,
  type PropertiesMap,
  type PropertyEntries,
  type PropertyValue,
  type Slice,
  type Tag,
  type Tileset,
  type UserData,
} from './types.js';
import { reuseOrDeflate, type CompressionLevel } from './zlib.js';

const EMPTY_USER_DATA: UserData = { properties: [] };

type Chunk = { type: number; data: Uint8Array };

type LastEntity =
  | { kind: 'none' }
  | { kind: 'layer'; index: number }
  | { kind: 'cel'; layer: number; frame: number }
  | { kind: 'tags'; next: number }
  | { kind: 'palette' }
  | { kind: 'slice'; index: number }
  | { kind: 'tileset'; index: number }
  | { kind: 'tiles'; tileset: number; next: number };

function limit(field: string, value: number, max: number): void {
  if (value > max) {
    throw new AsepriteError('FormatLimitExceeded', `format limit exceeded for ${field}: ${value} > ${max}`);
  }
}

/** Options for {@link AsepriteFile.write}. */
export interface WriteOptions {
  /**
   * zlib level (0–9) for pixel, tilemap and tileset data that has to be
   * compressed. Default 6, like Aseprite. Lower is faster but larger; data
   * read from a file and left unchanged is always reused as-is.
   */
  compressionLevel?: CompressionLevel;
}

export function writeAseprite(file: AsepriteFile, options: WriteOptions = {}): Uint8Array {
  const level = options.compressionLevel ?? 6;
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new RangeError(`compressionLevel must be an integer from 0 to 9, got ${level}`);
  }
  limit('frames', file._frames.length, 0xffff);
  limit('layers', file._layers.length, 0xffff);
  limit('width', file._width, 0xffff);
  limit('height', file._height, 0xffff);
  limit('palette', file._palette.length, 256);
  if (file._colorMode === 'indexed' && file._palette.length === 0) {
    throw new AsepriteError('MissingPalette', 'indexed color mode requires a palette');
  }

  const ctx = buildContext(file, canReplayChunkOrder(file), level);
  const out = new ByteWriter(64 * 1024);

  out.dword(0); // file size, patched below
  out.word(0xa5e0);
  out.word(file._frames.length);
  out.word(file._width);
  out.word(file._height);
  out.word(colorModeToDepth(file._colorMode));
  out.dword(file._flags);
  out.word(file._deprecatedSpeed);
  out.dword(0);
  out.dword(0);
  out.byte(file._transparentIndex);
  out.zeros(3);
  out.word(file._numColors);
  out.byte(file._pixelRatio.width);
  out.byte(file._pixelRatio.height);
  out.short(file._grid.x);
  out.short(file._grid.y);
  out.word(file._grid.width);
  out.word(file._grid.height);
  out.zeros(84);

  for (let frameIndex = 0; frameIndex < file._frames.length; frameIndex++) {
    const order = ctx.orderByFrame.get(frameIndex);
    const chunks = order
      ? replayFrameChunks(file, ctx, frameIndex, order)
      : defaultFrameChunks(file, ctx, frameIndex);

    // Frame header, then chunks written straight into the output buffer.
    const frameStart = out.length;
    out.dword(0); // frame size, patched below
    out.word(0xf1fa);
    out.word(chunks.length > 0xfffe ? 0xffff : chunks.length);
    out.word(file._frames[frameIndex]!.durationMs);
    out.zeros(2);
    out.dword(chunks.length);
    for (const chunk of chunks) out.dword(chunk.data.length + 6).word(chunk.type).bytes(chunk.data);
    out.patchDword(frameStart, out.length - frameStart);
  }

  out.patchDword(0, out.length);
  return out.finish();
}

/** Per-frame lookups, built once per write so the cost stays linear in file size. */
interface WriteContext {
  level: CompressionLevel;
  celsByFrame: Map<number, Array<[number, Cel]>>;
  orderByFrame: Map<number, ChunkOrderEntry[]>;
  unknownByFrame: Map<number, UnknownChunk[]>;
}

function groupBy<T>(items: Iterable<T>, key: (item: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function buildContext(file: AsepriteFile, replay: boolean, level: CompressionLevel): WriteContext {
  const celsByFrame = new Map<number, Array<[number, Cel]>>();
  // file.cels() yields in (layer, frame) order, so each frame's list is sorted by layer.
  for (const { layer, frame, cel } of file.cels()) {
    const list = celsByFrame.get(frame);
    if (list) list.push([layer, cel]);
    else celsByFrame.set(frame, [[layer, cel]]);
  }
  return {
    level,
    celsByFrame,
    orderByFrame: replay ? groupBy(file._chunkOrder, (e) => e.frameIndex) : new Map(),
    unknownByFrame: groupBy(file._unknownChunks, (u) => u.frameIndex),
  };
}

/**
 * The recorded chunk order of a file that was read can only be replayed when
 * the document's structure still matches it. Otherwise (e.g. layers, slices or
 * tilesets were added) the canonical order is used so nothing gets dropped.
 */
function canReplayChunkOrder(file: AsepriteFile): boolean {
  const order = file._chunkOrder;
  if (order.length === 0) return false;
  const count = (type: number) => order.reduce((n, e) => n + (e.chunkType === type ? 1 : 0), 0);
  const has = (...types: number[]) => order.some((e) => types.includes(e.chunkType));
  return (
    count(0x2004) === file._layers.length &&
    count(0x2023) === file._tilesets.length &&
    count(0x2022) === file._slices.length &&
    (file._tags.length === 0 || has(0x2018)) &&
    (file._palette.length === 0 || has(0x2019, 0x0004, 0x0011)) &&
    (file._colorProfile === undefined || has(0x2007)) &&
    (file._externalFiles.length === 0 || has(0x2008))
  );
}

function defaultFrameChunks(file: AsepriteFile, ctx: WriteContext, frameIndex: number): Chunk[] {
  const chunks: Chunk[] = [];
  const push = (type: number, data: Uint8Array) => chunks.push({ type, data });
  const pushUserData = (ud: UserData | undefined) => {
    if (ud) push(0x2020, encodeUserData(ud));
  };

  if (frameIndex === 0) {
    if (file._externalFiles.length > 0) push(0x2008, encodeExternalFiles(file._externalFiles));
    for (const tileset of file._tilesets) {
      push(0x2023, encodeTileset(tileset, ctx.level));
      const hasTileUserData = tileset.tileUserData.some((ud) => ud !== undefined);
      if (tileset.userData || hasTileUserData) {
        push(0x2020, encodeUserData(tileset.userData ?? EMPTY_USER_DATA));
      }
      if (hasTileUserData) {
        for (let i = 0; i < tileset.tileCount; i++) {
          push(0x2020, encodeUserData(tileset.tileUserData[i] ?? EMPTY_USER_DATA));
        }
      }
    }
    for (let layerIndex = 0; layerIndex < file._layers.length; layerIndex++) {
      const layer = file._layers[layerIndex]!;
      push(0x2004, encodeLayer(file._layers, layerIndex));
      pushUserData(layer.userData);
    }
    if (file._colorProfile) push(0x2007, encodeColorProfile(file._colorProfile));
    if (file._palette.length > 0) {
      push(0x2019, encodePalette(file._palette));
      pushUserData(file._spriteUserData);
    } else if (isNonEmptyUserData(file._spriteUserData)) {
      // Sprite user data must follow a palette chunk; emit a minimal one.
      push(0x2019, encodePalette([{ r: 0, g: 0, b: 0, a: 255 }]));
      pushUserData(file._spriteUserData);
    }
    if (file._tags.length > 0) {
      push(0x2018, encodeTags(file._tags));
      // One user data chunk per tag, in order, if any tag has user data.
      if (file._tags.some((t) => isNonEmptyUserData(t.userData))) {
        for (const tag of file._tags) push(0x2020, encodeUserData(tag.userData ?? EMPTY_USER_DATA));
      }
    }
    for (const slice of file._slices) {
      push(0x2022, encodeSlice(slice));
      pushUserData(slice.userData);
    }
  }
  for (const [layer, cel] of ctx.celsByFrame.get(frameIndex) ?? []) {
    push(0x2005, encodeCel(cel, layer, ctx.level));
    if (cel.extra) push(0x2006, encodeCelExtra(cel.extra));
    pushUserData(cel.userData);
  }
  for (const uc of ctx.unknownByFrame.get(frameIndex) ?? []) push(uc.chunkType, uc.data);
  return chunks;
}

function resolveUserData(
  file: AsepriteFile,
  last: LastEntity,
  setLast: (next: LastEntity) => void,
): UserData {
  switch (last.kind) {
    case 'layer':
      return file._layers[last.index]?.userData ?? EMPTY_USER_DATA;
    case 'cel':
      return file.cel(last.layer, last.frame)?.userData ?? EMPTY_USER_DATA;
    case 'tags':
      setLast({ kind: 'tags', next: last.next + 1 });
      return file._tags[last.next]?.userData ?? EMPTY_USER_DATA;
    case 'palette':
      return file._spriteUserData ?? EMPTY_USER_DATA;
    case 'slice':
      return file._slices[last.index]?.userData ?? EMPTY_USER_DATA;
    case 'tileset':
      setLast({ kind: 'tiles', tileset: last.index, next: 0 });
      return file._tilesets[last.index]?.userData ?? EMPTY_USER_DATA;
    case 'tiles':
      setLast({ kind: 'tiles', tileset: last.tileset, next: last.next + 1 });
      return file._tilesets[last.tileset]?.tileUserData[last.next] ?? EMPTY_USER_DATA;
    case 'none':
      return EMPTY_USER_DATA;
  }
}

/** Re-emits chunks in the order they were read, for byte-perfect round trips. */
function replayFrameChunks(
  file: AsepriteFile,
  ctx: WriteContext,
  frameIndex: number,
  order: ChunkOrderEntry[],
): Chunk[] {
  const chunks: Chunk[] = [];
  const push = (type: number, data: Uint8Array) => chunks.push({ type, data });
  const unknown = ctx.unknownByFrame.get(frameIndex) ?? [];
  const emittedCels = new Set<number>();
  let layerCounter = 0;
  let sliceCounter = 0;
  let tilesetCounter = 0;
  let unknownCounter = 0;
  let last: LastEntity = { kind: 'none' };
  const setLast = (next: LastEntity) => (last = next);

  // Emits user data that was added after reading (no recorded 0x2020 follows).
  const injectUserData = (i: number, ud: UserData | undefined) => {
    if (isNonEmptyUserData(ud) && order[i + 1]?.chunkType !== 0x2020) push(0x2020, encodeUserData(ud));
  };

  for (let i = 0; i < order.length; i++) {
    const entry = order[i]!;
    switch (entry.chunkType) {
      case 0x2004: {
        const layer = file._layers[layerCounter];
        if (layer) {
          push(0x2004, encodeLayer(file._layers, layerCounter));
          last = { kind: 'layer', index: layerCounter++ };
          injectUserData(i, layer.userData);
        }
        break;
      }
      case 0x2005: {
        const li = entry.layerIndex;
        const cel = li === undefined ? undefined : file.cel(li, frameIndex);
        if (li !== undefined && cel) {
          push(0x2005, encodeCel(cel, li, ctx.level));
          emittedCels.add(li);
          last = { kind: 'cel', layer: li, frame: frameIndex };
          if (order[i + 1]?.chunkType !== 0x2006) {
            if (cel.extra) push(0x2006, encodeCelExtra(cel.extra));
            injectUserData(i, cel.userData);
          }
        }
        break;
      }
      case 0x2006: {
        if (last.kind === 'cel') {
          const cel = file.cel(last.layer, last.frame);
          if (cel?.extra) push(0x2006, encodeCelExtra(cel.extra));
          injectUserData(i, cel?.userData);
        }
        break;
      }
      case 0x2007:
        if (file._colorProfile) push(0x2007, encodeColorProfile(file._colorProfile));
        break;
      case 0x2008:
        if (file._externalFiles.length > 0) push(0x2008, encodeExternalFiles(file._externalFiles));
        break;
      case 0x2018:
        if (file._tags.length > 0) {
          push(0x2018, encodeTags(file._tags));
          last = { kind: 'tags', next: 0 };
        }
        break;
      case 0x2019:
        if (file._palette.length > 0) {
          push(0x2019, encodePalette(file._palette));
          if (frameIndex === 0) {
            last = { kind: 'palette' };
            injectUserData(i, file._spriteUserData);
          }
        }
        break;
      case 0x2020:
        push(0x2020, encodeUserData(resolveUserData(file, last, setLast)));
        break;
      case 0x2022: {
        const slice = file._slices[sliceCounter];
        if (slice) {
          push(0x2022, encodeSlice(slice));
          last = { kind: 'slice', index: sliceCounter++ };
          injectUserData(i, slice.userData);
        }
        break;
      }
      case 0x2023: {
        const tileset = file._tilesets[tilesetCounter];
        if (tileset) {
          push(0x2023, encodeTileset(tileset, ctx.level));
          last = { kind: 'tileset', index: tilesetCounter++ };
        }
        break;
      }
      default: {
        const uc = unknown[unknownCounter];
        if (uc) {
          push(uc.chunkType, uc.data);
          unknownCounter++;
        }
        if ((entry.chunkType === 0x0004 || entry.chunkType === 0x0011) && frameIndex === 0) {
          last = { kind: 'palette' };
        }
        break;
      }
    }
  }

  // Cels added after reading are appended at the end of their frame.
  for (const [layer, cel] of ctx.celsByFrame.get(frameIndex) ?? []) {
    if (emittedCels.has(layer)) continue;
    push(0x2005, encodeCel(cel, layer, ctx.level));
    if (cel.extra) push(0x2006, encodeCelExtra(cel.extra));
    if (cel.userData) push(0x2020, encodeUserData(cel.userData));
  }
  // Old palette chunks are replayed verbatim; append a modern palette override
  // so a changed palette takes precedence when the file is read again.
  if (frameIndex === 0 && file._paletteChanged) {
    push(0x2019, encodePalette(file._palette));
  }
  return chunks;
}

// --- Chunk encoders ---

function encodeLayer(layers: readonly Layer[], index: number): Uint8Array {
  const layer = layers[index]!;
  const w = new ByteWriter(64);
  let flags = 0;
  if (layer.visible) flags |= 1;
  if (layer.editable) flags |= 2;
  if (layer.lockMovement) flags |= 4;
  if (layer.background) flags |= 8;
  if (layer.preferLinkedCels) flags |= 16;
  if (layer.collapsed) flags |= 32;
  if (layer.referenceLayer) flags |= 64;
  w.word(flags);
  w.word(layer.kind.type === 'normal' ? 0 : layer.kind.type === 'group' ? 1 : 2);
  w.word(computeChildLevel(layers, index));
  w.word(0); // default width
  w.word(0); // default height
  w.word(Math.max(0, BLEND_MODES.indexOf(layer.blendMode)));
  w.byte(layer.opacity);
  w.zeros(3);
  w.string(layer.name);
  if (layer.kind.type === 'tilemap') w.dword(layer.kind.tilesetIndex);
  return w.finish();
}

function encodeCel(cel: Cel, layerIndex: number, level: CompressionLevel): Uint8Array {
  const k = cel.kind;
  const w = new ByteWriter(64);
  w.word(layerIndex);
  w.short(k.x);
  w.short(k.y);
  w.byte(cel.opacity);
  w.word(k.type === 'raw' ? 0 : k.type === 'linked' ? 1 : k.type === 'compressed' ? 2 : 3);
  w.short(cel.zIndex);
  w.zeros(5);
  switch (k.type) {
    case 'raw':
      w.word(k.pixels.width).word(k.pixels.height).bytes(k.pixels.data);
      break;
    case 'compressed':
      w.word(k.pixels.width).word(k.pixels.height);
      w.bytes(reuseOrDeflate(k.pixels.data, k.originalCompressed, level));
      break;
    case 'linked':
      w.word(k.sourceFrame);
      break;
    case 'tilemap': {
      if (k.bitsPerTile !== 32) {
        throw new AsepriteError('UnsupportedTileBitDepth', `unsupported tile bit depth ${k.bitsPerTile}; only 32-bit tiles are supported`);
      }
      w.word(k.width).word(k.height).word(k.bitsPerTile);
      w.dword(k.tileIdBitmask).dword(k.xFlipBitmask).dword(k.yFlipBitmask).dword(k.dFlipBitmask);
      w.zeros(10);
      const tileBytes = new ByteWriter(k.tiles.length * 4);
      for (const t of k.tiles) tileBytes.dword(t);
      w.bytes(reuseOrDeflate(tileBytes.finish(), k.originalCompressed, level));
      break;
    }
  }
  return w.finish();
}

function encodeColorProfile(profile: ColorProfile): Uint8Array {
  const w = new ByteWriter(32);
  switch (profile.type) {
    case 'none':
      w.word(0).word(0).dword(0).zeros(8);
      break;
    case 'srgb':
      w.word(1).word(profile.flags).dword(profile.gamma).zeros(8);
      break;
    case 'icc':
      w.word(2).word(profile.flags).dword(profile.gamma).zeros(8);
      w.dword(profile.data.length).bytes(profile.data);
      break;
  }
  return w.finish();
}

function encodePalette(palette: readonly Color[]): Uint8Array {
  const w = new ByteWriter(20 + palette.length * 6);
  w.dword(palette.length).dword(0).dword(palette.length - 1).zeros(8);
  for (const c of palette) {
    w.word(c.name !== undefined ? 1 : 0).byte(c.r).byte(c.g).byte(c.b).byte(c.a);
    if (c.name !== undefined) w.string(c.name);
  }
  return w.finish();
}

function encodeSlice(slice: Slice): Uint8Array {
  const w = new ByteWriter(64);
  w.dword(slice.keys.length);
  w.dword((slice.hasNinePatch ? 1 : 0) | (slice.hasPivot ? 2 : 0));
  w.dword(0);
  w.string(slice.name);
  for (const key of slice.keys) {
    w.dword(key.frame).long(key.x).long(key.y).dword(key.width).dword(key.height);
    if (slice.hasNinePatch) {
      const np = key.ninePatch ?? { centerX: 0, centerY: 0, centerWidth: 0, centerHeight: 0 };
      w.long(np.centerX).long(np.centerY).dword(np.centerWidth).dword(np.centerHeight);
    }
    if (slice.hasPivot) {
      const pivot = key.pivot ?? { x: 0, y: 0 };
      w.long(pivot.x).long(pivot.y);
    }
  }
  return w.finish();
}

function encodeExternalFiles(files: readonly ExternalFile[]): Uint8Array {
  const w = new ByteWriter(64);
  w.dword(files.length).zeros(8);
  for (const ef of files) {
    w.dword(ef.id).byte(Math.max(0, EXTERNAL_FILE_TYPES.indexOf(ef.fileType))).zeros(7);
    w.string(ef.name);
  }
  return w.finish();
}

function encodeTileset(tileset: Tileset, level: CompressionLevel): Uint8Array {
  const w = new ByteWriter(64);
  w.dword(tileset.id).dword(tileset.flags).dword(tileset.tileCount);
  w.word(tileset.tileWidth).word(tileset.tileHeight).short(tileset.baseIndex);
  w.zeros(14);
  w.string(tileset.name);
  const data = tileset.data;
  if (tileset.flags & TilesetFlags.ExternalLink) {
    const ext = data.type === 'external' ? data : { externalFileId: 0, tilesetIdInExternal: 0 };
    w.dword(ext.externalFileId).dword(ext.tilesetIdInExternal);
  }
  if (tileset.flags & TilesetFlags.EmbeddedTiles) {
    const compressed =
      data.type === 'embedded'
        ? reuseOrDeflate(data.pixels, data.originalCompressed, level)
        : reuseOrDeflate(new Uint8Array(0), undefined, level);
    w.dword(compressed.length).bytes(compressed);
  }
  return w.finish();
}

function encodeCelExtra(extra: CelExtra): Uint8Array {
  const w = new ByteWriter(36);
  w.dword(1); // flags: precise bounds are set
  w.dword(extra.preciseX).dword(extra.preciseY).dword(extra.width).dword(extra.height);
  w.zeros(16);
  return w.finish();
}

function encodeTags(tags: readonly Tag[]): Uint8Array {
  const w = new ByteWriter(64);
  w.word(tags.length).zeros(8);
  for (const tag of tags) {
    w.word(tag.fromFrame).word(tag.toFrame);
    w.byte(Math.max(0, LOOP_DIRECTIONS.indexOf(tag.direction)));
    w.word(tag.repeat);
    w.zeros(6); // reserved
    w.zeros(3); // deprecated tag color (RGB)
    w.byte(0); // extra byte
    w.string(tag.name);
  }
  return w.finish();
}

function encodeUserData(ud: UserData): Uint8Array {
  const w = new ByteWriter(64);
  const hasProps = ud.properties.length > 0;
  w.dword((ud.text !== undefined ? 1 : 0) | (ud.color ? 2 : 0) | (hasProps ? 4 : 0));
  if (ud.text !== undefined) w.string(ud.text);
  if (ud.color) w.byte(ud.color.r).byte(ud.color.g).byte(ud.color.b).byte(ud.color.a);
  if (hasProps) {
    const props = new ByteWriter(64);
    props.dword(ud.properties.length);
    for (const map of ud.properties) encodePropertiesMap(props, map);
    const propBytes = props.finish();
    // The size includes its own DWORD.
    w.dword(4 + propBytes.length).bytes(propBytes);
  }
  return w.finish();
}

function encodePropertiesMap(w: ByteWriter, map: PropertiesMap): void {
  w.dword(map.key);
  encodePropertyEntries(w, map.entries);
}

function encodePropertyEntries(w: ByteWriter, entries: PropertyEntries): void {
  w.dword(entries.length);
  for (const [name, value] of entries) {
    w.string(name);
    w.word(propertyTypeId(value));
    encodePropertyValue(w, value);
  }
}

const PROPERTY_TYPE_IDS: Record<PropertyValue['type'], number> = {
  bool: 0x01,
  int8: 0x02,
  uint8: 0x03,
  int16: 0x04,
  uint16: 0x05,
  int32: 0x06,
  uint32: 0x07,
  int64: 0x08,
  uint64: 0x09,
  fixed: 0x0a,
  float: 0x0b,
  double: 0x0c,
  string: 0x0d,
  point: 0x0e,
  size: 0x0f,
  rect: 0x10,
  vector: 0x11,
  properties: 0x12,
  uuid: 0x13,
};

function propertyTypeId(value: PropertyValue): number {
  return PROPERTY_TYPE_IDS[value.type];
}

function encodePropertyValue(w: ByteWriter, v: PropertyValue): void {
  switch (v.type) {
    case 'bool':
      w.byte(v.value ? 1 : 0);
      break;
    case 'int8':
      w.int8(v.value);
      break;
    case 'uint8':
      w.byte(v.value);
      break;
    case 'int16':
      w.short(v.value);
      break;
    case 'uint16':
      w.word(v.value);
      break;
    case 'int32':
      w.long(v.value);
      break;
    case 'uint32':
    case 'fixed':
      w.dword(v.value);
      break;
    case 'int64':
      w.long64(v.value);
      break;
    case 'uint64':
      w.qword(v.value);
      break;
    case 'float':
      w.float(v.value);
      break;
    case 'double':
      w.double(v.value);
      break;
    case 'string':
      w.string(v.value);
      break;
    case 'point':
      w.long(v.x).long(v.y);
      break;
    case 'size':
      w.long(v.width).long(v.height);
      break;
    case 'rect':
      w.long(v.x).long(v.y).long(v.width).long(v.height);
      break;
    case 'vector': {
      w.dword(v.value.length);
      const first = v.value[0];
      const homogeneous = first !== undefined && v.value.every((e) => e.type === first.type);
      if (homogeneous) {
        w.word(propertyTypeId(first));
        for (const e of v.value) encodePropertyValue(w, e);
      } else {
        w.word(0);
        for (const e of v.value) {
          w.word(propertyTypeId(e));
          encodePropertyValue(w, e);
        }
      }
      break;
    }
    case 'properties':
      encodePropertyEntries(w, v.value);
      break;
    case 'uuid':
      if (v.value.length !== 16) {
        throw new AsepriteError('FormatLimitExceeded', `UUID must be 16 bytes, got ${v.value.length}`);
      }
      w.bytes(v.value);
      break;
  }
}
