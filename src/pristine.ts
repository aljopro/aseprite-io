/**
 * Tracks whether decoded data read from a file was ever handed to the caller.
 *
 * The reader stores decoded cel pixels, tilemap tiles and tileset pixels
 * behind accessor properties backed by a {@link Decoded} cell. Until the
 * property is read or assigned, no code outside the library holds a reference
 * to the buffer, so it cannot have been edited, and the original compressed
 * bytes can be written back without decompressing or comparing anything.
 * Once it is exposed, the writer falls back to an exact comparison against
 * the decoded original stream.
 *
 * This keeps unchanged writes cheap without retaining a second copy of the
 * decoded data and without trusting a checksum.
 */

/** The state behind one tracked accessor property. */
export class Decoded<T> {
  exposed = false;
  constructor(
    public value: T,
    /** The stream `value` was decoded from. */
    readonly compressed: Uint8Array,
    /** Any extra encoding parameter the bytes depend on (the tilemap bit depth). */
    readonly tag: number,
  ) {}
}

let peeking = false;
let peeked: Decoded<unknown> | undefined;

/** Getter body for a tracked property. */
export function getDecoded<T>(cell: Decoded<T>): T {
  if (peeking) peeked = cell;
  else cell.exposed = true;
  return cell.value;
}

/** Setter body for a tracked property. */
export function setDecoded<T>(cell: Decoded<T>, value: T): void {
  cell.exposed = true;
  cell.value = value;
}

/**
 * True when `target[key]` is a tracked property that was never read or
 * assigned, `compressed` is the stream it was decoded from, and `tag` still
 * matches. Reading the property here does not mark it as exposed.
 */
export function isPristine(
  target: object,
  key: string,
  compressed: Uint8Array | undefined,
  tag = 0,
): boolean {
  peeking = true;
  peeked = undefined;
  try {
    void (target as Record<string, unknown>)[key];
  } finally {
    peeking = false;
  }
  // The getter above may have set `peeked`; TypeScript cannot see that.
  const cell = peeked as Decoded<unknown> | undefined;
  peeked = undefined;
  return cell !== undefined && !cell.exposed && cell.compressed === compressed && cell.tag === tag;
}
