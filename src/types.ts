import { AsepriteError } from './errors.js';

// --- Enums ---

/** The color depth mode of a file: RGBA (32 bpp), grayscale (16 bpp: value + alpha) or indexed (8 bpp). */
export type ColorMode = 'rgba' | 'grayscale' | 'indexed';

/** Returns the number of bytes per pixel for a color mode. */
export function bytesPerPixel(mode: ColorMode): 1 | 2 | 4 {
  switch (mode) {
    case 'rgba':
      return 4;
    case 'grayscale':
      return 2;
    case 'indexed':
      return 1;
  }
}

/** @internal */
export function colorModeFromDepth(depth: number): ColorMode {
  switch (depth) {
    case 32:
      return 'rgba';
    case 16:
      return 'grayscale';
    case 8:
      return 'indexed';
    default:
      throw new AsepriteError('UnsupportedColorDepth', `unsupported color depth: ${depth}`);
  }
}

/** @internal */
export function colorModeToDepth(mode: ColorMode): number {
  return bytesPerPixel(mode) * 8;
}

/** Layer blend modes, in the order Aseprite stores them. */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'addition',
  'subtract',
  'divide',
] as const;

/** Layer blend mode. */
export type BlendMode = (typeof BLEND_MODES)[number];

/** Animation loop directions, in the order Aseprite stores them. */
export const LOOP_DIRECTIONS = ['forward', 'reverse', 'ping-pong', 'ping-pong-reverse'] as const;

/** Animation loop direction for tags. */
export type LoopDirection = (typeof LOOP_DIRECTIONS)[number];

/** The type of a layer. */
export type LayerKind =
  | { type: 'normal' }
  | { type: 'group' }
  /** A tilemap layer referencing a tileset by index. */
  | { type: 'tilemap'; tilesetIndex: number };

/** Color profile embedded in the file. */
export type ColorProfile =
  | { type: 'none' }
  | { type: 'srgb'; flags: number; gamma: number }
  | { type: 'icc'; flags: number; gamma: number; data: Uint8Array };

// --- Handles ---

/** Handle to a non-group layer (a layer index). Obtain from {@link AsepriteFile.addLayer} or {@link AsepriteFile.layerRef}. */
export type LayerRef = number & { readonly __brand: 'LayerRef' };

/** Handle to a group layer (a layer index). Obtain from {@link AsepriteFile.addGroup} or {@link AsepriteFile.groupRef}. */
export type GroupRef = number & { readonly __brand: 'GroupRef' };

// --- Data ---

/**
 * Raw pixel data. The layout depends on the file's {@link ColorMode}:
 * RGBA = 4 bytes/pixel, grayscale = 2 bytes/pixel (value, alpha), indexed = 1 byte/pixel.
 */
export interface Pixels {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Creates a pixel buffer, validating that `data.length === width * height * bytesPerPixel(colorMode)`. */
export function createPixels(
  data: Uint8Array | ArrayLike<number>,
  width: number,
  height: number,
  colorMode: ColorMode,
): Pixels {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const expected = width * height * bytesPerPixel(colorMode);
  if (bytes.length !== expected) {
    throw new AsepriteError(
      'PixelSizeMismatch',
      `pixel data size mismatch: expected ${expected}, got ${bytes.length}`,
    );
  }
  return { data: bytes, width, height };
}

/** An RGBA color with an optional name (names are used in palettes). */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
  name?: string;
}

/** Grid overlay settings. */
export interface GridInfo {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A layer (normal, group, or tilemap). */
export interface Layer {
  name: string;
  kind: LayerKind;
  /** Index of the parent group layer, or `undefined` for top-level layers. */
  parent?: number;
  opacity: number;
  blendMode: BlendMode;
  visible: boolean;
  editable: boolean;
  lockMovement: boolean;
  background: boolean;
  preferLinkedCels: boolean;
  collapsed: boolean;
  referenceLayer: boolean;
  userData?: UserData;
}

/** Options for creating a layer. All fields are optional. */
export interface LayerOptions {
  /** Default 255. */
  opacity?: number;
  /** Default `'normal'`. */
  blendMode?: BlendMode;
  /** Default true. */
  visible?: boolean;
  /** Default true. */
  editable?: boolean;
  lockMovement?: boolean;
  background?: boolean;
  collapsed?: boolean;
  preferLinkedCels?: boolean;
  referenceLayer?: boolean;
}

/** A single animation frame. */
export interface Frame {
  durationMs: number;
}

/** An animation tag spanning an inclusive range of frames. */
export interface Tag {
  name: string;
  fromFrame: number;
  toFrame: number;
  direction: LoopDirection;
  /** 0 = repeat forever. */
  repeat: number;
  userData?: UserData;
}

/** A cel: the content of one layer in one frame. */
export interface Cel {
  kind: CelKind;
  opacity: number;
  zIndex: number;
  userData?: UserData;
  extra?: CelExtra;
}

/** The type and data of a cel. */
export type CelKind =
  /** Uncompressed pixel data. */
  | { type: 'raw'; pixels: Pixels; x: number; y: number }
  /**
   * Zlib-compressed pixel data. `originalCompressed` keeps the bytes read from
   * the file so that unmodified cels are written back byte-for-byte; it is
   * ignored automatically once `pixels.data` no longer matches it.
   */
  | {
      type: 'compressed';
      pixels: Pixels;
      x: number;
      y: number;
      originalCompressed?: Uint8Array;
    }
  /** References another frame's cel on the same layer. Use {@link AsepriteFile.resolveCel} to follow the link. */
  | { type: 'linked'; sourceFrame: number; x: number; y: number }
  /** Tilemap data referencing tiles by ID (plus flip flags, per the bitmasks). */
  | {
      type: 'tilemap';
      width: number;
      height: number;
      bitsPerTile: number;
      tileIdBitmask: number;
      xFlipBitmask: number;
      yFlipBitmask: number;
      dFlipBitmask: number;
      tiles: Uint32Array;
      x: number;
      y: number;
      originalCompressed?: Uint8Array;
    };

/** Options for {@link AsepriteFile.setCel}. */
export interface CelOptions {
  x?: number;
  y?: number;
  /** Default 255. */
  opacity?: number;
  zIndex?: number;
  /** Store pixels uncompressed (cel type 0) instead of zlib-compressed. Default false. */
  raw?: boolean;
  userData?: UserData;
  extra?: CelExtra;
}

/** Options for {@link AsepriteFile.setLinkedCel}. */
export interface LinkedCelOptions {
  x?: number;
  y?: number;
  /** Default 255. */
  opacity?: number;
  zIndex?: number;
  userData?: UserData;
  extra?: CelExtra;
}

/** Options for {@link AsepriteFile.setTilemapCel}. */
export interface TilemapCelOptions {
  x?: number;
  y?: number;
  /** Default 255. */
  opacity?: number;
  zIndex?: number;
}

// --- User data ---

/** User-defined metadata attached to layers, cels, tags, slices, tilesets, tiles, or the sprite itself. */
export interface UserData {
  text?: string;
  color?: Omit<Color, 'name'>;
  properties: PropertiesMap[];
}

/** An ordered list of named properties. */
export type PropertyEntries = Array<[name: string, value: PropertyValue]>;

/** A map of typed properties. Key 0 holds user properties; other keys belong to extensions. */
export interface PropertiesMap {
  key: number;
  entries: PropertyEntries;
}

/** A typed value within a properties map. 64-bit integers are `bigint`. */
export type PropertyValue =
  | { type: 'bool'; value: boolean }
  | { type: 'int8'; value: number }
  | { type: 'uint8'; value: number }
  | { type: 'int16'; value: number }
  | { type: 'uint16'; value: number }
  | { type: 'int32'; value: number }
  | { type: 'uint32'; value: number }
  | { type: 'int64'; value: bigint }
  | { type: 'uint64'; value: bigint }
  /** 16.16 fixed-point number, stored as its raw 32-bit integer. Divide by 65536 for the numeric value. */
  | { type: 'fixed'; value: number }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'string'; value: string }
  | { type: 'point'; x: number; y: number }
  | { type: 'size'; width: number; height: number }
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'vector'; value: PropertyValue[] }
  | { type: 'properties'; value: PropertyEntries }
  | { type: 'uuid'; value: Uint8Array };

// --- Slices ---

/** A named rectangular region, optionally with nine-patch and pivot data. */
export interface Slice {
  name: string;
  keys: SliceKey[];
  hasNinePatch: boolean;
  hasPivot: boolean;
  userData?: UserData;
}

/** A slice's bounds starting at a specific frame. */
export interface SliceKey {
  frame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  ninePatch?: NinePatch;
  pivot?: { x: number; y: number };
}

/** Nine-patch (9-slice) center region, relative to the slice bounds. */
export interface NinePatch {
  centerX: number;
  centerY: number;
  centerWidth: number;
  centerHeight: number;
}

/** Extra precision bounds for a cel. Values are 16.16 fixed-point. */
export interface CelExtra {
  preciseX: number;
  preciseY: number;
  width: number;
  height: number;
}

// --- Tilesets ---

/** Bit flags for {@link Tileset.flags}. */
export const TilesetFlags = {
  /** The tileset references an external file. */
  ExternalLink: 1,
  /** The tileset has embedded tile pixel data. */
  EmbeddedTiles: 2,
  /** Tile ID 0 represents the empty tile. */
  EmptyTileIsZero: 4,
  /** Aseprite may match modified tiles with their X-flipped version. */
  MatchXFlip: 8,
  /** Aseprite may match modified tiles with their Y-flipped version. */
  MatchYFlip: 16,
  /** Aseprite may match modified tiles with their diagonally flipped version. */
  MatchDFlip: 32,
} as const;

/** A tileset definition. */
export interface Tileset {
  id: number;
  /** Bitwise combination of {@link TilesetFlags}. */
  flags: number;
  name: string;
  tileCount: number;
  tileWidth: number;
  tileHeight: number;
  baseIndex: number;
  data: TilesetData;
  userData?: UserData;
  /** Per-tile user data; same length as `tileCount`. */
  tileUserData: Array<UserData | undefined>;
}

/** The pixel data source for a tileset. */
export type TilesetData =
  /** All tiles stacked vertically: `tileWidth * (tileHeight * tileCount)` pixels in the file's color mode. */
  | { type: 'embedded'; pixels: Uint8Array; originalCompressed?: Uint8Array }
  | { type: 'external'; externalFileId: number; tilesetIdInExternal: number }
  | { type: 'empty' };

// --- External files ---

/** External file types, in the order Aseprite stores them. */
export const EXTERNAL_FILE_TYPES = [
  'palette',
  'tileset',
  'extension-properties',
  'extension-tile-management',
] as const;

/** The type of an external file reference. */
export type ExternalFileType = (typeof EXTERNAL_FILE_TYPES)[number];

/** A reference to an external file. */
export interface ExternalFile {
  id: number;
  fileType: ExternalFileType;
  name: string;
}

/** A legacy mask chunk (deprecated in modern Aseprite; preserved for round-trip fidelity, read-only). */
export interface LegacyMask {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  bitmap: Uint8Array;
}

/** @internal An unrecognized or legacy chunk kept verbatim. */
export interface UnknownChunk {
  frameIndex: number;
  chunkType: number;
  data: Uint8Array;
}

/** @internal The order in which chunks appeared in a file that was read. */
export interface ChunkOrderEntry {
  frameIndex: number;
  chunkType: number;
  /** For cel chunks (0x2005): the layer index of the cel. */
  layerIndex?: number;
}

/** @internal */
export function isNonEmptyUserData(ud: UserData | undefined): ud is UserData {
  return !!ud && (ud.text !== undefined || ud.color !== undefined || ud.properties.length > 0);
}
