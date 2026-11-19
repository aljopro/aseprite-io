import { unzlibSync, zlibSync } from 'fflate';
import { AsepriteError } from './errors.js';

/**
 * Decompresses a zlib stream. With `expectedSize`, output is decoded straight
 * into a buffer of that size (as Aseprite does): data beyond it is ignored and
 * a shorter stream yields a shorter result.
 */
export function inflate(data: Uint8Array, expectedSize?: number): Uint8Array {
  try {
    return expectedSize !== undefined && expectedSize > 0
      ? unzlibSync(data, { out: new Uint8Array(expectedSize) })
      : unzlibSync(data);
  } catch (e) {
    throw new AsepriteError('DecompressionFailed', `failed to decompress zlib data: ${String(e)}`, {
      cause: e,
    });
  }
}

/** zlib compression level: 0 (store) to 9 (smallest). */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** Compresses data as a zlib stream (default level 6, the zlib default). */
export function deflate(data: Uint8Array, level: CompressionLevel = 6): Uint8Array {
  return zlibSync(data, { level });
}

/** Adler-32 checksum, as stored big-endian in the last 4 bytes of every zlib stream. */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const len = data.length;
  let i = 0;
  while (i < len) {
    // 5552 is the largest block for which b cannot overflow 2^53 before the modulo;
    // the inner loop is unrolled 8x, which roughly doubles throughput in V8.
    const end = Math.min(i + 5552, len);
    const end8 = end - 7;
    for (; i < end8; i += 8) {
      a += data[i]!; b += a;
      a += data[i + 1]!; b += a;
      a += data[i + 2]!; b += a;
      a += data[i + 3]!; b += a;
      a += data[i + 4]!; b += a;
      a += data[i + 5]!; b += a;
      a += data[i + 6]!; b += a;
      a += data[i + 7]!; b += a;
    }
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function streamAdler32(stream: Uint8Array): number | undefined {
  const n = stream.length;
  if (n < 6) return undefined;
  return ((stream[n - 4]! << 24) | (stream[n - 3]! << 16) | (stream[n - 2]! << 8) | stream[n - 1]!) >>> 0;
}

/**
 * Returns `original` when it still holds exactly `data`, otherwise freshly
 * compresses `data`. This keeps byte-perfect round trips for untouched content
 * while staying correct when pixel buffers were edited in place.
 *
 * The check compares `data` against the Adler-32 checksum in the zlib trailer
 * (the same integrity check zlib itself relies on), which costs a single pass
 * over the bytes instead of a full decompression.
 */
export function reuseOrDeflate(
  data: Uint8Array,
  original: Uint8Array | undefined,
  level: CompressionLevel = 6,
): Uint8Array {
  if (original && streamAdler32(original) === adler32(data)) return original;
  return deflate(data, level);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
