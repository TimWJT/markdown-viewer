import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const OUT_NAME = 'Markdown Viewer.html';

const js = await build({
  entryPoints: [join(here, 'src/main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome110', 'firefox110', 'safari16'],
  legalComments: 'none',
  write: false,
});

const css = await build({
  entryPoints: [join(here, 'src/app.css')],
  minify: true,
  loader: { '.css': 'css' },
  write: false,
});

const bundleJs = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const bundleCss = css.outputFiles[0].text;
const tpl = await readFile(join(here, 'src/index.html'), 'utf8');

const html = tpl
  .replace('/*__CSS__*/', () => bundleCss)
  .replace('/*__JS__*/', () => bundleJs);

await mkdir(out, { recursive: true });
// index.html is what Tauri bundles; the named copy is the standalone download.
await writeFile(join(out, 'index.html'), html, 'utf8');
await writeFile(join(out, OUT_NAME), html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`built dist/index.html + dist/${OUT_NAME}  (${kb} KB, single file, zero network)`);
