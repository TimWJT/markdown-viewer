import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import markedFootnote from 'marked-footnote';
import { createHarness, addWatchedTabs, settle } from './helpers/source-harness.mjs';
import { createDomWindow } from './helpers/mini-dom.mjs';

/* render() end to end, with the real parser and the real sanitiser wired into
 * the harness. The fake DOM returns matches for the selectors render() uses,
 * so what is asserted here is the tree render() actually built — heading ids,
 * the outline, link routing and code-block handling.
 */
const DOMPurify = createDOMPurify(createDomWindow());

/* render() is normally reached with a document open, and its staleness guard
 * only holds while the active state is a live tab, so every fixture opens one. */
function realHarness(options = {}) {
  const h = createHarness({ marked, dompurify: DOMPurify, footnote: markedFootnote, ...options });
  const { a } = addWatchedTabs(h, options.native !== false);
  h.activate(a);
  return h;
}

const doc = h => h.element('#doc');
const outline = h => h.element('#outline-list');
/* `state.heads` is built inside the vm, so its arrays belong to another realm
 * and are not reference-comparable with this file's. Copy before comparing. */
const ids = h => JSON.parse(JSON.stringify(h.state.heads.map(x => x.id)));
const titles = h => JSON.parse(JSON.stringify(h.state.heads.map(x => x.title)));

/** Click an anchor the way a user would, and report what the click did. */
function clickAnchor(anchor) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  anchor.dispatch('click', event);
  return event;
}

const openedPaths = h => h.calls.filter(c => c.command === 'read_text_file').map(c => c.path);

test('render: headings get ids, anchors and outline entries', () => {
  const h = realHarness();
  h.call('render', '# One\n\n## Two Words\n\n### Two Words\n');
  assert.deepEqual(ids(h), ['one', 'two-words', 'two-words-2'], 'duplicate titles get a suffix');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.heads.map(x => x.level))), [1, 2, 3]);
  const headings = doc(h).querySelectorAll('h1, h2, h3, h4, h5, h6');
  assert.equal(headings.length, 3);
  assert.equal(headings[1].getAttribute('id'), 'two-words');
  const anchor = headings[1].querySelector('a.anchor');
  assert.equal(anchor.getAttribute('href'), '#two-words');
  assert.equal(anchor.getAttribute('aria-hidden'), 'true');
  assert.equal(anchor.textContent, '#');
  const entries = outline(h).querySelectorAll('a');
  assert.deepEqual(entries.map(a => a.textContent), ['One', 'Two Words', 'Two Words']);
  assert.deepEqual(entries.map(a => a.getAttribute('href')), ['#one', '#two-words', '#two-words-2']);
});

test('render: a document with footnotes gets no outline entry and no id for the plugin label', () => {
  const h = realHarness();
  h.call('render', '# Notes\n\nA claim.[^1]\n\n[^1]: The evidence.\n');
  assert.match(doc(h).innerHTML, /<h2 id="footnote-label" class="sr-only">Footnotes<\/h2>/,
    'the plugin output must reach the tree');
  assert.deepEqual(ids(h), ['notes'], 'the plugin label must not be collected as a heading');
  const label = doc(h).querySelector('section.footnotes h2');
  assert.equal(label.getAttribute('id'), 'footnote-label', 'the plugin id must be left alone');
  assert.equal(label.querySelector('a.anchor'), null, 'the plugin label must not get an anchor');
  assert.deepEqual(outline(h).querySelectorAll('a').map(a => a.textContent), ['Notes']);
  assert.doesNotMatch(outline(h).textContent, /Footnotes/);
});

test('render: an h5/h6-only document produces a non-empty outline', () => {
  const h = realHarness();
  h.call('render', '##### Five\n\n###### Six\n');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.heads.map(x => [x.title, x.level]))), [['Five', 5], ['Six', 6]]);
  const entries = outline(h).querySelectorAll('a');
  assert.deepEqual(entries.map(a => a.textContent), ['Five', 'Six']);
  assert.deepEqual(entries.map(a => a.dataset.lvl), ['1', '2'], 'indent is relative to the shallowest heading');
  assert.doesNotMatch(outline(h).textContent, /No headings/);
});

test('render: the link router classifies every shape the parser can produce', () => {
  const h = realHarness({ invoke: async () => null });
  h.call('render', [
    '[in page](#one)',
    '',
    '[external](https://example.com/x)',
    '',
    '[mail](mailto:someone@example.com)',
    '',
    '[call](tel:+61400000000)',
    '',
    '[relative](notes/02.md)',
    '',
    '[the app](index.html?file=C:%5CWindows%5Cwin.ini)',
    '',
    '<a href="javascript:alert(1)">raw script</a>',
    '',
    '#### One',
  ].join('\n'));
  /* render() also injects a "#" anchor into each heading; those are not links. */
  const anchors = doc(h).querySelectorAll('a[href]').filter(a => !a.classList.contains('anchor'));
  const byText = new Map(anchors.map(a => [a.textContent, a]));
  assert.deepEqual([...byText.keys()], ['in page', 'external', 'mail', 'call', 'relative', 'the app']);

  /* An in-page anchor is the only shape that may scroll instead of open. */
  assert.equal(clickAnchor(byText.get('in page')).defaultPrevented, true);
  assert.deepEqual(openedPaths(h), [], 'an in-page anchor opens nothing');

  /* The refused app-self link is never navigated and never opened. */
  assert.equal(clickAnchor(byText.get('the app')).defaultPrevented, true);
  assert.equal(h.notices.at(-1), 'Blocked: that link points back at the app');
  assert.deepEqual(openedPaths(h), []);

  /* A relative markdown link is the only shape routed to openPath. */
  assert.equal(clickAnchor(byText.get('relative')).defaultPrevented, true);
  assert.deepEqual(openedPaths(h), ['notes/02.md']);

  /* Every remaining shape is intercepted, so no href reaches the webview. */
  for (const text of ['external', 'mail', 'call']) {
    assert.equal(byText.get(text).listeners.get('click').length, 1, `${text} is intercepted`);
  }
  /* The raw-HTML javascript: href never even made it into the tree. */
  assert.equal(doc(h).querySelectorAll('a[href]').filter(a => a.getAttribute('href').startsWith('javascript')).length, 0);
  assert.match(doc(h).textContent, /raw script/, 'the link text itself is kept');
});

test('render: external and mailto links go to the OS opener, and a failed open is reported', async () => {
  const opened = [];
  const h = realHarness({ invoke: async () => null });
  /* openUrl is a context double that throws by default; record instead. */
  h.context.openUrl = async url => { opened.push(url); };
  h.call('render', [
    '[external](https://example.com/x)',
    '',
    '[mail](mailto:someone@example.com)',
    '',
    '[call](tel:+61400000000)',
    '',
    '[relative](notes/02.md)',
  ].join('\n'));
  const byText = new Map(doc(h).querySelectorAll('a[href]').map(a => [a.textContent, a]));
  for (const text of ['external', 'mail', 'call']) {
    assert.equal(clickAnchor(byText.get(text)).defaultPrevented, true, `${text} must not reach default navigation`);
  }
  clickAnchor(byText.get('relative'));
  await settle();
  assert.deepEqual(opened, ['https://example.com/x', 'mailto:someone@example.com', 'tel:+61400000000']);
  assert.deepEqual(openedPaths(h), ['notes/02.md'], 'only the relative link became a document');
});

test('render: a failed external open says so instead of failing silently', async () => {
  const h = realHarness();
  h.context.openUrl = async () => { throw new Error('no handler'); };
  h.call('render', '[external](https://example.com/x)\n');
  clickAnchor(doc(h).querySelectorAll('a[href]')[0]);
  await settle();
  assert.equal(h.notices.at(-1), 'Could not open link');
});

test('render: an in-page anchor scrolls to the heading it names', () => {
  const h = realHarness();
  h.call('render', '# One\n\n## Two Words\n\n[down](#two-words)\n');
  const link = doc(h).querySelectorAll('a[href]').find(a => a.getAttribute('href') === '#two-words');
  assert.equal(clickAnchor(link).defaultPrevented, true);
  assert.deepEqual(openedPaths(h), []);
  assert.equal(h.state.heads[1].el.getAttribute('id'), 'two-words');
});

for (const [name, text] of [
  ['unmatched opener', '---\nOpening paragraph.\n\n# Still here\n'],
  ['mismatched closing marker', '---\ntitle: Keep this\n+++\n\n# Still here\n'],
  ['closing marker only inside a code fence', '---\nOpening paragraph.\n\n```yaml\n---\n```\n\n# Still here\n'],
]) {
  test(`render: front matter leaves an ${name} untouched`, () => {
    const h = realHarness();
    assert.equal(h.call('stripFrontMatter', text), text, 'the complete original input survives');
    h.call('render', text);
    assert.deepEqual(titles(h), ['Still here']);
    assert.match(doc(h).textContent, /Opening paragraph|title: Keep this/);
    if (name === 'closing marker only inside a code fence') {
      assert.equal(doc(h).querySelector('pre code').textContent, '---\n');
    }
  });
}

for (const marker of ['---', '+++']) {
  test(`render: matching ${marker} front matter skips a fenced marker and strips through the real closer`, () => {
    const h = realHarness();
    const body = '# Body\n\nRemaining paragraph.\n';
    const text = `${marker}\ntitle: Metadata\n\`\`\`text\n${marker}\n\`\`\`\n${marker}\n${body}`;
    assert.equal(h.call('stripFrontMatter', text), body);
    h.call('render', text);
    assert.deepEqual(titles(h), ['Body']);
    assert.doesNotMatch(doc(h).textContent, /Metadata/);
    assert.match(doc(h).textContent, /Remaining paragraph/);
  });
}

test('render: a --- inside a fenced code block does not truncate the document', () => {
  const h = realHarness();
  h.call('render', [
    '# Title',
    '',
    '```yaml',
    'key: value',
    '---',
    'other: value',
    '```',
    '',
    '## After the fence',
    '',
    'Trailing paragraph.',
  ].join('\n'));
  assert.deepEqual(titles(h), ['Title', 'After the fence']);
  assert.match(doc(h).querySelectorAll('pre code')[0].textContent, /---/, 'the fence content survives');
  assert.match(doc(h).textContent, /Trailing paragraph/);
});

test('render: code blocks get a copy button and mermaid blocks are left for the diagram pass', () => {
  const h = realHarness();
  h.call('render', '```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n');
  const pres = doc(h).querySelectorAll('pre');
  assert.equal(pres.length, 2);
  for (const pre of pres) {
    const button = pre.querySelector('button.copy');
    assert.ok(button, 'every code block gets a copy button');
    assert.equal(button.getAttribute('title'), 'Copy code');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(pre.style.position, 'relative');
  }
  assert.equal(doc(h).querySelectorAll('pre > code.language-mermaid').length, 1);
  assert.deepEqual(pres.map(p => p.querySelector('code').getAttribute('class')), ['language-js', 'language-mermaid']);
});

test('render: an image with no document folder is left exactly as written', () => {
  const h = realHarness();
  assert.equal(h.state.docDir, null, 'nothing has been opened, so there is no folder to resolve against');
  h.call('render', '![shot](pics/shot.png)\n\n![remote](https://example.com/a.png)\n');
  const images = doc(h).querySelectorAll('img[src]');
  assert.deepEqual(images.map(i => i.getAttribute('src')), ['pics/shot.png', 'https://example.com/a.png']);
});

test('render: hostile markdown is stripped by the sanitiser on the way in', () => {
  const h = realHarness();
  h.call('render', '<script>alert(1)</script>\n\n<img src="a.png" onerror="alert(1)">\n\n[x](javascript:alert(1))\n');
  assert.doesNotMatch(doc(h).innerHTML, /<script/i);
  assert.doesNotMatch(doc(h).innerHTML, /onerror/i);
  assert.equal(doc(h).querySelector('a[href]'), null, 'the javascript: href was removed by the sanitiser');
  assert.equal(doc(h).querySelector('img').getAttribute('src'), 'a.png');
});

test('render: an empty document clears the outline without throwing', async () => {
  const h = realHarness();
  h.call('render', '');
  assert.deepEqual(ids(h), []);
  assert.match(outline(h).textContent, /No headings/);
  assert.equal(doc(h).textContent, '');
  await settle();
});
