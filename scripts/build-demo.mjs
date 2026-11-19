// Builds the demo into site/ (deployed to GitHub Pages together with the API docs in site/api/).
// `--serve` starts a local server with live rebuilds at http://127.0.0.1:5179.
import { context } from 'esbuild';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';

const serve = process.argv.includes('--serve');
mkdirSync('site/samples', { recursive: true });
cpSync('demo/index.html', 'site/index.html');
cpSync('demo/style.css', 'site/style.css');
for (const f of readdirSync('test/fixtures')) {
  if (f.endsWith('.aseprite')) cpSync(`test/fixtures/${f}`, `site/samples/${f}`);
}

const ctx = await context({
  entryPoints: { main: 'demo/main.ts' },
  outdir: 'site',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: !serve,
  sourcemap: true,
  logLevel: 'info',
});

if (serve) {
  await ctx.watch();
  const { host, port } = await ctx.serve({ servedir: 'site', host: '127.0.0.1', port: 5179 });
  console.log(`demo: http://${host}:${port}/`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
