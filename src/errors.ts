/** Machine-readable category of an {@link AsepriteError}. */
export type AsepriteErrorCode =
  /** The input ended before a complete structure could be read. */
  | 'UnexpectedEof'
  /** The file or a frame does not start with the expected magic number. */
  | 'InvalidMagic'
  /** The header declares a color depth other than 8, 16 or 32 bits. */
  | 'UnsupportedColorDepth'
  /** A frame index is out of bounds. */
  | 'FrameOutOfBounds'
  /** A pixel buffer does not match `width * height * bytesPerPixel`. */
  | 'PixelSizeMismatch'
  /** A tag's frame range is invalid or extends beyond the last frame. */
  | 'InvalidFrameRange'
  /** Indexed color mode requires a palette, but none was set. */
  | 'MissingPalette'
  /** A chunk's declared size is invalid. */
  | 'InvalidChunkSize'
  /** A user-data property type ID is not recognized. */
  | 'UnsupportedPropertyType'
  /** A value exceeds a limit of the file format (e.g. more than 256 palette entries). */
  | 'FormatLimitExceeded'
  /** Zlib-compressed data could not be decompressed. */
  | 'DecompressionFailed';

/** Error thrown when reading or writing Aseprite files fails. */
export class AsepriteError extends Error {
  override readonly name = 'AsepriteError';
  /** The underlying error, when this one wraps another (e.g. a zlib failure). */
  declare readonly cause?: unknown;

  constructor(
    readonly code: AsepriteErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
