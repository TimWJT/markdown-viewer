import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Execute the complete frontend, minus its package imports and automatic boot.
 * No lifecycle function is copied or replaced. New helpers in main.js therefore
 * load automatically. Markdown parsing, DOM, IPC, storage and clocks are explicit
 * in-memory doubles; this is not a browser-layout or native-window test.
 */
const sourcePath = new URL('../../src/main.js', import.meta.url);

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function settle() {
  // Drain short chains of awaits without real timers or real polling.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

class FakeNode {
  constructor(tagName = '', text = '') {
    this.tagName = tagName.toUpperCase();
    this.nodeType = tagName === '#text' ? 3 : tagName === '#fragment' ? 11 : 1;
    this.nodeValue = this.nodeType === 3 ? text : null;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty(key, value) { this[key] = value; } };
    this.listeners = new Map();
    this.value = '';
    this.scrollTop = this.scrollLeft = 0;
    this.clientWidth = this.offsetWidth = 800;
    this.clientHeight = this.offsetHeight = 600;
    this.offsetTop = 0;
    this.isContentEditable = false;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        force ? classes.add(name) : classes.delete(name);
        return force;
      },
    };
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: value => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(n => classes.add(n)); },
    });
  }
  get parentElement() { return this.parentNode; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.children.map(n => n.textContent).join(''); }
  set textContent(value) {
    if (this.nodeType === 3) { this.nodeValue = String(value); return; }
    this.replaceChildren();
    if (value !== '') this.appendChild(new FakeNode('#text', String(value)));
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(value) { this.textContent = value; }
  appendChild(node) {
    if (node.nodeType === 11) {
      for (const child of [...node.children]) this.appendChild(child);
      node.children = [];
    } else {
      node.parentNode = this;
      this.children.push(node);
    }
    return node;
  }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  replaceChildren(...nodes) {
    this.children.forEach(n => { n.parentNode = null; });
    this.children = [];
    this.append(...nodes);
  }
  replaceChild(next, old) {
    const index = this.children.indexOf(old);
    if (index < 0) throw new Error('DOM fixture: replaceChild target missing');
    const nodes = next.nodeType === 11 ? [...next.children] : [next];
    old.parentNode = null;
    nodes.forEach(n => { n.parentNode = this; });
    this.children.splice(index, 1, ...nodes);
  }
  normalize() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  dispatch(name, event) { for (const fn of this.listeners.get(name) || []) fn(event); }
  matches(selector) {
    if (selector === '.tab[aria-selected="true"]') return this.classList.contains('tab') && this.getAttribute('aria-selected') === 'true';
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector.split(',').some(s => node.matches(s.trim()))) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        if (selector.split(',').some(s => child.matches(s.trim()))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; }
  select() {}
  scrollIntoView() {}
  scrollTo({ top = 0, left = 0 }) { this.scrollTop = top; this.scrollLeft = left; }
  getBoundingClientRect() { return { top: 0, left: 0, width: this.clientWidth, height: this.clientHeight }; }
}

export function createHarness({ native = true, saved = {}, rawSaved = {}, label = 'main', search = '', invoke, checkUpdate, listen, allowNewWindows = false } = {}) {
  const nodes = new Map();
  const element = selector => {
    if (selector === '#tabbar .tab[aria-selected="true"]') return element('#tabbar').querySelector('.tab[aria-selected="true"]');
    if (!nodes.has(selector)) nodes.set(selector, new FakeNode(selector.includes('input') ? 'input' : 'div'));
    return nodes.get(selector);
  };
  const document = new FakeNode('document');
  document.documentElement = new FakeNode('html');
  document.head = new FakeNode('head');
  document.body = new FakeNode('body');
  document.querySelector = element;
  document.querySelectorAll = selector => [element(selector)];
  document.createElement = tag => new FakeNode(tag);
  document.createTextNode = text => new FakeNode('#text', text);
  document.createDocumentFragment = () => new FakeNode('#fragment');
  document.createTreeWalker = (root, _kind, filter) => {
    const accepted = [];
    const walk = node => {
      if (node.nodeType === 3 && (!filter || filter.acceptNode(node) === 1)) accepted.push(node);
      node.children.forEach(walk);
    };
    walk(root);
    let i = 0;
    return { nextNode: () => accepted[i++] || null };
  };
  const window = new FakeNode('window');
  if (native) window.__TAURI_INTERNALS__ = {};
  const storage = new Map(Object.entries(saved).map(([key, value]) => ['mdv.' + key, JSON.stringify(value)]));
  for (const [key, value] of Object.entries(rawSaved)) storage.set('mdv.' + key, value);
  const writes = [];
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); storage.set(key, value); },
    removeItem: key => storage.delete(key),
  };
  const timers = new Map(), frames = new Map();
  let timerSeq = 0, frameSeq = 0;
  const calls = [], notices = [], listeners = [], newWindows = [];
  const toastNode = element('#toast');
  Object.defineProperty(toastNode, 'textContent', {
    get: () => notices.at(-1) || '',
    set: value => notices.push(String(value)),
  });
  const nativeWindow = {
    label, closeCalls: 0, focusCalls: 0,
    destroyCalls: 0,
    async close() { this.closeCalls++; },
    async destroy() { this.destroyCalls++; },
    async setFocus() { this.focusCalls++; },
    async setTitle() {},
  };
  const context = vm.createContext({
    console, document, window, localStorage, location: { search }, URLSearchParams,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Node: { TEXT_NODE: 3 },
    CSS: { escape: value => value },
    navigator: { clipboard: { writeText: async () => {} } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    performance: { now: () => 0 },
    ResizeObserver: class { observe() {} },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, kind: 'interval' }); return id; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++frameSeq; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    // Parser doubles deliberately treat fixture text as plain text. Actual
    // render(), Find matching, tab rendering and lifecycle code still execute.
    marked: { setOptions() {}, use() {}, parse: text => text },
    markedFootnote: () => ({}), DOMPurify: { sanitize: html => html },
    hljs: { highlightElement() {} }, temml: { renderToString: () => { throw new Error('No math fixtures'); } },
    invoke: async (command, args) => {
      calls.push({ command, ...args });
      if (invoke) return invoke(command, args);
      if (command === 'external_open_ready') return;
      if (command === 'claim_external_open') return true;
      if (command === 'initial_file') return null;
      if (command === 'file_mtime') return 1;
      if (command === 'read_text_file') return 'text:' + args.path;
      throw new Error('Unexpected mocked IPC: ' + command);
    },
    convertFileSrc: path => 'mock-asset:' + path,
    listen: async (name, callback, options) => {
      listeners.push({ name, callback, options });
      if (listen) return listen(name, callback, options);
      return () => {};
    },
    getCurrentWindow: () => nativeWindow,
    WebviewWindow: class {
      constructor(label, options) {
        if (!allowNewWindows) throw new Error('Unexpected new-window request');
        newWindows.push({ label, options });
      }
      once(name, callback) { if (name === 'tauri://created') callback(); return Promise.resolve(() => {}); }
    },
    openDialog: async () => null,
    checkUpdate: checkUpdate || (async () => { throw new Error('Unexpected updater check'); }),
    relaunch: async () => { throw new Error('Unexpected relaunch'); },
    getVersion: async () => 'test-version',
    openUrl: async () => { throw new Error('Unexpected external URL'); },
    indexedDB: { open() { throw new Error('IndexedDB disabled in fixtures'); } },
  });
  let source = readFileSync(sourcePath, 'utf8').replace(/^import\s+[^;]+;\s*$/gm, '');
  const bootStart = source.indexOf('const boot = (async function boot() {');
  if (bootStart < 0) throw new Error('Harness boot boundary missing; update source adapter');
  const bootEnd = source.indexOf('})();', bootStart);
  if (bootEnd < 0) throw new Error('Harness boot end missing');
  source = source.slice(0, bootStart) + 'globalThis.__boot = async function boot() {' +
    source.slice(bootStart + 'const boot = (async function boot() {'.length, bootEnd) +
    '}; const boot = new Promise((resolve, reject) => { globalThis.__startBoot = () => { const result = __boot(); result.then(resolve, reject); return result; }; });' +
    source.slice(bootEnd + '})();'.length);
  vm.runInContext(readFileSync(new URL('../../src/startup.js', import.meta.url), 'utf8'), context);
  vm.runInContext(source, context, { filename: sourcePath.pathname });
  const run = code => vm.runInContext(code, context);
  return {
    run, context, element, document, window, storage, writes, calls, notices, timers, nativeWindow, listeners, newWindows,
    async emit(name, payload) {
      await Promise.all(listeners.filter(l => l.name === name).map(l => l.callback({ payload })));
    },
    get tabs() { return run('tabs'); },
    get state() { return run('state'); },
    boot: () => context.__startBoot(),
    call(name, ...args) { return run(name)(...args); },
    addTab(init) {
      context.__tabInit = init;
      return run('(() => { const tab = makeTab(__tabInit); tabs.push(tab); return tab; })()');
    },
    activate(tab) { run('activateTab')(tab.id); },
    flushFrames() {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(fn => fn(0));
    },
    key({ target = element('#find-input'), ...options } = {}) {
      const event = { target, key: 'w', ctrlKey: true, metaKey: false, shiftKey: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
      window.dispatch('keydown', event);
      return event;
    },
  };
}

export function addWatchedTabs(h, native = true) {
  const a = h.addTab({ name: 'A.md', text: 'A original', lastModified: 1, ...(native ? { path: 'C:/fixture/A.md' } : { handle: { getFile: async () => ({ lastModified: 1, text: async () => 'A original' }) } }) });
  const b = h.addTab({ name: 'B.md', text: 'B original', lastModified: 1, ...(native ? { path: 'C:/fixture/B.md' } : { handle: { getFile: async () => ({ lastModified: 1, text: async () => 'B original' }) } }) });
  h.activate(a);
  return { a, b };
}
