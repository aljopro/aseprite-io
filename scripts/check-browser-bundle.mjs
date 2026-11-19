// Verifies the published ESM build bundles for the browser with no Node.js
// built-ins, and that the bundle round-trips a fixture in a browser-like
// environment (no `require`, `Buffer`, `process` or `node:` modules).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const result = await build({
  stdin: {
    contents: `
      import { AsepriteFile, createPixels } from './dist/index.js';
      globalThis.__run = (bytes) => {
        const out = AsepriteFile.read(bytes).write();
        const f = new AsepriteFile(2, 2, 'rgba');
        const l = f.addLayer('L');
        f.addFrame(100);
        f.setCel(l, 0, createPixels(new Uint8Array(16).fill(255), 2, 2, 'rgba'));
        const again = AsepriteFile.read(f.write());
        return { same: out.length === bytes.length && out.every((b, i) => b === bytes[i]), layers: again.layers.length };
      };`,
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  minify: true,
  metafile: true,
  logLevel: 'error',
});

const code = result.outputFiles[0].text;
const inputs = Object.keys(result.metafile.inputs);
const nodeish = inputs.filter((p) => p.startsWith('node:') || /(^|\/)(fs|path|zlib|buffer)$/.test(p));
if (nodeish.length) throw new Error(`browser bundle pulls in Node modules: ${nodeish.join(', ')}`);

// Run in a bare context that only has standard web/JS globals.
const sandbox = { TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const fixture = new Uint8Array(readFileSync('test/fixtures/file-tests-props.aseprite'));
const res = sandbox.__run(new sandbox.Uint8Array(fixture));
if (!res.same || res.layers !== 1) throw new Error(`browser sandbox run failed: ${JSON.stringify(res)}`);

console.log(`browser bundle OK: ${(code.length / 1024).toFixed(1)} KiB minified, inputs: ${inputs.length}, no Node built-ins`);
