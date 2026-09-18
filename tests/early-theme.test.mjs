import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { createHarness } from './helpers/source-harness.mjs';

const project = new URL('../', import.meta.url);
const source = readFileSync(new URL('src/startup.js', project), 'utf8');
const variants = [
  ['light', '"light"', 'light'], ['dark', '"dark"', 'dark'], ['auto', '"auto"', null],
  ['missing', null, null], ['invalid JSON', '{oops', null], ['raw string', 'dark', null],
  ['unknown', '"sepia"', null], ['null', 'null', null], ['object', '{}', null],
  ['array', '["dark"]', null], ['number', '42', null], ['boolean', 'true', null],
];
for (const osDark of [false, true]) {
  for (const [name, value, expected] of variants) {
    test(`early theme: ${name}, OS ${osDark ? 'dark' : 'light'}`, () => {
      const attributes = new Map([['data-theme', 'stale']]);
      const reads = [];
      const context = vm.createContext({
        window: {},
        document: { documentElement: {
          setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
        } },
        localStorage: { getItem(k) { reads.push(k); return value; } },
        matchMedia: () => ({ matches: osDark }),
      });
      vm.runInContext(source, context);
      assert.equal(attributes.get('data-theme') ?? null, expected);
      assert.deepEqual(reads, ['mdv.theme']);
      // The app's bundled fallback must leave the already-applied theme alone.
      vm.runInContext(source, context);
      assert.equal(reads.length, 1);
    });
  }
}
for (const denial of ['getter', 'getItem']) {
  test(`early theme: storage denied at ${denial} falls back safely`, () => {
    const attributes = new Map([['data-theme', 'dark']]);
    const globals = {
      window: {}, document: { documentElement: {
        setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
      } },
    };
    Object.defineProperty(globals, 'localStorage', { get() {
      if (denial === 'getter') throw new Error('fixture storage blocked');
      return { getItem() { throw new Error('fixture storage blocked'); } };
    } });
    vm.runInContext(source, vm.createContext(globals));
    assert.equal(attributes.has('data-theme'), false);
  });
}

test('early theme: later applyTheme shares resolution and keeps existing JSON storage format', () => {
  const h = createHarness({ saved: { theme: 'dark' } });
  assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
  for (const value of ['light', 'dark', 'auto', null, {}, 'invalid']) {
    h.call('applyTheme', value, false);
    const expected = value === 'light' || value === 'dark' ? value : 'auto';
    assert.equal(h.document.documentElement.getAttribute('data-theme'), expected === 'auto' ? null : expected);
    assert.equal(JSON.parse(h.storage.get('mdv.theme')), expected);
  }
});

test('build structure: both output shapes apply theme first; packaged JS stays deferred and Mermaid lazy', async () => {
  // Execute the actual build script and template, with compilation replaced by
  // explicit fixture strings and all writes kept in memory. No dist is touched.
  const outputs = new Map();
  const context = vm.createContext({
    build: async options => ({ outputFiles: [{ text:
      basename(options.entryPoints[0]) === 'startup.js' ? source :
      basename(options.entryPoints[0]) === 'app.css' ? 'body{color:black}' : '/* fixture bundle */',
    }] }),
    readFile: async path => readFileSync(path, 'utf8'),
    writeFile: async (path, text) => outputs.set(basename(path), text),
    mkdir: async () => {}, fileURLToPath, dirname, join, Buffer,
    console: { log() {} },
  });
  const buildSource = readFileSync(new URL('build.mjs', project), 'utf8')
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace('import.meta.url', JSON.stringify(new URL('build.mjs', project).href));
  await vm.runInContext('(async () => {\n' + buildSource + '\n})()', context);
  const packaged = outputs.get('index.html');
  const standalone = outputs.get('Markdown Viewer.html');
  assert.equal(outputs.get('startup.js'), source);
  assert.match(packaged, /<script src="startup\.js"><\/script>/);
  assert.match(packaged, /<script src="app\.js" defer><\/script>/);
  assert.ok(packaged.indexOf('src="startup.js"') < packaged.indexOf('href="app.css"'));
  assert.ok(packaged.indexOf('src="startup.js"') < packaged.indexOf('<body>'));
  assert.ok(standalone.indexOf(source) > 0);
  assert.ok(standalone.indexOf(source) < standalone.indexOf('<style>'));
  assert.ok(standalone.indexOf(source) < standalone.indexOf('<body>'));
  for (const html of [packaged, standalone]) {
    assert.doesNotMatch(html, /__(?:STARTUP|CSS|JS)__/);
    assert.doesNotMatch(html, /<script[^>]+src="mermaid\.js"/);
    assert.match(html, /<div id="empty">/, 'welcome is not hidden by startup');
  }
  assert.doesNotMatch(standalone, /<script[^>]+src=/, 'no new sibling required by standalone');
  const app = readFileSync(new URL('src/main.js', project), 'utf8');
  assert.match(app, /import '\.\/startup\.js';/, 'fallback shares the exact bootstrap implementation');
  assert.match(app, /s\.src = 'mermaid\.js'/);
  const config = JSON.parse(readFileSync(new URL('src-tauri/tauri.conf.json', project), 'utf8'));
  assert.match(config.app.security.csp, /script-src 'self'/);
  assert.doesNotMatch(config.app.security.csp.split('script-src')[1].split(';')[0], /unsafe-inline/);
});
