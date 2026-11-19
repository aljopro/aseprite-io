/**
 * Read and write Aseprite `.ase`/`.aseprite` files.
 *
 * Works in browsers, Node.js, Deno, Bun and workers: it only uses
 * `Uint8Array`, `DataView` and `TextEncoder`/`TextDecoder`, with zlib
 * provided by the pure-JS `fflate` library.
 *
 * @packageDocumentation
 */
export { AsepriteFile, type BinaryInput, type CelEntry } from './file.js';
export { AsepriteError, type AsepriteErrorCode } from './errors.js';
export type { WriteOptions } from './writer.js';
export type { CompressionLevel, ReadLimits } from './zlib.js';
export {
  BLEND_MODES,
  EXTERNAL_FILE_TYPES,
  LOOP_DIRECTIONS,
  TilesetFlags,
  bytesPerPixel,
  createPixels,
  type BlendMode,
  type Cel,
  type CelExtra,
  type CelKind,
  type CelOptions,
  type Color,
  type ColorMode,
  type ColorProfile,
  type ExternalFile,
  type ExternalFileType,
  type Frame,
  type GridInfo,
  type GroupRef,
  type Layer,
  type LayerKind,
  type LayerOptions,
  type LayerRef,
  type LegacyMask,
  type LinkedCelOptions,
  type LoopDirection,
  type NinePatch,
  type Pixels,
  type PropertiesMap,
  type PropertyEntries,
  type PropertyValue,
  type Slice,
  type SliceKey,
  type Tag,
  type TilemapCelOptions,
  type Tileset,
  type TilesetData,
  type UserData,
} from './types.js';
