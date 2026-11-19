import type { AsepriteFile, Cel, Color } from '../src/index.js';

/** Returns whether a layer and all of its parent groups are visible. */
export function isLayerVisible(file: AsepriteFile, index: number, hidden: ReadonlySet<number>): boolean {
  for (let i: number | undefined = index; i !== undefined; i = file.layers[i]?.parent) {
    const layer = file.layers[i];
    if (!layer || !layer.visible || hidden.has(i)) return false;
  }
  return true;
}

/** Converts one pixel at byte offset `o` of `data` to RGBA, per the file's color mode. */
function pixelToRgba(
  file: AsepriteFile,
  data: Uint8Array,
  o: number,
  isBackground: boolean,
  out: [number, number, number, number],
): void {
  switch (file.colorMode) {
    case 'rgba':
      out[0] = data[o]!;
      out[1] = data[o + 1]!;
      out[2] = data[o + 2]!;
      out[3] = data[o + 3]!;
      return;
    case 'grayscale':
      out[0] = out[1] = out[2] = data[o]!;
      out[3] = data[o + 1]!;
      return;
    case 'indexed': {
      const index = data[o]!;
      const c: Color | undefined = file.palette[index];
      if (!c || (index === file.transparentIndex && !isBackground)) {
        out[3] = 0;
        return;
      }
      out[0] = c.r;
      out[1] = c.g;
      out[2] = c.b;
      out[3] = c.a;
    }
  }
}

/** Source-over blend of one RGBA pixel into `dst` at byte offset `d`. */
function blend(dst: Uint8ClampedArray, d: number, src: [number, number, number, number], opacity: number): void {
  const sa = (src[3] / 255) * opacity;
  if (sa <= 0) return;
  const da = dst[d + 3]! / 255;
  const oa = sa + da * (1 - sa);
  for (let k = 0; k < 3; k++) {
    dst[d + k] = (src[k]! * sa + dst[d + k]! * da * (1 - sa)) / oa;
  }
  dst[d + 3] = oa * 255;
}

/**
 * Composites one frame with normal blending (other blend modes are drawn as
 * normal). This lives in the demo, not the library: aseprite-io only parses
 * and writes files.
 */
export function renderFrame(file: AsepriteFile, frame: number, hidden: ReadonlySet<number> = new Set()): ImageData {
  const image = new ImageData(file.width, file.height);
  const dst = image.data;
  const bpp = file.colorMode === 'rgba' ? 4 : file.colorMode === 'grayscale' ? 2 : 1;
  const px: [number, number, number, number] = [0, 0, 0, 0];
  const layerOpacityValid = (file.flags & 1) !== 0;

  // Draw cels bottom to top, ordered by layer index plus z-index.
  const cels: Array<{ layer: number; cel: Cel; order: number }> = [];
  file.layers.forEach((layer, index) => {
    if (layer.kind.type === 'group' || !isLayerVisible(file, index, hidden)) return;
    const cel = file.resolveCel(index, frame);
    const own = file.cel(index, frame);
    if (cel && own) cels.push({ layer: index, cel, order: index + own.zIndex });
  });
  cels.sort((a, b) => a.order - b.order || a.layer - b.layer);

  for (const { layer: li, cel } of cels) {
    const layer = file.layers[li]!;
    const own = file.cel(li, frame)!;
    const opacity = (own.opacity / 255) * (layerOpacityValid ? layer.opacity / 255 : 1);
    const kind = cel.kind;
    // Linked cels keep their own position.
    const pos = own.kind.type === 'linked' ? own.kind : kind;
    if (kind.type === 'raw' || kind.type === 'compressed') {
      const { data, width, height } = kind.pixels;
      for (let y = 0; y < height; y++) {
        const cy = pos.y + y;
        if (cy < 0 || cy >= file.height) continue;
        for (let x = 0; x < width; x++) {
          const cx = pos.x + x;
          if (cx < 0 || cx >= file.width) continue;
          pixelToRgba(file, data, (y * width + x) * bpp, layer.background, px);
          blend(dst, (cy * file.width + cx) * 4, px, opacity);
        }
      }
    } else if (kind.type === 'tilemap' && layer.kind.type === 'tilemap') {
      const tileset = file.tilesets[layer.kind.tilesetIndex];
      if (!tileset || tileset.data.type !== 'embedded') continue;
      const { tileWidth: tw, tileHeight: th } = tileset;
      const tilePixels = tileset.data.pixels;
      for (let ty = 0; ty < kind.height; ty++) {
        for (let tx = 0; tx < kind.width; tx++) {
          const entry = kind.tiles[ty * kind.width + tx] ?? 0;
          const id = entry & kind.tileIdBitmask;
          // Modern Aseprite always treats tile 0 as the empty tile.
          if (id === 0 || id >= tileset.tileCount) continue;
          const flipX = (entry & kind.xFlipBitmask) !== 0;
          const flipY = (entry & kind.yFlipBitmask) !== 0;
          for (let y = 0; y < th; y++) {
            const cy = pos.y + ty * th + y;
            if (cy < 0 || cy >= file.height) continue;
            for (let x = 0; x < tw; x++) {
              const cx = pos.x + tx * tw + x;
              if (cx < 0 || cx >= file.width) continue;
              const sx = flipX ? tw - 1 - x : x;
              const sy = flipY ? th - 1 - y : y;
              pixelToRgba(file, tilePixels, ((id * th + sy) * tw + sx) * bpp, false, px);
              blend(dst, (cy * file.width + cx) * 4, px, opacity);
            }
          }
        }
      }
    }
  }
  return image;
}
