import { AsepriteError } from './errors.js';
import { readAseprite } from './reader.js';
import {
  bytesPerPixel,
  type Cel,
  type CelExtra,
  type CelOptions,
  type ChunkOrderEntry,
  type Color,
  type ColorMode,
  type ColorProfile,
  type ExternalFile,
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
  type Pixels,
  type Slice,
  type Tag,
  type TilemapCelOptions,
  type Tileset,
  type UnknownChunk,
  type UserData,
} from './types.js';
import { writeAseprite, type WriteOptions } from './writer.js';

/** Input accepted by {@link AsepriteFile.read}. */
export type BinaryInput = Uint8Array | ArrayBuffer | ArrayBufferView;

function toBytes(input: BinaryInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('expected a Uint8Array, ArrayBuffer, or ArrayBufferView');
}

/** Packs (layer, frame) into a key whose numeric order is (layer, frame) order. */
function celKey(layer: number, frame: number): number {
  return layer * 0x10000 + frame;
}

/** A cel together with its position, as yielded by {@link AsepriteFile.cels}. */
export interface CelEntry {
  layer: number;
  frame: number;
  cel: Cel;
}

/**
 * An Aseprite `.ase`/`.aseprite` file.
 *
 * @example Reading
 * ```ts
 * const file = AsepriteFile.read(bytes);
 * console.log(file.width, file.height, file.frames.length);
 * ```
 *
 * @example Creating
 * ```ts
 * const file = new AsepriteFile(16, 16, 'rgba');
 * const layer = file.addLayer('Background');
 * const frame = file.addFrame(100);
 * file.setCel(layer, frame, createPixels(new Uint8Array(16 * 16 * 4), 16, 16, 'rgba'));
 * const bytes = file.write();
 * ```
 */
export class AsepriteFile {
  /** @internal */ _width: number;
  /** @internal */ _height: number;
  /** @internal */ _colorMode: ColorMode;
  /** @internal */ _flags = 1;
  /** @internal */ _deprecatedSpeed = 0;
  /** @internal */ _numColors = 0;
  /** @internal */ _transparentIndex = 0;
  /** @internal */ _pixelRatio: { width: number; height: number } = { width: 1, height: 1 };
  /** @internal */ _grid: GridInfo = { x: 0, y: 0, width: 16, height: 16 };
  /** @internal */ _colorProfile: ColorProfile | undefined = undefined;
  /** @internal */ _palette: Color[] = [];
  /** @internal */ _layers: Layer[] = [];
  /** @internal */ _frames: Frame[] = [];
  /** @internal */ _tags: Tag[] = [];
  /** @internal */ _slices: Slice[] = [];
  /** @internal */ _spriteUserData: UserData | undefined = undefined;
  /** @internal */ _cels = new Map<number, Cel>();
  /** @internal */ _tilesets: Tileset[] = [];
  /** @internal */ _externalFiles: ExternalFile[] = [];
  /** @internal */ _legacyMasks: LegacyMask[] = [];
  /** @internal */ _unknownChunks: UnknownChunk[] = [];
  /** @internal */ _chunkOrder: ChunkOrderEntry[] = [];

  /** Creates an empty file with the given canvas size and color mode. */
  constructor(width: number, height: number, colorMode: ColorMode) {
    this._width = width;
    this._height = height;
    this._colorMode = colorMode;
  }

  // --- I/O ---

  /** Parses an Aseprite file from its bytes. Throws {@link AsepriteError} on malformed input. */
  static read(input: BinaryInput): AsepriteFile {
    return readAseprite(toBytes(input));
  }

  /** Serializes the file to Aseprite binary format. */
  write(options?: WriteOptions): Uint8Array {
    return writeAseprite(this, options);
  }

  // --- Accessors ---

  /** Canvas width in pixels. */
  get width(): number {
    return this._width;
  }
  /** Canvas height in pixels. */
  get height(): number {
    return this._height;
  }
  /** Color mode. */
  get colorMode(): ColorMode {
    return this._colorMode;
  }
  /** Raw header flags (bit 1: layer opacity is valid; bit 2: group opacity/blend valid; bit 4: layers have a UUID). */
  get flags(): number {
    return this._flags;
  }
  /** Pixel aspect ratio. */
  get pixelRatio(): Readonly<{ width: number; height: number }> {
    return this._pixelRatio;
  }
  /** Grid overlay settings. */
  get grid(): Readonly<GridInfo> {
    return this._grid;
  }
  /** Color profile, if set. */
  get colorProfile(): ColorProfile | undefined {
    return this._colorProfile;
  }
  /** Color palette (empty if the file had no palette chunk). */
  get palette(): readonly Color[] {
    return this._palette;
  }
  /** All layers, in document order (bottom to top). */
  get layers(): readonly Layer[] {
    return this._layers;
  }
  /** All frames. */
  get frames(): readonly Frame[] {
    return this._frames;
  }
  /** All animation tags. */
  get tags(): readonly Tag[] {
    return this._tags;
  }
  /** All slices. */
  get slices(): readonly Slice[] {
    return this._slices;
  }
  /** Sprite-level user data, if set. */
  get spriteUserData(): UserData | undefined {
    return this._spriteUserData;
  }
  /** Transparent palette index (only meaningful in indexed color mode). */
  get transparentIndex(): number {
    return this._transparentIndex;
  }
  /** Legacy mask chunks (deprecated in modern Aseprite). */
  get legacyMasks(): readonly LegacyMask[] {
    return this._legacyMasks;
  }
  /** All tilesets. */
  get tilesets(): readonly Tileset[] {
    return this._tilesets;
  }
  /** All external file references. */
  get externalFiles(): readonly ExternalFile[] {
    return this._externalFiles;
  }

  /** Returns the raw cel at a layer/frame, or `undefined`. May be a `'linked'` cel; see {@link resolveCel}. */
  cel(layer: LayerRef | number, frame: number): Cel | undefined {
    return this._cels.get(celKey(layer, frame));
  }

  /**
   * Returns the cel at a layer/frame, following linked cels. Never returns a
   * `'linked'` cel; returns `undefined` if the cel or its link target is missing.
   */
  resolveCel(layer: LayerRef | number, frame: number): Cel | undefined {
    const cel = this._cels.get(celKey(layer, frame));
    if (!cel) return undefined;
    if (cel.kind.type === 'linked') {
      const target = this._cels.get(celKey(layer, cel.kind.sourceFrame));
      return target && target.kind.type !== 'linked' ? target : undefined;
    }
    return cel;
  }

  /** Iterates over all cels, ordered by layer index and then frame index. */
  *cels(): IterableIterator<CelEntry> {
    const keys = [...this._cels.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      yield { layer: Math.floor(key / 0x10000), frame: key % 0x10000, cel: this._cels.get(key)! };
    }
  }

  /** Returns a {@link LayerRef} for a layer index, or `undefined` if out of bounds or a group. */
  layerRef(index: number): LayerRef | undefined {
    const layer = this._layers[index];
    return layer && layer.kind.type !== 'group' ? (index as LayerRef) : undefined;
  }

  /** Returns a {@link GroupRef} for a layer index, or `undefined` if out of bounds or not a group. */
  groupRef(index: number): GroupRef | undefined {
    const layer = this._layers[index];
    return layer && layer.kind.type === 'group' ? (index as GroupRef) : undefined;
  }

  // --- Layers ---

  private pushLayer(
    name: string,
    kind: LayerKind,
    parent: number | undefined,
    opts: LayerOptions = {},
  ): number {
    const index = this._layers.length;
    this._layers.push({
      name,
      kind,
      parent,
      opacity: opts.opacity ?? 255,
      blendMode: opts.blendMode ?? 'normal',
      visible: opts.visible ?? true,
      editable: opts.editable ?? true,
      lockMovement: opts.lockMovement ?? false,
      background: opts.background ?? false,
      preferLinkedCels: opts.preferLinkedCels ?? false,
      collapsed: opts.collapsed ?? false,
      referenceLayer: opts.referenceLayer ?? false,
    });
    return index;
  }

  /** Adds a normal layer, at the top level or inside `parent`. */
  addLayer(name: string, opts?: LayerOptions & { parent?: GroupRef }): LayerRef {
    return this.pushLayer(name, { type: 'normal' }, opts?.parent, opts) as LayerRef;
  }

  /** Adds a group layer, at the top level or nested inside `parent`. */
  addGroup(name: string, opts?: LayerOptions & { parent?: GroupRef }): GroupRef {
    return this.pushLayer(name, { type: 'group' }, opts?.parent, opts) as GroupRef;
  }

  /** Adds a tilemap layer referencing the tileset at `tilesetIndex`. */
  addTilemapLayer(
    name: string,
    tilesetIndex: number,
    opts?: LayerOptions & { parent?: GroupRef },
  ): LayerRef {
    return this.pushLayer(name, { type: 'tilemap', tilesetIndex }, opts?.parent, opts) as LayerRef;
  }

  // --- Frames ---

  /** Adds a frame with the given duration in milliseconds. Returns the frame index. */
  addFrame(durationMs = 100): number {
    this._frames.push({ durationMs });
    return this._frames.length - 1;
  }

  // --- Cels ---

  private checkFrame(frame: number): void {
    if (!Number.isInteger(frame) || frame < 0 || frame >= this._frames.length) {
      throw new AsepriteError('FrameOutOfBounds', `frame index ${frame} out of bounds`);
    }
  }

  private checkPixels(pixels: Pixels): void {
    const expected = pixels.width * pixels.height * bytesPerPixel(this._colorMode);
    if (pixels.data.length !== expected) {
      throw new AsepriteError(
        'PixelSizeMismatch',
        `pixel data size mismatch: expected ${expected}, got ${pixels.data.length}`,
      );
    }
  }

  /** Sets the pixel content of a layer/frame (zlib-compressed unless `opts.raw` is set). */
  setCel(layer: LayerRef, frame: number, pixels: Pixels, opts: CelOptions = {}): void {
    this.checkFrame(frame);
    this.checkPixels(pixels);
    const x = opts.x ?? 0;
    const y = opts.y ?? 0;
    this._cels.set(celKey(layer, frame), {
      kind: opts.raw ? { type: 'raw', pixels, x, y } : { type: 'compressed', pixels, x, y },
      opacity: opts.opacity ?? 255,
      zIndex: opts.zIndex ?? 0,
      userData: opts.userData,
      extra: opts.extra,
    });
  }

  /** Makes the cel at `frame` a link to the cel at `sourceFrame` on the same layer. */
  setLinkedCel(
    layer: LayerRef,
    frame: number,
    sourceFrame: number,
    opts: LinkedCelOptions = {},
  ): void {
    this.checkFrame(frame);
    this.checkFrame(sourceFrame);
    this._cels.set(celKey(layer, frame), {
      kind: { type: 'linked', sourceFrame, x: opts.x ?? 0, y: opts.y ?? 0 },
      opacity: opts.opacity ?? 255,
      zIndex: opts.zIndex ?? 0,
      userData: opts.userData,
      extra: opts.extra,
    });
  }

  /**
   * Sets tilemap content for a tilemap layer/frame. `tiles` holds `width * height`
   * 32-bit tile entries (tile ID in the low 29 bits, then X/Y/diagonal flip bits).
   */
  setTilemapCel(
    layer: LayerRef,
    frame: number,
    tiles: Uint32Array | ArrayLike<number>,
    width: number,
    height: number,
    opts: TilemapCelOptions = {},
  ): void {
    this.checkFrame(frame);
    const tileArray = tiles instanceof Uint32Array ? tiles : Uint32Array.from(tiles);
    if (tileArray.length !== width * height) {
      throw new AsepriteError(
        'PixelSizeMismatch',
        `tile count mismatch: expected ${width * height}, got ${tileArray.length}`,
      );
    }
    this._cels.set(celKey(layer, frame), {
      kind: {
        type: 'tilemap',
        width,
        height,
        bitsPerTile: 32,
        tileIdBitmask: 0x1fffffff,
        xFlipBitmask: 0x20000000,
        yFlipBitmask: 0x40000000,
        dFlipBitmask: 0x80000000,
        tiles: tileArray,
        x: opts.x ?? 0,
        y: opts.y ?? 0,
      },
      opacity: opts.opacity ?? 255,
      zIndex: opts.zIndex ?? 0,
    });
  }

  /** Removes the cel at a layer/frame. Returns whether a cel was removed. */
  removeCel(layer: LayerRef, frame: number): boolean {
    return this._cels.delete(celKey(layer, frame));
  }

  // --- Tags ---

  /** Adds an animation tag over the inclusive frame range `[from, to]`. Returns the tag index. */
  addTag(
    name: string,
    from: number,
    to: number,
    direction: LoopDirection = 'forward',
    repeat = 0,
  ): number {
    if (from < 0 || to < from || (this._frames.length > 0 && to >= this._frames.length)) {
      throw new AsepriteError('InvalidFrameRange', `invalid frame range ${from}..=${to}`);
    }
    this._tags.push({ name, fromFrame: from, toFrame: to, direction, repeat });
    return this._tags.length - 1;
  }

  // --- Palette & misc ---

  /** Sets the color palette (at most 256 entries). */
  setPalette(colors: readonly Color[]): void {
    if (colors.length > 256) {
      throw new AsepriteError(
        'FormatLimitExceeded',
        `format limit exceeded for palette: ${colors.length} > 256`,
      );
    }
    this._palette = colors.map((c) => ({ ...c }));
  }

  /** Sets the transparent palette index. */
  setTransparentIndex(index: number): void {
    this._transparentIndex = index;
  }

  /** Sets the color profile. */
  setColorProfile(profile: ColorProfile): void {
    this._colorProfile = profile;
  }

  /** Sets the pixel aspect ratio. */
  setPixelRatio(width: number, height: number): void {
    this._pixelRatio = { width, height };
  }

  /** Sets the grid overlay settings. */
  setGrid(grid: GridInfo): void {
    this._grid = { ...grid };
  }

  /** Adds a slice. Returns its index. */
  addSlice(slice: Slice): number {
    this._slices.push(slice);
    return this._slices.length - 1;
  }

  /** Sets the sprite-level user data. */
  setSpriteUserData(userData: UserData): void {
    this._spriteUserData = userData;
  }

  /** Adds a tileset definition. Returns its index. */
  addTileset(tileset: Tileset): number {
    this._tilesets.push(tileset);
    return this._tilesets.length - 1;
  }

  /** Adds an external file reference. */
  addExternalFile(externalFile: ExternalFile): void {
    this._externalFiles.push(externalFile);
  }

  /** Sets user data on a layer or group. */
  setLayerUserData(layer: LayerRef | GroupRef, userData: UserData): void {
    const l = this._layers[layer];
    if (l) l.userData = userData;
  }

  /** Sets user data on an existing cel. */
  setCelUserData(layer: LayerRef, frame: number, userData: UserData): void {
    const cel = this._cels.get(celKey(layer, frame));
    if (cel) cel.userData = userData;
  }

  /** Sets extra precision bounds on an existing cel. */
  setCelExtra(layer: LayerRef, frame: number, extra: CelExtra): void {
    const cel = this._cels.get(celKey(layer, frame));
    if (cel) cel.extra = extra;
  }

  /** Sets user data on a tag. */
  setTagUserData(tagIndex: number, userData: UserData): void {
    const tag = this._tags[tagIndex];
    if (tag) tag.userData = userData;
  }

  // --- Internal helpers for reader/writer ---

  /** @internal */
  _insertCel(layer: number, frame: number, cel: Cel): void {
    this._cels.set(celKey(layer, frame), cel);
  }

  /** @internal */
  _setPaletteEntry(index: number, color: Color): void {
    while (this._palette.length <= index) this._palette.push({ r: 0, g: 0, b: 0, a: 255 });
    this._palette[index] = color;
  }
}
