/* A very small DOM double: enough of the node tree, selector engine, HTML
 * parser and serialiser for the frontend's own code to run unchanged, and
 * enough surface for the *real* DOMPurify to sanitise a string without a
 * browser. It is a fake, not a browser: no layout, no tree-construction
 * quirks, and only the selector forms the app and DOMPurify actually use.
 *
 * Why it exists: the app's security boundary is
 * `DOMPurify.sanitize(marked.parse(text))`, and nothing tested it. `dompurify`
 * refuses to run in Node unless it is handed a `window`, so the sanitiser
 * could not be executed here at all without one of these. Every allow-list,
 * URI-scheme check and removal decision in the tests below is made by the
 * installed DOMPurify 3.4.14 — not by anything in this file.
 */

export const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
/* Content of these is text, not markup. A fake DOM that parsed `<script>`
 * contents as tags would quietly neuter DOMPurify's raw-text checks. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

export const NODE_TYPE = { element: 1, attribute: 2, text: 3, cdata: 4, processingInstruction: 7, comment: 8, document: 9, doctype: 10, fragment: 11 };

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(text) {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (NAMED_ENTITIES[name] !== undefined) return NAMED_ENTITIES[name];
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

const escapeText = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/* ---------- selectors ----------
 * A selector list, the descendant and child combinators, and compound
 * selectors of tag / #id / .class / [attr] / [attr="value"]. Nothing else. */

function parseCompound(text) {
  const compound = { tag: null, id: null, classes: [], attrs: [] };
  const pattern = /(^[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let match, consumed = 0;
  while ((match = pattern.exec(text))) {
    consumed = pattern.lastIndex;
    if (match[1]) compound.tag = match[1].toLowerCase();
    else if (match[2]) compound.id = match[2];
    else if (match[3]) compound.classes.push(match[3]);
    else if (match[4]) compound.attrs.push({ name: match[4].toLowerCase(), value: match[5] === undefined ? null : match[5] });
  }
  if (consumed !== text.length) throw new Error(`mini-dom: unsupported selector "${text}"`);
  return compound;
}

function parseSelector(selector) {
  const steps = [];
  let combinator = null;
  for (const part of selector.trim().split(/\s*(>)\s*|\s+/).filter(Boolean)) {
    if (part === '>') { combinator = '>'; continue; }
    steps.push({ combinator, compound: parseCompound(part) });
    combinator = 'descendant';
  }
  return steps;
}

function compoundMatches(node, compound) {
  if (!node || node.nodeType !== NODE_TYPE.element) return false;
  if (compound.tag && node.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.id && node.getAttribute('id') !== compound.id) return false;
  for (const name of compound.classes) if (!node.classList.contains(name)) return false;
  for (const attr of compound.attrs) {
    if (!node.hasAttribute(attr.name)) return false;
    if (attr.value !== null && node.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function selectorMatches(node, steps) {
  let index = steps.length - 1;
  if (!compoundMatches(node, steps[index].compound)) return false;
  let current = node;
  while (--index >= 0) {
    const step = steps[index];
    if (step.combinator === '>') {
      current = current.parentNode;
      if (!compoundMatches(current, step.compound)) return false;
    } else {
      let ancestor = current.parentNode;
      while (ancestor && !compoundMatches(ancestor, step.compound)) ancestor = ancestor.parentNode;
      if (!ancestor) return false;
      current = ancestor;
    }
  }
  return true;
}

/* ---------- nodes ---------- */

const namedNodeMaps = new WeakMap();

/** A live NamedNodeMap: indexable, with `length`, as DOMPurify expects. */
function namedNodeMap(element) {
  let map = namedNodeMaps.get(element);
  if (!map) {
    const entries = () => [...element.attributeEntries()].map(([name, value]) => ({ name, value, namespaceURI: null, localName: name }));
    map = new Proxy({}, {
      get(_target, key) {
        if (key === 'length') return element.attributeEntries().size;
        if (key === 'item') return index => entries()[Number(index)] ?? null;
        if (key === Symbol.iterator) return () => entries()[Symbol.iterator]();
        if (typeof key === 'string' && /^\d+$/.test(key)) return entries()[Number(key)];
        return undefined;
      },
    });
    namedNodeMaps.set(element, map);
  }
  return map;
}

export class DomNode {
  constructor(ownerDocument = null, nodeType = NODE_TYPE.element, nodeName = '') {
    this._ownerDocument = ownerDocument;
    this._namespace = HTML_NS;
    this._nodeType = nodeType;
    this._nodeName = nodeName;
    this._value = '';
    this._children = [];
    this._parent = null;
    this._attributes = new Map();
    this.listeners = new Map();
  }
  get nodeType() { return this._nodeType; }
  get nodeName() { return this._nodeName; }
  get nodeValue() { return this._value; }
  set nodeValue(value) { this._value = value === null || value === undefined ? '' : String(value); }
  get data() { return this._value; }
  set data(value) { this.nodeValue = value; }
  get ownerDocument() { return this._ownerDocument; }
  set ownerDocument(value) { this._ownerDocument = value; }
  get children() { return this._children; }
  get childNodes() { return this._children; }
  get parentNode() { return this._parent; }
  set parentNode(value) { this._parent = value; }
  get parentElement() { return this._parent && this._parent.nodeType === NODE_TYPE.element ? this._parent : null; }
  get firstChild() { return this._children[0] || null; }
  get lastChild() { return this._children.at(-1) || null; }
  get firstElementChild() { return this._children.find(n => n.nodeType === NODE_TYPE.element) || null; }
  get nextSibling() {
    if (!this._parent) return null;
    const siblings = this._parent.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get tagName() { return this._nodeName; }
  get namespaceURI() { return this._namespace ?? null; }
  get attributes() { return namedNodeMap(this); }
  get shadowRoot() { return null; }
  get style() { return (this._style ??= { setProperty(key, value) { this[key] = value; } }); }
  get dataset() { return (this._dataset ??= {}); }
  get classList() { return (this._classList ??= makeClassList(this)); }
  hasChildNodes() { return this._children.length > 0; }
  contains(other) {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  attributeEntries() { return this._attributes; }
  getAttributeNames() { return [...this._attributes.keys()]; }
  getAttribute(name) { const key = this._findAttribute(name); return key === null ? null : this._attributes.get(key); }
  hasAttribute(name) { return this._findAttribute(name) !== null; }
  setAttribute(name, value) { this._attributes.set(this._findAttribute(name) ?? name, value === null || value === undefined ? '' : String(value)); }
  removeAttribute(name) { const key = this._findAttribute(name); if (key !== null) this._attributes.delete(key); }
  _findAttribute(name) {
    const wanted = String(name).toLowerCase();
    for (const key of this._attributes.keys()) if (key.toLowerCase() === wanted) return key;
    return null;
  }
  appendChild(node) {
    if (node.nodeType === NODE_TYPE.fragment) {
      for (const child of [...node.children]) this.appendChild(child);
      node.children.length = 0;
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this._children.push(node);
    return node;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  prepend(...nodes) {
    const reference = this.firstChild;
    for (const node of nodes) this.insertBefore(node, reference);
  }
  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node);
    const index = this._children.indexOf(reference);
    if (index < 0) throw new Error('mini-dom: insertBefore reference is not a child');
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this._children.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this._children.indexOf(node);
    if (index < 0) throw new Error('mini-dom: removeChild target is not a child');
    this._children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  replaceChild(next, old) {
    const index = this._children.indexOf(old);
    if (index < 0) throw new Error('mini-dom: replaceChild target is not a child');
    const nodes = next.nodeType === NODE_TYPE.fragment ? [...next.children] : [next];
    old.parentNode = null;
    this._children.splice(index, 1);
    let at = index;
    for (const node of nodes) {
      if (node === old) continue;
      /* Detach first, but never from this same child list without keeping
       * the insertion point straight. */
      const parent = node.parentNode;
      if (parent === this) {
        const from = this._children.indexOf(node);
        if (from >= 0) {
          this._children.splice(from, 1);
          if (from < at) at--;
        }
      } else if (parent) parent.removeChild(node);
      node.parentNode = this;
      this._children.splice(at++, 0, node);
    }
    if (next.nodeType === NODE_TYPE.fragment) next.children.length = 0;
    return old;
  }
  replaceChildren(...nodes) {
    for (const child of this._children) child.parentNode = null;
    this._children.length = 0;
    this.append(...nodes);
  }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    if (node.nodeType === NODE_TYPE.fragment) {
      for (const child of [...node.children]) parent.replaceChild(child, this);
      return;
    }
    parent.replaceChild(node, this);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  insertAdjacentElement(position, node) {
    const parent = this.parentNode;
    if (position === 'afterend' && parent) parent.insertBefore(node, this.nextSibling);
    else if (position === 'beforeend') this.appendChild(node);
    else if (position === 'afterbegin') this.insertBefore(node, this.firstChild);
    else if (parent) parent.insertBefore(node, this);
    return node;
  }
  cloneNode(deep = false) {
    const copy = this._cloneShallow();
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  _cloneShallow() { return new DomNode(this.ownerDocument, this._nodeType, this._nodeName); }
  normalize() {}
  get textContent() {
    if (this._nodeType === NODE_TYPE.text || this._nodeType === NODE_TYPE.comment) return this._value;
    return this._children.map(child => child.textContent).join('');
  }
  set textContent(value) {
    if (this._nodeType === NODE_TYPE.text || this._nodeType === NODE_TYPE.comment) { this.nodeValue = value; return; }
    this.replaceChildren();
    if (value !== '' && value !== null && value !== undefined) this.appendChild(new DomText(this.ownerDocument, String(value)));
  }
  get innerHTML() { return this._children.map(child => child._serialize()).join(''); }
  set innerHTML(value) {
    this.replaceChildren();
    for (const node of parseFragment(String(value ?? ''), this.ownerDocument)) this.appendChild(node);
  }
  get outerHTML() { return this._serialize(); }
  _serialize() {
    if (this._nodeType === NODE_TYPE.text) {
      return RAW_TEXT_ELEMENTS.has(this.parentNode?.tagName?.toLowerCase()) ? this._value : escapeText(this._value);
    }
    if (this._nodeType === NODE_TYPE.comment) return `<!--${this._value}-->`;
    const tag = this.tagName.toLowerCase();
    const attrs = [...this._attributes].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
    if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
  getElementsByTagName(tag) {
    const wanted = String(tag).toLowerCase();
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.nodeType === NODE_TYPE.element && (wanted === '*' || child.tagName.toLowerCase() === wanted)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      try { return selectorMatches(this, parseSelector(part)); } catch { return false; }
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (node.nodeType === NODE_TYPE.element && node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(parseSelector);
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.nodeType === NODE_TYPE.element && selectors.some(steps => selectorMatches(child, steps))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(event) {
    for (const fn of this.listeners.get(event.type) || []) fn(event);
  }
  /** The harness's original name for dispatchEvent. */
  dispatch(type, event) { event.type = type; this.dispatchEvent(event); }
}

function makeClassList(element) {
  const read = () => new Set(String(element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
  const write = set => element.setAttribute('class', [...set].join(' '));
  return {
    get length() { return read().size; },
    add: (...names) => { const set = read(); names.forEach(n => set.add(n)); write(set); },
    remove: (...names) => { const set = read(); names.forEach(n => set.delete(n)); write(set); },
    contains: name => read().has(name),
    toggle(name, force = !read().has(name)) {
      const set = read();
      force ? set.add(name) : set.delete(name);
      write(set);
      return force;
    },
  };
}

export class DomElement extends DomNode {
  constructor(ownerDocument, tagName, text = '') {
    super(ownerDocument, NODE_TYPE.element, String(tagName).toUpperCase());
    this.value = '';
    this.scrollTop = this.scrollLeft = 0;
    this.clientWidth = this.offsetWidth = 800;
    this.clientHeight = this.offsetHeight = 600;
    this.offsetTop = 0;
    this.isContentEditable = false;
    if (text) this._value = text;
  }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get src() { return this.getAttribute('src') ?? ''; }
  set src(value) { this.setAttribute('src', value); }
  /* Reflected attributes: the app assigns these as properties, not attributes. */
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  get href() { return this.getAttribute('href') ?? ''; }
  set href(value) { this.setAttribute('href', value); }
  get title() { return this.getAttribute('title') ?? ''; }
  set title(value) { this.setAttribute('title', value); }
  get type() { return this.getAttribute('type') ?? ''; }
  set type(value) { this.setAttribute('type', value); }
  get target() { return this.getAttribute('target') ?? ''; }
  set target(value) { this.setAttribute('target', value); }
  get rel() { return this.getAttribute('rel') ?? ''; }
  set rel(value) { this.setAttribute('rel', value); }
  _cloneShallow() {
    const copy = new DomElement(this.ownerDocument, this.tagName);
    copy._namespace = this._namespace;
    copy.className = this.className;
    for (const [name, value] of this._attributes) copy.setAttribute(name, value);
    return copy;
  }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  select() {}
  scrollIntoView() {}
  scrollTo({ top = 0, left = 0 } = {}) { this.scrollTop = top; this.scrollLeft = left; }
  getBoundingClientRect() { return { top: 0, left: 0, width: this.clientWidth, height: this.clientHeight }; }
}

class DomText extends DomNode {
  constructor(ownerDocument, value, nodeType = NODE_TYPE.text, name = '#text') {
    super(ownerDocument, nodeType, name);
    this._value = value;
  }
  _cloneShallow() { return new DomText(this.ownerDocument, this._value, this._nodeType, this._nodeName); }
}

/* ---------- HTML parsing ---------- */

function parseAttributes(source, element) {
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) element.setAttribute(match[1], decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
}

/** Parse an HTML fragment into a list of nodes. */
function parseFragment(html, ownerDocument = null) {
  const out = [];
  const stack = [];
  const push = node => (stack.length ? stack.at(-1).appendChild(node) : out.push(node));
  const pushText = text => { if (text !== '') push(new DomText(ownerDocument, decodeEntities(text))); };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      push(new DomText(ownerDocument, html.slice(lt + 4, end < 0 ? html.length : end), NODE_TYPE.comment, '#comment'));
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end < 0 ? html.length : end;
      out.push(new DomText(ownerDocument, html.slice(lt, stop + 1), NODE_TYPE.doctype, html.slice(lt, stop + 1)));
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const opening = html.slice(lt).match(/^<(\/?)([a-zA-Z][\w:-]*)/);
    if (!opening) { pushText('<'); i = lt + 1; continue; }
    const [, closing, rawName] = opening;
    const name = rawName.toLowerCase();
    /* Scan to the `>` that ends the tag, skipping any `>` inside a quoted
     * attribute value — a real parser is in "attribute value" state there. */
    let cursor = lt + opening[0].length;
    let quote = '';
    while (cursor < html.length && !(html[cursor] === '>' && !quote)) {
      const char = html[cursor];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      cursor++;
    }
    const selfClosing = html[cursor - 1] === '/';
    const rawAttrs = html.slice(lt + opening[0].length, selfClosing ? cursor - 1 : cursor);
    i = cursor < html.length ? cursor + 1 : html.length;
    if (closing) {
      for (let depth = stack.length - 1; depth >= 0; depth--) {
        if (stack[depth].tagName.toLowerCase() === name) { stack.length = depth; break; }
      }
      continue;
    }
    const element = new DomElement(ownerDocument, name);
    /* Foreign content: a real browser changes namespace inside <svg>/<math>. */
    element._namespace = name === 'svg' ? SVG_NS : name === 'math' ? MATHML_NS : (stack.at(-1)?._namespace ?? HTML_NS);
    parseAttributes(rawAttrs, element);
    push(element);
    if (VOID_ELEMENTS.has(name) || selfClosing) continue;
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = html.slice(i).search(new RegExp(`</${name}\\s*>`, 'i'));
      const end = close < 0 ? html.length : i + close;
      if (end > i) element.appendChild(new DomText(ownerDocument, html.slice(i, end)));
      const gt = html.indexOf('>', end);
      i = end >= html.length ? html.length : gt + 1;
      continue;
    }
    stack.push(element);
  }
  return out;
}

/* ---------- document + window ---------- */

export class DomDocument extends DomNode {
  constructor() {
    super(null, NODE_TYPE.document, '#document');
    this._ownerDocument = this;
    this.implementation = {
      createHTMLDocument: () => newDocument('html'),
      createDocument: (_namespace, name) => newDocument(String(name || 'html')),
    };
  }
  get documentElement() { return this._documentElement ??= this.children.find(n => n.nodeType === NODE_TYPE.element) ?? null; }
  set documentElement(value) { this._documentElement = value; }
  get body() { return this._body ??= this.getElementsByTagName('body')[0] ?? null; }
  set body(value) { this._body = value; }
  createElement(tag) { return new DomElement(this, tag); }
  createTextNode(text) { return new DomText(this, text); }
  createComment(text) { return new DomText(this, text, NODE_TYPE.comment, '#comment'); }
  createDocumentFragment() { return new DomNode(this, NODE_TYPE.fragment, '#document-fragment'); }
  importNode(node, deep) { return node.cloneNode(deep); }
  createNodeIterator(root, whatToShow = 0xFFFFFFFF) {
    const accepted = [];
    const walk = node => {
      for (const child of node.children) {
        if (whatToShow & (1 << (child.nodeType - 1))) accepted.push(child);
        walk(child);
      }
    };
    walk(root);
    let i = 0;
    return { nextNode: () => accepted[i++] ?? null, previousNode: () => accepted[--i] ?? null, detach() {} };
  }
  createTreeWalker(root, whatToShow = 0xFFFFFFFF) {
    const iterator = this.createNodeIterator(root, whatToShow);
    return { nextNode: () => iterator.nextNode(), previousNode: () => iterator.previousNode(), currentNode: null, parentNode: null };
  }
}

export function newDocument(rootName = 'html') {
  const doc = new DomDocument();
  doc.appendChild(new DomElement(doc, rootName));
  return doc;
}

/** A `window` shaped just enough for DOMPurify 3.4 to consider itself supported. */
export function createDomWindow() {
  const document = newDocument('html');
  const body = document.createElement('body');
  document.documentElement.appendChild(body);
  return {
    document,
    Node: { prototype: DomNode.prototype },
    Element: { prototype: DomNode.prototype },
    NodeFilter: {
      SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 1, SHOW_ATTRIBUTE: 2, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8,
      SHOW_PROCESSING_INSTRUCTION: 64, SHOW_COMMENT: 128, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
    },
    NamedNodeMap: function NamedNodeMap() {},
    DocumentFragment: function DocumentFragment() {},
    /* DOMPurify prefers DOMParser and only falls back to
     * implementation.createDocument, whose result has no <body> to walk. */
    DOMParser: class DOMParser {
      parseFromString(html) {
        const doc = newDocument('html');
        const body = doc.createElement('body');
        body.innerHTML = String(html);
        doc.documentElement.appendChild(body);
        return doc;
      }
    },
  };
}
