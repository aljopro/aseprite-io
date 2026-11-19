import { AsepriteError, AsepriteFile, createPixels, type LayerRef } from '../src/index.js';
import { isLayerVisible, renderFrame } from './render.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SAMPLES = [
  'abcd', 'groups3abc', 'tags3x123reps', 'link', 'slices-moving', '2x2tilemap2x2tile',
  '3x2tilemap-grayscale', '4f-index-4x4', 'point4frames', 'file-tests-props', 'cut_paste',
];

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function selectTab(name: 'viewer' | 'stack'): void {
  for (const t of ['viewer', 'stack'] as const) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
  if (name === 'stack') stack.refreshAll();
}
$('tab-viewer').addEventListener('click', () => selectTab('viewer'));
$('tab-stack').addEventListener('click', () => selectTab('stack'));

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

const viewer = (() => {
  const canvas = $<HTMLCanvasElement>('view-canvas');
  const ctx = canvas.getContext('2d')!;
  const scrub = $<HTMLInputElement>('scrub');
  const playBtn = $<HTMLButtonElement>('play');
  const zoom = $<HTMLInputElement>('zoom');
  let file: AsepriteFile | undefined;
  let bytes: Uint8Array | undefined;
  let name = 'sprite.aseprite';
  let frame = 0;
  let range: [number, number] = [0, 0];
  let timer: number | undefined;
  const hidden = new Set<number>();

  function draw(): void {
    if (!file) return;
    ctx.putImageData(renderFrame(file, frame, hidden), 0, 0);
    scrub.value = String(frame);
    $('frame-label').textContent = `${frame + 1}/${file.frames.length} · ${file.frames[frame]!.durationMs}ms`;
  }

  function applyZoom(): void {
    if (!file) return;
    const z = Number(zoom.value);
    canvas.style.width = `${file.width * z}px`;
    canvas.style.height = `${file.height * z}px`;
  }

  function stop(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    playBtn.textContent = '▶ Play';
  }

  function play(from = range[0], to = range[1]): void {
    if (!file) return;
    stop();
    range = [from, to];
    frame = from;
    playBtn.textContent = '❚❚ Pause';
    const tick = () => {
      draw();
      timer = window.setTimeout(() => {
        frame = frame >= range[1] ? range[0] : frame + 1;
        tick();
      }, Math.max(16, file!.frames[frame]!.durationMs));
    };
    tick();
  }

  function renderSidebar(): void {
    if (!file) return;
    const f = file;
    const info: Array<[string, string]> = [
      ['Name', name],
      ['Size', `${f.width} × ${f.height}`],
      ['Color mode', f.colorMode],
      ['Frames', String(f.frames.length)],
      ['Layers', String(f.layers.length)],
      ['Cels', String([...f.cels()].length)],
      ['Tilesets', String(f.tilesets.length)],
      ['Slices', String(f.slices.length)],
      ['Bytes', bytes ? bytes.length.toLocaleString() : '–'],
    ];
    $('info').replaceChildren(
      ...info.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );

    // Layers, top-most first, indented by depth.
    const layerList = $('layers');
    layerList.replaceChildren();
    for (let i = f.layers.length - 1; i >= 0; i--) {
      const layer = f.layers[i]!;
      let depth = 0;
      for (let p = layer.parent; p !== undefined; p = f.layers[p]?.parent) depth++;
      const li = document.createElement('li');
      li.style.paddingLeft = `${depth * 14}px`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = layer.visible && !hidden.has(i);
      cb.disabled = !layer.visible;
      cb.title = layer.visible ? 'Toggle visibility' : 'Hidden in the file';
      cb.addEventListener('change', () => {
        if (cb.checked) hidden.delete(i);
        else hidden.add(i);
        draw();
      });
      const label = document.createElement('span');
      label.textContent = layer.name || '(unnamed)';
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = layer.kind.type === 'normal' ? layer.blendMode : layer.kind.type;
      li.append(cb, label, kind);
      layerList.append(li);
    }

    // Tags: click to loop that range.
    const tagList = $('tags');
    tagList.replaceChildren();
    if (f.tags.length === 0) tagList.innerHTML = '<li class="muted">None</li>';
    for (const tag of f.tags) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'link';
      btn.textContent = `▶ ${tag.name}`;
      btn.addEventListener('click', () => play(tag.fromFrame, tag.toFrame));
      const meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = `${tag.fromFrame + 1}–${tag.toFrame + 1} · ${tag.direction}`;
      li.append(btn, meta);
      tagList.append(li);
    }

    const paletteCard = $('palette-card');
    paletteCard.hidden = f.palette.length === 0;
    $('palette').replaceChildren(
      ...f.palette.slice(0, 256).map((c, i) => {
        const s = document.createElement('span');
        s.style.background = `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;
        s.title = `#${i}${c.name ? ` ${c.name}` : ''}`;
        return s;
      }),
    );
  }

  function load(input: Uint8Array, fileName: string): void {
    stop();
    const note = $('roundtrip');
    try {
      file = AsepriteFile.read(input);
    } catch (e) {
      note.className = 'note bad';
      note.textContent = e instanceof AsepriteError ? `Could not read file (${e.code}): ${e.message}` : String(e);
      return;
    }
    bytes = input;
    name = fileName;
    hidden.clear();
    frame = 0;
    range = [0, file.frames.length - 1];
    canvas.width = file.width;
    canvas.height = file.height;
    canvas.classList.add('checker');
    $('drop').classList.add('loaded');
    scrub.max = String(Math.max(0, file.frames.length - 1));
    scrub.disabled = playBtn.disabled = file.frames.length < 1;
    $<HTMLButtonElement>('download').disabled = false;
    zoom.value = String(Math.max(1, Math.min(64, Math.floor(480 / Math.max(file.width, file.height)))));
    applyZoom();
    renderSidebar();
    draw();

    // Round-trip check: write the parsed file back and compare bytes.
    const out = file.write();
    const same = out.length === input.length && out.every((b, i) => b === input[i]);
    note.className = `note ${same ? 'ok' : 'bad'}`;
    note.textContent = same
      ? '✓ Re-encoding produces byte-identical output.'
      : `Re-encoded output differs from the input (${out.length} vs ${input.length} bytes).`;
    if (file.frames.length > 1) play();
  }

  async function loadUrl(url: string, fileName: string): Promise<void> {
    const res = await fetch(url);
    load(new Uint8Array(await res.arrayBuffer()), fileName);
  }

  async function loadBlob(blob: Blob, fileName: string): Promise<void> {
    load(new Uint8Array(await blob.arrayBuffer()), fileName);
  }

  // Wiring
  scrub.addEventListener('input', () => {
    stop();
    frame = Number(scrub.value);
    draw();
  });
  playBtn.addEventListener('click', () => (timer === undefined ? play(0, (file?.frames.length ?? 1) - 1) : stop()));
  zoom.addEventListener('input', applyZoom);
  $<HTMLInputElement>('file-input').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void loadBlob(f, f.name);
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    const f = e.dataTransfer?.files[0];
    if (f) void loadBlob(f, f.name);
  });
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') $('file-input').click();
  });
  $('download').addEventListener('click', () => {
    if (file) downloadBytes(file.write(), name.replace(/(\.ase(prite)?)?$/i, '.aseprite'));
  });
  const samples = $<HTMLSelectElement>('samples');
  samples.innerHTML =
    '<option value="">Choose a sample…</option>' +
    SAMPLES.map((s) => `<option value="${s}">${s}.aseprite</option>`).join('');
  samples.addEventListener('change', () => {
    if (samples.value) void loadUrl(`./samples/${samples.value}.aseprite`, `${samples.value}.aseprite`);
  });

  return { load, loadUrl, isVisible: (i: number) => (file ? isLayerVisible(file, i, hidden) : false) };
})();

function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Canvas → Aseprite: paintable layer canvases stacked into one sprite
// ---------------------------------------------------------------------------

const SIZE = 24;
const COLORS = [
  '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
  '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
];

interface StackLayer {
  name: string;
  visible: boolean;
  opacity: number;
  /** One RGBA buffer per frame. */
  frames: Uint8ClampedArray[];
}

const stack = (() => {
  const layers: StackLayer[] = [];
  let frameCount = 1;
  let current = 0;
  let active = 0;
  let color = COLORS[6]!;
  let erasing = false;
  let timer: number | undefined;

  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

  function blank(): Uint8ClampedArray {
    return new Uint8ClampedArray(SIZE * SIZE * 4);
  }

  function paint(buf: Uint8ClampedArray, x: number, y: number, c: string | null): void {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const o = (y * SIZE + x) * 4;
    if (c === null) buf.fill(0, o, o + 4);
    else buf.set([...hex(c), 255], o);
  }

  // A small starter scene so the stacking is obvious right away.
  function seed(): void {
    const sky = { name: 'Sky', visible: true, opacity: 255, frames: [blank()] };
    const hills = { name: 'Hills', visible: true, opacity: 255, frames: [blank()] };
    const hero = { name: 'Hero', visible: true, opacity: 255, frames: [blank()] };
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) paint(sky.frames[0]!, x, y, y < 8 ? '#41a6f6' : y < 14 ? '#73eff7' : '#94b0c2');
    }
    for (let x = 0; x < SIZE; x++) {
      const h = 15 + Math.round(2 * Math.sin(x / 3));
      for (let y = h; y < SIZE; y++) paint(hills.frames[0]!, x, y, y === h ? '#a7f070' : '#38b764');
    }
    for (const [x, y] of [[4, 3], [5, 3], [6, 3], [5, 2], [4, 4], [5, 4], [6, 4], [7, 4]]) paint(sky.frames[0]!, x!, y!, '#f4f4f4');
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) paint(sky.frames[0]!, 18 + x, 2 + y, '#ffcd75');
    const body: Array<[number, number, string]> = [
      [11, 10, '#1a1c2c'], [12, 10, '#1a1c2c'], [11, 11, '#ffcd75'], [12, 11, '#ffcd75'],
      [10, 12, '#b13e53'], [11, 12, '#b13e53'], [12, 12, '#b13e53'], [13, 12, '#b13e53'],
      [11, 13, '#b13e53'], [12, 13, '#b13e53'], [11, 14, '#29366f'], [12, 14, '#29366f'],
      [11, 15, '#333c57'], [12, 15, '#333c57'],
    ];
    for (const [x, y, c] of body) paint(hero.frames[0]!, x, y, c);
    layers.push(sky, hills, hero);
    // Second frame: the hero hops.
    addFrame();
    const hop = blank();
    for (const [x, y, c] of body) paint(hop, x, y - 2, c);
    hero.frames[1] = hop;
    current = 0;
    active = 2;
  }

  function addFrame(): void {
    for (const l of layers) l.frames.splice(current + 1, 0, new Uint8ClampedArray(l.frames[current]!));
    frameCount++;
    current++;
  }

  function deleteFrame(): void {
    if (frameCount <= 1) return;
    for (const l of layers) l.frames.splice(current, 1);
    frameCount--;
    current = Math.min(current, frameCount - 1);
  }

  function toImage(buf: Uint8ClampedArray): ImageData {
    return new ImageData(new Uint8ClampedArray(buf), SIZE, SIZE);
  }

  // --- Layer cards (one paintable canvas per layer, top-most first) ---
  function renderLayerCards(): void {
    const container = $('layer-canvases');
    container.replaceChildren();
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      const card = document.createElement('div');
      card.className = `layer-card${i === active ? ' active' : ''}`;
      const header = document.createElement('header');
      const nameInput = Object.assign(document.createElement('input'), { type: 'text', value: layer.name });
      nameInput.setAttribute('aria-label', 'Layer name');
      nameInput.addEventListener('input', () => {
        layer.name = nameInput.value;
        updateCode();
      });
      const eye = Object.assign(document.createElement('button'), {
        className: 'icon',
        textContent: layer.visible ? '👁' : '◌',
        title: 'Toggle visibility',
      });
      eye.addEventListener('click', () => {
        layer.visible = !layer.visible;
        refreshAll();
      });
      const up = Object.assign(document.createElement('button'), { className: 'icon', textContent: '↑', title: 'Move up' });
      up.disabled = i === layers.length - 1;
      up.addEventListener('click', () => moveLayer(i, i + 1));
      const down = Object.assign(document.createElement('button'), { className: 'icon', textContent: '↓', title: 'Move down' });
      down.disabled = i === 0;
      down.addEventListener('click', () => moveLayer(i, i - 1));
      const del = Object.assign(document.createElement('button'), { className: 'icon', textContent: '✕', title: 'Delete layer' });
      del.disabled = layers.length <= 1;
      del.addEventListener('click', () => {
        layers.splice(i, 1);
        active = Math.min(active, layers.length - 1);
        refreshAll();
      });
      header.append(nameInput, eye, up, down, del);

      const canvas = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
      canvas.className = 'checker';
      canvas.getContext('2d')!.putImageData(toImage(layer.frames[current]!), 0, 0);
      attachPainter(canvas, i);

      const opacity = document.createElement('label');
      opacity.className = 'opacity';
      const slider = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '255', value: String(layer.opacity) });
      slider.addEventListener('input', () => {
        layer.opacity = Number(slider.value);
        renderPreview();
      });
      opacity.append('Opacity', slider);
      card.append(header, canvas, opacity);
      card.addEventListener('pointerdown', () => {
        if (active !== i) {
          active = i;
          for (const c of container.children) c.classList.remove('active');
          card.classList.add('active');
        }
      });
      container.append(card);
    }
  }

  function moveLayer(from: number, to: number): void {
    const [l] = layers.splice(from, 1);
    layers.splice(to, 0, l!);
    active = to;
    refreshAll();
  }

  function attachPainter(canvas: HTMLCanvasElement, index: number): void {
    let down = false;
    let last: [number, number] | undefined;
    const at = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [Math.floor(((e.clientX - r.left) / r.width) * SIZE), Math.floor(((e.clientY - r.top) / r.height) * SIZE)];
    };
    const stroke = (e: PointerEvent) => {
      const [x, y] = at(e);
      const buf = layers[index]!.frames[current]!;
      // Interpolate so fast strokes stay continuous.
      const [lx, ly] = last ?? [x, y];
      const steps = Math.max(Math.abs(x - lx), Math.abs(y - ly), 1);
      for (let s = 0; s <= steps; s++) {
        paint(buf, Math.round(lx + ((x - lx) * s) / steps), Math.round(ly + ((y - ly) * s) / steps), erasing ? null : color);
      }
      last = [x, y];
      canvas.getContext('2d')!.putImageData(toImage(buf), 0, 0);
      renderPreview();
    };
    canvas.addEventListener('pointerdown', (e) => {
      down = true;
      last = undefined;
      canvas.setPointerCapture(e.pointerId);
      stroke(e);
    });
    canvas.addEventListener('pointermove', (e) => down && stroke(e));
    canvas.addEventListener('pointerup', () => {
      down = false;
      renderFrameStrip();
    });
  }

  // --- Stacked preview: one canvas element per layer, absolutely stacked ---
  function renderPreview(): void {
    const preview = $('stack-preview');
    const exploded = $<HTMLInputElement>('explode').checked;
    preview.classList.toggle('exploded', exploded);
    preview.classList.toggle('checker', !exploded);
    while (preview.children.length < layers.length) {
      preview.append(Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE }));
    }
    while (preview.children.length > layers.length) preview.lastElementChild!.remove();
    layers.forEach((layer, i) => {
      const c = preview.children[i] as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.putImageData(toImage(layer.frames[current]!), 0, 0);
      c.style.opacity = layer.visible ? String(layer.opacity / 255) : '0';
      c.style.zIndex = String(i);
      const mid = (layers.length - 1) / 2;
      c.style.transform = exploded
        ? `rotateX(55deg) rotateZ(-35deg) translateZ(${(i - mid) * 60}px) scale(0.7)`
        : 'none';
    });
  }

  function renderFrameStrip(): void {
    const strip = $('frame-strip');
    strip.replaceChildren();
    for (let f = 0; f < frameCount; f++) {
      const btn = document.createElement('button');
      btn.className = 'checker';
      btn.setAttribute('aria-current', String(f === current));
      btn.title = `Frame ${f + 1}`;
      const c = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
      const ctx = c.getContext('2d')!;
      for (const l of layers) {
        if (!l.visible) continue;
        const tmp = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
        tmp.getContext('2d')!.putImageData(toImage(l.frames[f]!), 0, 0);
        ctx.globalAlpha = l.opacity / 255;
        ctx.drawImage(tmp, 0, 0);
      }
      const label = document.createElement('span');
      label.textContent = String(f + 1);
      btn.append(c, label);
      btn.addEventListener('click', () => {
        stop();
        current = f;
        refreshAll();
      });
      strip.append(btn);
    }
  }

  // --- Building the .aseprite file with aseprite-io ---
  function build(): AsepriteFile {
    const duration = Number($<HTMLInputElement>('duration').value) || 150;
    const file = new AsepriteFile(SIZE, SIZE, 'rgba');
    const refs: LayerRef[] = layers.map((l) => file.addLayer(l.name || 'Layer', { visible: l.visible, opacity: l.opacity }));
    for (let f = 0; f < frameCount; f++) file.addFrame(duration);
    layers.forEach((layer, li) => {
      for (let f = 0; f < frameCount; f++) {
        const data = new Uint8Array(layer.frames[f]!);
        if (data.every((b) => b === 0)) continue; // empty canvas → no cel
        const prev = f > 0 ? layer.frames[f - 1]! : undefined;
        if (prev && prev.every((b, i) => b === data[i]) && file.cel(refs[li]!, f - 1)) {
          file.setLinkedCel(refs[li]!, f, f - 1); // unchanged → linked cel, like Aseprite does
        } else {
          file.setCel(refs[li]!, f, createPixels(data, SIZE, SIZE, 'rgba'));
        }
      }
    });
    if (frameCount > 1) file.addTag('loop', 0, frameCount - 1, 'forward');
    return file;
  }

  function updateCode(): void {
    const names = layers.map((l) => JSON.stringify(l.name || 'Layer')).join(', ');
    $('code').textContent = [
      `import { AsepriteFile, createPixels } from 'aseprite-io';`,
      ``,
      `const file = new AsepriteFile(${SIZE}, ${SIZE}, 'rgba');`,
      `const layers = [${names}]`,
      `  .map((name) => file.addLayer(name));`,
      `for (let f = 0; f < ${frameCount}; f++) file.addFrame(150);`,
      ``,
      `// one cel per (layer, frame) from each canvas:`,
      `const { data } = ctx.getImageData(0, 0, ${SIZE}, ${SIZE});`,
      `file.setCel(layers[i], frame,`,
      `  createPixels(new Uint8Array(data.buffer), ${SIZE}, ${SIZE}, 'rgba'));`,
      frameCount > 1 ? `file.addTag('loop', 0, ${frameCount - 1});` : '',
      ``,
      `const bytes = file.write(); // Uint8Array, ready to save`,
    ].join('\n');
  }

  function stop(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    $('stack-play').textContent = '▶ Play';
  }

  function refreshAll(): void {
    renderLayerCards();
    renderPreview();
    renderFrameStrip();
    updateCode();
  }

  // Wiring
  const swatches = $('swatches');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.style.background = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === color));
    b.setAttribute('aria-label', c);
    b.addEventListener('click', () => {
      color = c;
      erasing = false;
      $('eraser').setAttribute('aria-pressed', 'false');
      for (const s of swatches.children) s.setAttribute('aria-checked', String(s === b));
    });
    swatches.append(b);
  }
  $('eraser').addEventListener('click', (e) => {
    erasing = !erasing;
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(erasing));
  });
  $('clear-layer').addEventListener('click', () => {
    layers[active]?.frames[current]!.fill(0);
    refreshAll();
  });
  $('add-layer').addEventListener('click', () => {
    layers.push({ name: `Layer ${layers.length + 1}`, visible: true, opacity: 255, frames: Array.from({ length: frameCount }, blank) });
    active = layers.length - 1;
    refreshAll();
  });
  $('add-frame').addEventListener('click', () => {
    stop();
    addFrame();
    refreshAll();
  });
  $('del-frame').addEventListener('click', () => {
    stop();
    deleteFrame();
    refreshAll();
  });
  $('stack-play').addEventListener('click', () => {
    if (timer !== undefined) return stop();
    $('stack-play').textContent = '❚❚ Pause';
    timer = window.setInterval(() => {
      current = (current + 1) % frameCount;
      renderPreview();
      for (const [i, b] of [...$('frame-strip').children].entries()) b.setAttribute('aria-current', String(i === current));
    }, Number($<HTMLInputElement>('duration').value) || 150);
  });
  $('explode').addEventListener('change', renderPreview);
  $('export').addEventListener('click', () => downloadBytes(build().write(), 'stacked.aseprite'));
  $('open-in-viewer').addEventListener('click', () => {
    stop();
    viewer.load(build().write(), 'stacked.aseprite');
    selectTab('viewer');
  });

  seed();
  return { refreshAll };
})();

// Start with a sample in the viewer, or the builder when linked with #stack.
if (location.hash === '#stack') selectTab('stack');
else void viewer.loadUrl('./samples/tags3x123reps.aseprite', 'tags3x123reps.aseprite');
