
import { ByteReader } from './binary.js';
import { AsepriteError } from './errors.js';
import { AsepriteFile } from './file.js';
import {
  BLEND_MODES,
  EXTERNAL_FILE_TYPES,
  LOOP_DIRECTIONS,
  TilesetFlags,
  bytesPerPixel,
  colorModeFromDepth,
  type CelExtra,
  type CelKind,
  type ColorMode,
  type ColorProfile,
  type Layer,
  type LayerKind,
  type PropertiesMap,
  type PropertyEntries,
  type PropertyValue,
  type SliceKey,
  type TilesetData,
  type UserData,
} from './types.js';
import { inflate, type ReadLimits } from './zlib.js';

/** Which entity a following User Data chunk (0x2020) attaches to. */
type LastEntity =
  | { kind: 'none' }
  | { kind: 'layer'; index: number }
  | { kind: 'cel'; layer: number; frame: number }
  | { kind: 'tags'; next: number }
  | { kind: 'palette' }
  | { kind: 'slice'; index: number }
  | { kind: 'tileset'; index: number }
  | { kind: 'tiles'; tileset: number; next: number };

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxInputBytes: 128 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024,
  maxTotalDecodedBytes: 256 * 1024 * 1024,
  maxDimension: 16384,
};

function checkDecodedSize(size: number, limits: ReadLimits, budget: { total: number }): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxDecodedBytes ||
      size > limits.maxTotalDecodedBytes - budget.total) {
    throw new AsepriteError('FormatLimitExceeded', 'decoded data exceeds configured read limits');
  }
  budget.total += size;
}

function checkDimensions(width: number, height: number, limits: ReadLimits): void {
  if (width > limits.maxDimension || height > limits.maxDimension) {
    throw new AsepriteError('FormatLimitExceeded', 'cel dimensions exceed configured read limits');
  }
}

export function readAseprite(bytes: Uint8Array, limits: ReadLimits = DEFAULT_READ_LIMITS): AsepriteFile {
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 0)) {
    throw new AsepriteError('FormatLimitExceeded', 'read limits must be non-negative safe integers');
  }
  if (bytes.length > limits.maxInputBytes) {
    throw new AsepriteError('FormatLimitExceeded', 'input exceeds configured read limit');
  }
  const budget = { total: 0 };
  const r = new ByteReader(bytes);

  // Header (128 bytes)
  r.dword(); // file size
  const magic = r.word();
  if (magic !== 0xa5e0) {
    throw new AsepriteError(
      'InvalidMagic',
      `invalid magic number 0x${magic.toString(16).toUpperCase()} (expected 0xA5E0)`,
    );
  }
  const numFrames = r.word();
  const width = r.word();
  const height = r.word();
  const colorMode = colorModeFromDepth(r.word());
  checkDimensions(width, height, limits);
  checkDecodedSize(width * height * bytesPerPixel(colorMode), limits, { total: 0 });
  const flags = r.dword();
  const deprecatedSpeed = r.word();
  r.skip(8);
  const transparentIndex = r.byte();
  r.skip(3);
  const numColors = r.word();
  const pixelWidth = r.byte();
  const pixelHeight = r.byte();
  const gridX = r.short();
  const gridY = r.short();
  const gridW = r.word();
  const gridH = r.word();
  r.skip(84);

  const file = new AsepriteFile(width, height, colorMode);
  file._flags = flags;
  file._deprecatedSpeed = deprecatedSpeed;
  file._numColors = numColors;
  file._transparentIndex = transparentIndex;
  file._pixelRatio = { width: pixelWidth || 1, height: pixelHeight || 1 };
  file._grid = { x: gridX, y: gridY, width: gridW, height: gridH };

  let last: LastEntity = { kind: 'none' };

  for (let frameIndex = 0; frameIndex < numFrames; frameIndex++) {
    const frameStart = r.pos;
    const frameBytes = r.dword();
    const frameMagic = r.word();
    if (frameMagic !== 0xf1fa) {
      throw new AsepriteError(
        'InvalidMagic',
        `invalid frame magic number 0x${frameMagic.toString(16).toUpperCase()} in frame ${frameIndex} (expected 0xF1FA)`,
      );
    }
    const oldNumChunks = r.word();
    const duration = r.word();
    r.skip(2);
    const newNumChunks = r.dword();
    file.addFrame(duration);

    const numChunks = newNumChunks !== 0 ? newNumChunks : oldNumChunks;

    for (let c = 0; c < numChunks; c++) {
      const chunkSize = r.dword();
      const chunkType = r.word();
      if (chunkSize < 6) {
        throw new AsepriteError(
          'InvalidChunkSize',
          `invalid chunk size ${chunkSize} for chunk 0x${chunkType.toString(16)} in frame ${frameIndex}`,
        );
      }
      const cr = r.sub(chunkSize - 6);
      const order = (layerIndex?: number) =>
        file._chunkOrder.push({ frameIndex, chunkType, layerIndex });

      switch (chunkType) {
        case 0x2004: {
          readLayerChunk(cr, file);
          last = { kind: 'layer', index: file._layers.length - 1 };
          order();
          break;
        }
        case 0x2005: {
          const layer = readCelChunk(cr, file, frameIndex, colorMode, limits, budget);
          if (layer !== undefined) last = { kind: 'cel', layer, frame: frameIndex };
          order(layer);
          break;
        }
        case 0x2006: {
          const extra = readCelExtraChunk(cr);
          if (last.kind === 'cel') {
            const cel = file.cel(last.layer, last.frame);
            if (cel) cel.extra = extra;
          }
          order();
          break;
        }
        case 0x2007:
          file._colorProfile = readColorProfileChunk(cr);
          order();
          break;
        case 0x2008:
          readExternalFilesChunk(cr, file);
          order();
          break;
        case 0x2018:
          readTagsChunk(cr, file);
          last = { kind: 'tags', next: 0 };
          order();
          break;
        case 0x2019:
          readPaletteChunk(cr, file);
          if (frameIndex === 0) last = { kind: 'palette' };
          order();
          break;
        case 0x2020:
          applyUserData(file, last, readUserDataChunk(cr), (next) => (last = next));
          order();
          break;
        case 0x2022:
          readSliceChunk(cr, file);
          last = { kind: 'slice', index: file._slices.length - 1 };
          order();
          break;
        case 0x2023:
          readTilesetChunk(cr, file, limits, budget);
          last = { kind: 'tileset', index: file._tilesets.length - 1 };
          order();
          break;
        case 0x0004:
        case 0x0011: {
          // Old palette chunks: populate the palette, but keep the raw bytes for round-tripping.
          const data = cr.rest();
          parseOldPalette(data, file, chunkType === 0x0011);
          file._unknownChunks.push({ frameIndex, chunkType, data });
          order();
          if (frameIndex === 0) last = { kind: 'palette' };
          break;
        }
        case 0x2016: {
          // Legacy mask chunk: parse into typed data, keep the raw bytes.
          const data = cr.rest();
          parseMaskChunk(data, file);
          file._unknownChunks.push({ frameIndex, chunkType, data });
          order();
          break;
        }
        default:
          file._unknownChunks.push({ frameIndex, chunkType, data: cr.rest() });
          order();
          break;
      }
    }

    // Honor the declared frame size when it is consistent, as Aseprite does.
    const frameEnd = frameStart + frameBytes;
    if (frameBytes >= 16 && frameEnd >= r.pos && frameEnd <= r.length) r.pos = frameEnd;
  }

  return file;
}

// --- Chunk readers ---

function readLayerChunk(r: ByteReader, file: AsepriteFile): void {
  const flags = r.word();
  const layerType = r.word();
  const childLevel = r.word();
  r.word(); // default width (ignored)
  r.word(); // default height (ignored)
  const blendMode = BLEND_MODES[r.word()] ?? 'normal';
  const opacity = r.byte();
  r.skip(3);
  const name = r.string();

  let kind: LayerKind;
  if (layerType === 1) kind = { type: 'group' };
  else if (layerType === 2) kind = { type: 'tilemap', tilesetIndex: r.dword() };
  else kind = { type: 'normal' };

  const layer: Layer = {
    name,
    kind,
    parent: childLevel === 0 ? undefined : findParentForChildLevel(file._layers, childLevel),
    opacity,
    blendMode,
    visible: (flags & 1) !== 0,
    editable: (flags & 2) !== 0,
    lockMovement: (flags & 4) !== 0,
    background: (flags & 8) !== 0,
    preferLinkedCels: (flags & 16) !== 0,
    collapsed: (flags & 32) !== 0,
    referenceLayer: (flags & 64) !== 0,
  };
  file._layers.push(layer);
}

function findParentForChildLevel(layers: Layer[], childLevel: number): number | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i]!.kind.type === 'group' && computeChildLevel(layers, i) === childLevel - 1) {
      return i;
    }
  }
  return undefined;
}

/** @internal */
export function computeChildLevel(layers: readonly Layer[], index: number): number {
  let level = 0;
  let current = layers[index]?.parent;
  while (current !== undefined) {
    level++;
    current = layers[current]?.parent;
  }
  return level;
}

function readCelChunk(
  r: ByteReader,
  file: AsepriteFile,
  frameIndex: number,
  colorMode: ColorMode,
  limits: ReadLimits,
  budget: { total: number },
): number | undefined {
  const layerIndex = r.word();
  const x = r.short();
  const y = r.short();
  const opacity = r.byte();
  const celType = r.word();
  const zIndex = r.short();
  r.skip(5);

  let kind: CelKind;
  switch (celType) {
    case 0: {
      const w = r.word();
      const h = r.word();
      checkDimensions(w, h, limits);
      const size = w * h * bytesPerPixel(colorMode);
      checkDecodedSize(size, limits, budget);
      const data = r.read(size);
      kind = { type: 'raw', pixels: { data, width: w, height: h }, x, y };
      break;
    }
    case 1:
      kind = { type: 'linked', sourceFrame: r.word(), x, y };
      break;
    case 2: {
      const w = r.word();
      const h = r.word();
      checkDimensions(w, h, limits);
      const size = w * h * bytesPerPixel(colorMode);
      checkDecodedSize(size, limits, budget);
      const compressed = r.rest();
      kind = {
        type: 'compressed',
        pixels: { data: inflate(compressed, size), width: w, height: h },
        x,
        y,
        originalCompressed: compressed,
      };
      break;
    }
    case 3: {
      const w = r.word();
      const h = r.word();
      const bitsPerTile = r.word();
      const tileIdBitmask = r.dword();
      const xFlipBitmask = r.dword();
      const yFlipBitmask = r.dword();
      const dFlipBitmask = r.dword();
      r.skip(10);
      // The current ASE format writes 32-bit tile entries. The public model and
      // writer also store each tile as a Uint32; reject other widths rather
      // than silently truncating their packed representation.
      if (bitsPerTile !== 32) {
        throw new AsepriteError('UnsupportedTileBitDepth', `unsupported tile bit depth ${bitsPerTile}; only 32-bit tiles are supported`);
      }
      const size = w * h * 4;
      const count = w * h;
      checkDimensions(w, h, limits);
      checkDecodedSize(size, limits, budget);
      const compressed = r.rest();
      const raw = inflate(compressed, size);
      const tiles = new Uint32Array(count);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < count; i++) tiles[i] = view.getUint32(i * 4, true);
      kind = {
        type: 'tilemap',
        width: w,
        height: h,
        bitsPerTile,
        tileIdBitmask,
        xFlipBitmask,
        yFlipBitmask,
        dFlipBitmask,
        tiles,
        x,
        y,
        originalCompressed: compressed,
      };
      break;
    }
    default:
      return undefined;
  }

  file._insertCel(layerIndex, frameIndex, { kind, opacity, zIndex });
  return layerIndex;
}

function readCelExtraChunk(r: ByteReader): CelExtra {
  r.dword(); // flags
  return { preciseX: r.dword(), preciseY: r.dword(), width: r.dword(), height: r.dword() };
}

function readColorProfileChunk(r: ByteReader): ColorProfile {
  const type = r.word();
  const flags = r.word();
  const gamma = r.dword();
  r.skip(8);
  if (type === 1) return { type: 'srgb', flags, gamma };
  if (type === 2) return { type: 'icc', flags, gamma, data: r.read(r.dword()) };
  return { type: 'none' };
}

function readExternalFilesChunk(r: ByteReader, file: AsepriteFile): void {
  const count = r.dword();
  r.skip(8);
  for (let i = 0; i < count; i++) {
    const id = r.dword();
    const fileType = EXTERNAL_FILE_TYPES[r.byte()] ?? 'palette';
    r.skip(7);
    file._externalFiles.push({ id, fileType, name: r.string() });
  }
}

function readTagsChunk(r: ByteReader, file: AsepriteFile): void {
  const count = r.word();
  r.skip(8);
  for (let i = 0; i < count; i++) {
    const fromFrame = r.word();
    const toFrame = r.word();
    const direction = LOOP_DIRECTIONS[r.byte()] ?? 'forward';
    const repeat = r.word();
    r.skip(6); // reserved
    r.skip(3); // deprecated tag color (RGB)
    r.skip(1); // extra byte
    file._tags.push({ name: r.string(), fromFrame, toFrame, direction, repeat });
  }
}

function readPaletteChunk(r: ByteReader, file: AsepriteFile): void {
  const newSize = r.dword();
  const first = r.dword();
  const last = r.dword();
  r.skip(8);
  const needed = Math.min(256, Math.max(newSize, last + 1));
  while (file._palette.length < needed) file._palette.push({ r: 0, g: 0, b: 0, a: 255 });
  for (let i = first; i <= last; i++) {
    const entryFlags = r.word();
    const color = { r: r.byte(), g: r.byte(), b: r.byte(), a: r.byte() };
    file._setPaletteEntry(i, entryFlags & 1 ? { ...color, name: r.string() } : color);
  }
}

function applyUserData(
  file: AsepriteFile,
  last: LastEntity,
  ud: UserData,
  setLast: (next: LastEntity) => void,
): void {
  switch (last.kind) {
    case 'layer': {
      const layer = file._layers[last.index];
      if (layer) layer.userData = ud;
      break;
    }
    case 'cel': {
      const cel = file.cel(last.layer, last.frame);
      if (cel) cel.userData = ud;
      break;
    }
    case 'tags': {
      const tag = file._tags[last.next];
      if (tag) tag.userData = ud;
      setLast({ kind: 'tags', next: last.next + 1 });
      break;
    }
    case 'palette':
      file._spriteUserData = ud;
      break;
    case 'slice': {
      const slice = file._slices[last.index];
      if (slice) slice.userData = ud;
      break;
    }
    case 'tileset': {
      const ts = file._tilesets[last.index];
      if (ts) ts.userData = ud;
      setLast({ kind: 'tiles', tileset: last.index, next: 0 });
      break;
    }
    case 'tiles': {
      const ts = file._tilesets[last.tileset];
      if (ts && last.next < ts.tileUserData.length) ts.tileUserData[last.next] = ud;
      setLast({ kind: 'tiles', tileset: last.tileset, next: last.next + 1 });
      break;
    }
    case 'none':
      break;
  }
}

function readUserDataChunk(r: ByteReader): UserData {
  const flags = r.dword();
  const ud: UserData = { properties: [] };
  if (flags & 1) ud.text = r.string();
  if (flags & 2) ud.color = { r: r.byte(), g: r.byte(), b: r.byte(), a: r.byte() };
  if (flags & 4) {
    const propSize = r.dword();
    if (propSize < 8) {
      throw new AsepriteError('InvalidChunkSize', `invalid user data properties size ${propSize}`);
    }
    // The size includes its own DWORD, so the block is `propSize - 4` more bytes.
    const pr = r.sub(propSize - 4);
    const numMaps = pr.dword();
    for (let i = 0; i < numMaps; i++) ud.properties.push(readPropertiesMap(pr));
  }
  return ud;
}

function readPropertiesMap(r: ByteReader): PropertiesMap {
  const key = r.dword();
  return { key, entries: readPropertyEntries(r, r.dword()) };
}

function readPropertyEntries(r: ByteReader, count: number): PropertyEntries {
  const entries: PropertyEntries = [];
  for (let i = 0; i < count; i++) {
    const name = r.string();
    entries.push([name, readPropertyValue(r, r.word())]);
  }
  return entries;
}

function readPropertyValue(r: ByteReader, typeId: number): PropertyValue {
  switch (typeId) {
    case 0x01:
      return { type: 'bool', value: r.byte() !== 0 };
    case 0x02:
      return { type: 'int8', value: r.int8() };
    case 0x03:
      return { type: 'uint8', value: r.byte() };
    case 0x04:
      return { type: 'int16', value: r.short() };
    case 0x05:
      return { type: 'uint16', value: r.word() };
    case 0x06:
      return { type: 'int32', value: r.long() };
    case 0x07:
      return { type: 'uint32', value: r.dword() };
    case 0x08:
      return { type: 'int64', value: r.long64() };
    case 0x09:
      return { type: 'uint64', value: r.qword() };
    case 0x0a:
      return { type: 'fixed', value: r.dword() };
    case 0x0b:
      return { type: 'float', value: r.float() };
    case 0x0c:
      return { type: 'double', value: r.double() };
    case 0x0d:
      return { type: 'string', value: r.string() };
    case 0x0e:
      return { type: 'point', x: r.long(), y: r.long() };
    case 0x0f:
      return { type: 'size', width: r.long(), height: r.long() };
    case 0x10:
      return { type: 'rect', x: r.long(), y: r.long(), width: r.long(), height: r.long() };
    case 0x11: {
      const count = r.dword();
      const elemType = r.word();
      const value: PropertyValue[] = [];
      for (let i = 0; i < count; i++) {
        // Element type 0 means heterogeneous: each element carries its own type.
        value.push(readPropertyValue(r, elemType === 0 ? r.word() : elemType));
      }
      return { type: 'vector', value };
    }
    case 0x12:
      return { type: 'properties', value: readPropertyEntries(r, r.dword()) };
    case 0x13:
      return { type: 'uuid', value: r.read(16) };
    default:
      throw new AsepriteError(
        'UnsupportedPropertyType',
        `unsupported property type: 0x${typeId.toString(16).padStart(4, '0')}`,
      );
  }
}

function readSliceChunk(r: ByteReader, file: AsepriteFile): void {
  const numKeys = r.dword();
  const flags = r.dword();
  r.dword(); // reserved
  const name = r.string();
  const hasNinePatch = (flags & 1) !== 0;
  const hasPivot = (flags & 2) !== 0;
  const keys: SliceKey[] = [];
  for (let i = 0; i < numKeys; i++) {
    const key: SliceKey = {
      frame: r.dword(),
      x: r.long(),
      y: r.long(),
      width: r.dword(),
      height: r.dword(),
    };
    if (hasNinePatch) {
      key.ninePatch = {
        centerX: r.long(),
        centerY: r.long(),
        centerWidth: r.dword(),
        centerHeight: r.dword(),
      };
    }
    if (hasPivot) key.pivot = { x: r.long(), y: r.long() };
    keys.push(key);
  }
  file._slices.push({ name, keys, hasNinePatch, hasPivot });
}

function readTilesetChunk(
  r: ByteReader,
  file: AsepriteFile,
  limits: ReadLimits,
  budget: { total: number },
): void {
  const id = r.dword();
  const flags = r.dword();
  const tileCount = r.dword();
  const tileWidth = r.word();
  const tileHeight = r.word();
  const baseIndex = r.short();
  r.skip(14);
  const name = r.string();

  let data: TilesetData = { type: 'empty' };
  checkDimensions(tileWidth, tileHeight, limits);
  checkDecodedSize(tileCount * 8, limits, budget);
  if (flags & TilesetFlags.ExternalLink) {
    data = { type: 'external', externalFileId: r.dword(), tilesetIdInExternal: r.dword() };
  }
  if (flags & TilesetFlags.EmbeddedTiles) {
    const compressed = r.read(r.dword());
    const size = tileWidth * tileHeight * tileCount * bytesPerPixel(file._colorMode);
    checkDecodedSize(size, limits, budget);
    data = { type: 'embedded', pixels: inflate(compressed, size), originalCompressed: compressed };
  }
  file._tilesets.push({
    id,
    flags,
    name,
    tileCount,
    tileWidth,
    tileHeight,
    baseIndex,
    data,
    tileUserData: new Array<UserData | undefined>(tileCount).fill(undefined),
  });
}

function parseOldPalette(data: Uint8Array, file: AsepriteFile, sixBit: boolean): void {
  const r = new ByteReader(data);
  const numPackets = r.word();
  let index = 0;
  for (let p = 0; p < numPackets; p++) {
    index += r.byte();
    const count = r.byte() || 256;
    for (let i = 0; i < count; i++) {
      let red = r.byte();
      let green = r.byte();
      let blue = r.byte();
      if (sixBit) {
        // VGA 6-bit range (0-63) scaled to 0-255.
        red = ((red << 2) | (red >> 4)) & 0xff;
        green = ((green << 2) | (green >> 4)) & 0xff;
        blue = ((blue << 2) | (blue >> 4)) & 0xff;
      }
      file._setPaletteEntry(index++, { r: red, g: green, b: blue, a: 255 });
    }
  }
}

function parseMaskChunk(data: Uint8Array, file: AsepriteFile): void {
  if (data.length < 18) return;
  const r = new ByteReader(data);
  const x = r.short();
  const y = r.short();
  const width = r.word();
  const height = r.word();
  r.skip(8);
  const nameLen = r.word();
  if (nameLen > r.remaining) return;
  r.pos -= 2;
  const name = r.string();
  file._legacyMasks.push({ x, y, width, height, name, bitmap: r.rest() });
}
