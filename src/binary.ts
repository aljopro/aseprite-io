import { AsepriteError } from './errors.js';

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

/** Returns the UTF-8 byte length of a string. */
export function utf8Length(s: string): number {
  return textEncoder.encode(s).length;
}

/** Little-endian cursor over a byte buffer. All reads are bounds-checked. */
export class ByteReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  private take(n: number): number {
    if (n < 0 || this.pos + n > this.bytes.length) {
      throw new AsepriteError(
        'UnexpectedEof',
        `unexpected end of data: needed ${n} byte(s) at offset ${this.pos}, ${this.remaining} available`,
      );
    }
    const p = this.pos;
    this.pos += n;
    return p;
  }

  byte(): number {
    return this.view.getUint8(this.take(1));
  }
  int8(): number {
    return this.view.getInt8(this.take(1));
  }
  word(): number {
    return this.view.getUint16(this.take(2), true);
  }
  short(): number {
    return this.view.getInt16(this.take(2), true);
  }
  dword(): number {
    return this.view.getUint32(this.take(4), true);
  }
  long(): number {
    return this.view.getInt32(this.take(4), true);
  }
  long64(): bigint {
    return this.view.getBigInt64(this.take(8), true);
  }
  qword(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }
  float(): number {
    return this.view.getFloat32(this.take(4), true);
  }
  double(): number {
    return this.view.getFloat64(this.take(8), true);
  }

  /** Reads `n` bytes into a new, independent array. */
  read(n: number): Uint8Array {
    const p = this.take(n);
    return this.bytes.slice(p, p + n);
  }

  /** Returns a reader over the next `n` bytes (shares memory) and advances past them. */
  sub(n: number): ByteReader {
    const p = this.take(n);
    return new ByteReader(this.bytes.subarray(p, p + n));
  }

  /** Reads a STRING: WORD length followed by UTF-8 bytes (invalid sequences are replaced). */
  string(): string {
    const len = this.word();
    const p = this.take(len);
    return textDecoder.decode(this.bytes.subarray(p, p + len));
  }

  skip(n: number): void {
    this.take(n);
  }

  /** Reads all bytes up to the end of the buffer. */
  rest(): Uint8Array {
    return this.read(this.remaining);
  }
}

/** Growable little-endian byte buffer. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.len;
  }

  private reserve(n: number): number {
    const need = this.len + n;
    if (need > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    const p = this.len;
    this.len = need;
    return p;
  }

  byte(v: number): this {
    const p = this.reserve(1);
    this.view.setUint8(p, v);
    return this;
  }
  int8(v: number): this {
    const p = this.reserve(1);
    this.view.setInt8(p, v);
    return this;
  }
  word(v: number): this {
    const p = this.reserve(2);
    this.view.setUint16(p, v, true);
    return this;
  }
  short(v: number): this {
    const p = this.reserve(2);
    this.view.setInt16(p, v, true);
    return this;
  }
  dword(v: number): this {
    const p = this.reserve(4);
    this.view.setUint32(p, v, true);
    return this;
  }
  long(v: number): this {
    const p = this.reserve(4);
    this.view.setInt32(p, v, true);
    return this;
  }
  long64(v: bigint): this {
    const p = this.reserve(8);
    this.view.setBigInt64(p, v, true);
    return this;
  }
  qword(v: bigint): this {
    const p = this.reserve(8);
    this.view.setBigUint64(p, v, true);
    return this;
  }
  float(v: number): this {
    const p = this.reserve(4);
    this.view.setFloat32(p, v, true);
    return this;
  }
  double(v: number): this {
    const p = this.reserve(8);
    this.view.setFloat64(p, v, true);
    return this;
  }

  bytes(data: Uint8Array): this {
    const p = this.reserve(data.length);
    this.buf.set(data, p);
    return this;
  }

  zeros(n: number): this {
    const p = this.reserve(n);
    this.buf.fill(0, p, p + n);
    return this;
  }

  /** Writes a STRING: WORD byte length followed by UTF-8 bytes. */
  string(s: string): this {
    const encoded = textEncoder.encode(s);
    if (encoded.length > 0xffff) {
      throw new AsepriteError(
        'FormatLimitExceeded',
        `format limit exceeded for string length: ${encoded.length} > 65535`,
      );
    }
    this.word(encoded.length);
    return this.bytes(encoded);
  }

  /** Overwrites a DWORD previously written at `pos`. */
  patchDword(pos: number, v: number): this {
    this.view.setUint32(pos, v, true);
    return this;
  }

  /** Returns a copy of the written bytes. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
