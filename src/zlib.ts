import { Inflate as PakoInflate, deflate as pakoDeflate } from 'pako';
import { zlibSync } from 'fflate';
import { AsepriteError } from './errors.js';
/** Limits applied while parsing untrusted ASE bytes. */
export interface ReadLimits {
  /** Maximum complete input file size; defaults to 128 MiB. */
  maxInputBytes: number;
  /** Maximum decoded cel or embedded tileset data; defaults to 64 MiB. */
  maxDecodedBytes: number;
  /** Maximum aggregate decoded allocations; defaults to 256 MiB. */
  maxTotalDecodedBytes: number;
  /** Maximum canvas, cel, or tileset dimension; defaults to 16,384. */
  maxDimension: number;
}

/**
 * Decompress exactly `expectedSize` bytes with a bounded output buffer.
 *
 * The decoder emits output in fixed-size chunks and inflation stops as soon as
 * a chunk would not fit, so a stream that expands far beyond its declared size
 * costs one chunk of memory instead of its full expansion. The complete zlib
 * stream must consume the input and its checksum must match the decoded bytes.
 */
export function inflate(data: Uint8Array, expectedSize: number): Uint8Array {
  try {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || data.length < 6) {
      throw new Error('invalid zlib stream or decoded size');
    }
    const output = new Uint8Array(expectedSize);
    let offset = 0;
    const decoder = new PakoInflate({ chunkSize: 16 * 1024 });
    let stream: Parameters<typeof decoder.onStart>[0] | undefined;
    decoder.onStart = (state) => { stream = state; };
    decoder.onData = (chunk) => {
      const bytes = chunk as Uint8Array;
      if (bytes.length > expectedSize - offset) {
        throw new Error(`decoded data exceeds the declared ${expectedSize} bytes`);
      }
      output.set(bytes, offset);
      offset += bytes.length;
    };
    decoder.push(data, true);
    if (decoder.err !== 0) {
      throw new Error(decoder.msg || 'invalid or truncated zlib stream');
    }
    if (!stream || stream.avail_in !== 0) {
      throw new Error('trailing bytes after zlib stream');
    }
    if (offset !== expectedSize) {
      throw new Error(`decoded ${offset} bytes, expected ${expectedSize}`);
    }
    if (streamAdler32(data) !== adler32(output)) {
      throw new Error('zlib checksum does not match the decoded data');
    }
    return output;
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
  // fflate's store mode (level 0) marks a full 65,535-byte block as final and
  // then appends an empty final block, so strict zlib decoders reject payloads
  // whose length is a multiple of 65,535. pako writes valid stored blocks.
  if (level === 0) return pakoDeflate(data, { level: 0 });
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
 * Adler-32 is a fast rejection only; equal checksums still require an exact
 * byte comparison because collisions are possible.
 */
export function reuseOrDeflate(
  data: Uint8Array,
  original: Uint8Array | undefined,
  level: CompressionLevel = 6,
): Uint8Array {
  if (original && streamAdler32(original) === adler32(data)) {
    try {
      if (bytesEqual(inflate(original, data.length), data)) return original;
    } catch {
      // Invalid stale streams must be recompressed, not reused.
    }
  }
  return deflate(data, level);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
