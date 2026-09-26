import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import markedFootnote from 'marked-footnote';
import { createDomWindow } from './helpers/mini-dom.mjs';

/* The app's security boundary, exercised with the *real* libraries it ships:
 * `DOMPurify.sanitize(marked.parse(text))` in src/main.js:906-907.
 *
 * DOMPurify will not run in Node unless it is handed a `window`, and no real
 * DOM implementation is installed, so it is given the mini DOM in
 * tests/helpers/mini-dom.mjs. Every allow-list, URI-scheme check and removal
 * decision below is therefore made by DOMPurify 3.4.14 itself; the double only
 * parses the markup and hands back a node tree. Swap the sanitiser for an
 * identity function and these tests fail.
 */
const DOMPurify = createDOMPurify(createDomWindow());
marked.use(markedFootnote());

/** The app's own call, including the options it passes. */
const render = text => DOMPurify.sanitize(marked.parse(text), { ADD_ATTR: ['target', 'id'] });

test('sanitiser: the harness can actually run the real DOMPurify', () => {
  assert.equal(DOMPurify.isSupported, true);
  assert.match(DOMPurify.version, /^3\./);
});

test('sanitiser: a <script> tag in user markdown does not survive', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<SCRIPT>alert(1)</SCRIPT>',
    'before\n\n<script src="https://evil.example/x.js"></script>\n\nafter',
    'text <script>alert(1)</script> more text',
    '<svg><script>alert(1)</script></svg>',
  ];
  for (const markdown of hostile) {
    const html = render(markdown);
    assert.doesNotMatch(html, /<script/i, `script survived: ${markdown}`);
    assert.doesNotMatch(html, /alert\(1\)/, `script body survived: ${markdown}`);
  }
});

test('sanitiser: onerror= and onload= event handlers do not survive', () => {
  const hostile = [
    '<img src="pics/a.png" onerror="alert(1)">',
    '<img src=x onerror=alert(1)>',
    '<img src="pics/a.png" onload="steal()">',
    '<img src="pics/a.png" ONERROR="alert(1)">',
    '<body onload="alert(1)">text</body>',
    '<p onclick="alert(1)">click me</p>',
    '<details ontoggle="alert(1)" open>more</details>',
  ];
  for (const markdown of hostile) {
    const html = render(markdown);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `event handler survived: ${markdown} -> ${html}`);
  }
});

test('sanitiser: a javascript: href is stripped, and so are its disguises', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '&#106;avascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ]) {
    const html = render(`[click](${href})`);
    assert.doesNotMatch(html, /href/i, `href survived for ${href}: ${html}`);
    assert.doesNotMatch(html, /javascript/i, `javascript: survived for ${href}: ${html}`);
  }
  /* A markdown link is not the only way in: raw HTML is passed through too. */
  assert.doesNotMatch(render('<a href="javascript:alert(1)">x</a>'), /href/i);
});

test('sanitiser: ordinary links and images DO survive, so the rules above are not "delete everything"', () => {
  assert.match(render('[docs](https://example.com/guide)'), /<a href="https:\/\/example\.com\/guide">docs<\/a>/);
  assert.match(render('[mail](mailto:someone@example.com)'), /href="mailto:someone@example\.com"/);
  assert.match(render('[call](tel:+61400000000)'), /href="tel:\+61400000000"/);
  assert.match(render('[next](notes/02.md)'), /<a href="notes\/02\.md">next<\/a>/);
  assert.match(render('![shot](pics/shot.png)'), /<img src="pics\/shot\.png" alt="shot">/);
  assert.match(render('![shot](https://example.com/a.png)'), /<img src="https:\/\/example\.com\/a\.png"/);
  assert.match(render('# Title\n\nA paragraph with **bold** and `code`.'), /<h1[^>]*>Title<\/h1>/);
  assert.match(render('> quote\n'), /<blockquote>/);
  assert.match(render('| a | b |\n| - | - |\n| 1 | 2 |\n'), /<table>/);
  assert.match(render('- one\n- two\n'), /<li>one<\/li>/);
});

test('sanitiser: the footnote plugin label and ordinary h5/h6 headings survive parsing', () => {
  const html = render('Body text.[^1]\n\n[^1]: The note.\n');
  /* marked-footnote emits exactly this; the app's render() must see it, and
   * must then leave it out of the outline (see render.test.mjs). */
  assert.match(html, /<h2[^>]*class="sr-only"[^>]*>Footnotes<\/h2>/);
  assert.match(html, /id="footnote-label"/);
  assert.match(html, /class="footnotes"/);
  assert.match(html, /data-footnotes=""/);
  assert.match(html, /id="footnote-1"/);
  assert.match(html, /id="footnote-ref-1"/);

  const headings = render('##### Five\n\n###### Six\n');
  assert.match(headings, /<h5[^>]*>Five<\/h5>/);
  assert.match(headings, /<h6[^>]*>Six<\/h6>/);
});

test('sanitiser: a mXSS-shaped payload and a foreignObject are still refused', () => {
  assert.doesNotMatch(render('<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>'), /onerror/i);
  assert.doesNotMatch(render('<svg><foreignObject><div onclick="alert(1)">x</div></foreignObject></svg>'), /onclick/i);
  assert.doesNotMatch(render('<iframe src="https://evil.example/"></iframe>'), /<iframe/i);
});

test('sanitiser: src/main.js actually pipes marked output through DOMPurify', () => {
  /* The tests above exercise the libraries; this one pins the call site, so
   * deleting `DOMPurify.sanitize(...)` from render() fails here even though
   * every behavioural test above would still pass on its own. */
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function render(text)'));
  assert.match(render, /const dirty = marked\.parse\(/);
  assert.match(render, /els\.doc\.innerHTML = DOMPurify\.sanitize\(\s*dirty\s*,\s*\{ ADD_ATTR: \['target', 'id'\] \}\s*\)/);
});
