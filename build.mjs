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

const mermaidBundle = await build({
  entryPoints: [join(here, 'src/mermaid-entry.js')],
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

// Two shapes from one template:
//
//   index.html + app.css + app.js  -> what Tauri bundles. Keeping the script
//     external lets the packaged app run under a strict `script-src 'self'`
//     CSP, which matters for a program that renders untrusted files.
//   Markdown Viewer.html           -> everything inlined, the standalone
//     download that works from file:// with no server and no siblings.
const inlined = tpl
  .replace('/*__CSS__*/', () => bundleCss)
  .replace('/*__JS__*/', () => bundleJs);

const external = tpl
  .replace('<style>/*__CSS__*/</style>', '<link rel="stylesheet" href="app.css">')
  .replace('<script>/*__JS__*/</script>', '<script src="app.js" defer></script>');

if (external.includes('__CSS__') || external.includes('__JS__')) {
  throw new Error('template markers changed — the external build did not substitute');
}

await mkdir(out, { recursive: true });
await writeFile(join(out, 'index.html'), external, 'utf8');
await writeFile(join(out, 'app.css'), bundleCss, 'utf8');
await writeFile(join(out, 'app.js'), bundleJs, 'utf8');
await writeFile(join(out, OUT_NAME), inlined, 'utf8');
await writeFile(join(out, 'mermaid.js'), mermaidBundle.outputFiles[0].text, 'utf8');

const kb = (Buffer.byteLength(inlined, 'utf8') / 1024).toFixed(0);
console.log(`built dist/  ->  index.html + app.css + app.js (packaged app)`);
const mkb = (Buffer.byteLength(mermaidBundle.outputFiles[0].text, 'utf8') / 1024).toFixed(0);
console.log(`              ->  ${OUT_NAME} (${kb} KB standalone, zero network)`);
console.log(`              ->  mermaid.js (${mkb} KB, lazy-loaded by the packaged app only)`);
