import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AsepriteFile } from '../src/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.aseprite'));

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

describe('byte-perfect round trip', () => {
  it('has fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
  });

  for (const name of fixtures) {
    it(name, () => {
      const original = new Uint8Array(readFileSync(join(FIXTURES, name)));
      const output = AsepriteFile.read(original).write();
      const diff = firstDiff(original, output);
      expect(diff, `first diff at byte ${diff} (lengths ${original.length} vs ${output.length})`).toBe(-1);
    });

    it(`${name} (read → write → read is stable)`, () => {
      const original = new Uint8Array(readFileSync(join(FIXTURES, name)));
      const once = AsepriteFile.read(original).write();
      const twice = AsepriteFile.read(once).write();
      expect(twice).toEqual(once);
    });
  }

  it('accepts ArrayBuffer and DataView input', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'abcd.aseprite')));
    const copy = bytes.slice().buffer;
    expect(AsepriteFile.read(copy).write()).toEqual(bytes);
    expect(AsepriteFile.read(new DataView(copy)).write()).toEqual(bytes);
  });

  it('re-compresses cels whose pixels were edited after reading', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'abcd.aseprite')));
    const file = AsepriteFile.read(bytes);
    const entry = [...file.cels()].find((e) => e.cel.kind.type === 'compressed');
    expect(entry).toBeDefined();
    const kind = entry!.cel.kind;
    if (kind.type !== 'compressed') throw new Error('unreachable');
    kind.pixels.data.fill(7); // mutate in place, leaving originalCompressed stale
    const out = AsepriteFile.read(file.write());
    const cel = out.cel(entry!.layer, entry!.frame)!;
    if (cel.kind.type !== 'compressed') throw new Error('expected compressed cel');
    expect(cel.kind.pixels.data.every((b) => b === 7)).toBe(true);
  });

  it('does not reuse compressed pixels after an Adler-32 collision edit', () => {
    const file = new AsepriteFile(1, 1, 'rgba');
    const layer = file.addLayer('L');
    file.addFrame(100);
    file.setCel(layer, 0, { data: new Uint8Array([10, 10, 10, 10]), width: 1, height: 1 });
    const read = AsepriteFile.read(file.write());
    const kind = read.cel(layer, 0)!.kind;
    if (kind.type !== 'compressed') throw new Error('expected compressed cel');
    kind.pixels.data.set([11, 8, 11, 10]);
    const result = AsepriteFile.read(read.write()).cel(layer, 0)!.kind;
    if (result.type !== 'compressed') throw new Error('expected compressed cel');
    expect(result.pixels.data).toEqual(new Uint8Array([11, 8, 11, 10]));
  });

  it('keeps layers added to a file that was read', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'groups2.aseprite')));
    const file = AsepriteFile.read(bytes);
    const before = file.layers.length;
    file.addLayer('Added later');
    const out = AsepriteFile.read(file.write());
    expect(out.layers.length).toBe(before + 1);
    expect(out.layers[out.layers.length - 1]!.name).toBe('Added later');
  });
});
