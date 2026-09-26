import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Tauri's `frontendDist` is "../dist", so *everything* in here ships inside the
// installer. Only the files the packaged app actually loads may land in it.
const out = join(here, 'dist');
// The standalone single-file download is a build artefact for humans, not an app
// input, so it goes to a sibling directory Tauri never looks at.
const standaloneOut = join(here, 'dist-standalone');
const OUT_NAME = 'Markdown Viewer.html';

// Guard against ever deleting anything other than our own output directory.
for (const [label, dir] of [['dist', out], ['dist-standalone', standaloneOut]]) {
  if (resolve(dir) !== join(here, label) || resolve(dir) === resolve(here)) {
    throw new Error(`refusing to clean ${resolve(dir)} — not the ${label} output directory`);
  }
}

const js = await build({
  entryPoints: [join(here, 'src/main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome110', 'firefox110', 'safari16'],
  legalComments: 'none',
  write: false,
});

const startup = await build({
  entryPoints: [join(here, 'src/startup.js')],
  minify: true,
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

// The bundles go to disk verbatim. `<\/script` is only meaningful inside a JS
// string literal, so escaping it in a file that is loaded as a script would
// corrupt any future `</script` appearing in a regex literal.
const bundleJs = js.outputFiles[0].text;
const bundleStartup = startup.outputFiles[0].text;
const bundleCss = css.outputFiles[0].text;
// Escape only the copies that get inlined into a <script> block, where a literal
// `</script` would otherwise end the element early.
const inlineJs = bundleJs.replace(/<\/script/gi, '<\\/script');
const inlineStartup = bundleStartup.replace(/<\/script/gi, '<\\/script');
const tpl = await readFile(join(here, 'src/index.html'), 'utf8');

// Two shapes from one template:
//
//   index.html + startup.js + app.css + app.js -> what Tauri bundles. Keeping the script
//     external lets the packaged app run under a strict `script-src 'self'`
//     CSP, which matters for a program that renders untrusted files.
//   dist-standalone/Markdown Viewer.html -> everything inlined, the standalone
//     download that works from file:// with no server and no siblings.
const inlined = tpl
  .replace('/*__STARTUP__*/', () => inlineStartup)
  .replace('/*__CSS__*/', () => bundleCss)
  .replace('/*__JS__*/', () => inlineJs);

const external = tpl
  .replace('<script>/*__STARTUP__*/</script>', '<script src="startup.js"></script>')
  .replace('<style>/*__CSS__*/</style>', '<link rel="stylesheet" href="app.css">')
  .replace('<script>/*__JS__*/</script>', '<script src="app.js" defer></script>');

if ([external, inlined].some(html => /__(?:STARTUP|CSS|JS)__/.test(html))) {
  throw new Error('template markers changed — the build did not substitute');
}

// Clean first, so a source file deleted since the last build cannot linger in dist/.
await rm(out, { recursive: true, force: true });
await rm(standaloneOut, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await mkdir(standaloneOut, { recursive: true });
await writeFile(join(out, 'index.html'), external, 'utf8');
await writeFile(join(out, 'app.css'), bundleCss, 'utf8');
await writeFile(join(out, 'app.js'), bundleJs, 'utf8');
await writeFile(join(out, 'startup.js'), bundleStartup, 'utf8');
await writeFile(join(out, 'mermaid.js'), mermaidBundle.outputFiles[0].text, 'utf8');
await writeFile(join(standaloneOut, OUT_NAME), inlined, 'utf8');

const kb = (Buffer.byteLength(inlined, 'utf8') / 1024).toFixed(0);
console.log(`built dist/  ->  index.html + startup.js + app.css + app.js (packaged app)`);
const mkb = (Buffer.byteLength(mermaidBundle.outputFiles[0].text, 'utf8') / 1024).toFixed(0);
console.log(`              ->  mermaid.js (${mkb} KB, lazy-loaded by the packaged app only)`);
console.log(`built dist-standalone/  ->  ${OUT_NAME} (${kb} KB standalone, zero network, not in the installer)`);
