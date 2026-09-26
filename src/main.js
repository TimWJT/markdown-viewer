import './startup.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

/* Tauri APIs. Safe to import in a plain browser — nothing touches the native
   bridge until called, and every call site is behind the IS_TAURI check. */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';

import markedFootnote from 'marked-footnote';
import temml from 'temml';

marked.setOptions({ gfm: true, breaks: false, async: false });
marked.use(markedFootnote());

/* ---------- math ----------
   Temml renders LaTeX to MathML, which Chromium and WebView2 draw natively.
   KaTeX would mean shipping ~1 MB of base64 font files to keep the standalone
   build self-contained; MathML needs none. */
const MATH_BLOCK = /\$\$([\s\S]+?)\$\$/g;
const MATH_INLINE = /(?<!\\)\$(?!\s)((?:[^$\\\n]|\\.)+?)(?<!\s)\$(?!\d)/g;

function renderMath() {
  const walker = document.createTreeWalker(els.doc, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || n.nodeValue.indexOf('$') === -1) return NodeFilter.FILTER_REJECT;
      /* never touch code — a shell snippet is full of dollar signs */
      if (n.parentElement?.closest('code, pre, .findhit')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const src = node.nodeValue;
    let html = null;
    try {
      html = src
        .replace(MATH_BLOCK, (_, tex) => temml.renderToString(tex.trim(), { displayMode: true }))
        .replace(MATH_INLINE, (_, tex) => temml.renderToString(tex.trim(), { displayMode: false }));
    } catch {
      continue;
    }
    if (html === src) continue;
    const span = document.createElement('span');
    span.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true } });
    node.parentNode.replaceChild(span, node);
  }
}

/* ---------- mermaid ----------
   Loaded from a sibling file only when a document actually contains a diagram.
   The single-file build inlines everything and ships no sibling, so there the
   load fails, the diagram stays a syntax-highlighted code block, and the block
   says so — otherwise "not supported here" is indistinguishable from broken. */
let mermaidPromise = null;

function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  let script = null;
  const attempt = new Promise((resolve, reject) => {
    if (window.__mermaid) { resolve(window.__mermaid); return; }
    script = document.createElement('script');
    script.src = 'mermaid.js';
    script.onload = () => (window.__mermaid ? resolve(window.__mermaid) : reject(new Error('no mermaid')));
    script.onerror = () => reject(new Error('mermaid unavailable'));
    document.head.appendChild(script);
  });
  /* A rejected load must not be memoised for the rest of the window: the file
     was assigned once and never cleared, so one transient failure turned off
     diagrams until the app was restarted. Clear the memo and take the dead
     <script> back out of the document so the next document can retry. */
  mermaidPromise = attempt.catch((err) => {
    mermaidPromise = null;
    try { script?.remove(); } catch {}
    throw err;
  });
  return mermaidPromise;
}

/** True in a build that could never load mermaid.js, however many times it tries. */
function mermaidUnsupportedHere() {
  /* The packaged app and the served build both pull in sibling files; only the
     inlined single-file page has nothing to load mermaid.js from. */
  if (IS_TAURI) return false;
  return !document.querySelector('link[rel="stylesheet"], script[src]');
}

function noteMermaidUnsupported(blocks) {
  if (!mermaidUnsupportedHere()) return;
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre) continue;
    const note = document.createElement('p');
    note.className = 'mermaid-note';
    note.style.cssText = 'margin:0 0 12px;font-size:12.5px;color:var(--faint)';
    note.textContent = 'Diagrams need Mermaid, which this single-file build does not include. Open the file in the desktop app to see them.';
    pre.insertAdjacentElement('afterend', note);
  }
}

/** Mermaid's palette is global state, and the theme can change while a batch of
 *  diagrams is still drawing — so it is set per diagram, not captured once. */
function initMermaidTheme(mermaid) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const explicit = root.getAttribute('data-theme');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: (explicit === 'dark' || (!explicit && dark)) ? 'dark' : 'default',
  });
}

let mermaidSeq = 0;

async function renderMermaid() {
  const current = captureRenderGuard();
  const blocks = [...els.doc.querySelectorAll('pre > code.language-mermaid')];
  if (!blocks.length) return;

  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    /* leave the code blocks exactly as they are, but say why in a build that
       has no way to ever load Mermaid */
    if (current()) noteMermaidUnsupported(blocks);
    return;
  }

  if (!current()) return;

  for (const code of blocks) {
    const source = code.textContent;
    try {
      initMermaidTheme(mermaid);
      const { svg } = await mermaid.render('mmd-' + ++mermaidSeq, source);
      if (!current()) return;
      const figure = document.createElement('div');
      figure.className = 'mermaid-figure';
      figure.dataset.source = source;
      /* Defence in depth. Mermaid's own strict mode is the real boundary — it
         disables htmlLabels, so no foreignObject is produced — but diagram
         markup is still foreign content heading for this document. */
      figure.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      code.parentElement.replaceWith(figure);
    } catch {
      if (!current()) return;
      /* invalid diagram: keep the source visible rather than blanking it */
    }
  }
  if (current()) scheduleMeasure();
}

/** Re-render diagrams after a theme change so they don't stay the old palette. */
async function refreshMermaidTheme() {
  const figures = [...els.doc.querySelectorAll('.mermaid-figure[data-source]')];
  if (!figures.length || !window.__mermaid) return;
  for (const fig of figures) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = fig.dataset.source;
    pre.appendChild(code);
    fig.replaceWith(pre);
  }
  await renderMermaid();
}

const root = document.documentElement;
const $ = (s) => document.querySelector(s);

const els = {
  bar: $('#bar'),
  chrome: $('#chrome'),
  title: $('#title'),
  live: $('#live'),
  doc: $('#doc'),
  canvas: $('#canvas'),
  scroller: $('#scroller'),
  outline: $('#outline'),
  outlineList: $('#outline-list'),
  empty: $('#empty'),
  drop: $('#drop'),
  toast: $('#toast'),
  zoomval: $('#zoomval'),
  fileInput: $('#file-input'),
};

/* ======================================================================
   Tabs
   ----------------------------------------------------------------------
   Each open document is a tab holding its own source text, watch state and
   scroll position. `state` always points at the active one, so the rest of
   the app keeps reading state.path / state.name as before. Switching tabs
   re-renders from the stored text rather than keeping a DOM per tab —
   simpler, and fast enough for documents this size.
   ====================================================================== */

let tabs = [];
let tabSeq = 0;

function makeTab(init) {
  return Object.assign({
    id: ++tabSeq,
    name: '',
    path: null,      // native path, when opened through the shell
    handle: null,    // FileSystemFileHandle, when opened in a browser
    text: '',
    lastModified: 0,
    docDir: null,
    scrollTop: 0,
    scrollLeft: 0,
    heads: [],
    pending: null,
  }, init);
}

/* A placeholder until something is opened, so `state.x` is always safe. */
let state = makeTab({});
let renderRevision = 0;

/* Deferred DOM work must still belong to this exact rendered document. */
function captureRenderGuard() {
  const tab = state;
  const revision = renderRevision;
  return () => state === tab && tabs.includes(tab) && revision === renderRevision;
}

/* True only inside the Tauri shell. In a plain browser every file path below
   falls back to the web APIs. */
const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

/* ---------- tiny persistence ---------- */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('mdv.' + k); return v === null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) { try { localStorage.setItem('mdv.' + k, JSON.stringify(v)); } catch {} },
};

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('mdv', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readonly');
    const q = t.objectStore('kv').get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

/* ---------- settings ---------- */
/* WHEEL_BASE is the per-delta-unit exponent at speed 1×. A mouse wheel notch
   is deltaY 100, so 0.0022 lands on ~25% per notch — roughly a browser step.
   Trackpad pinch arrives as many small deltas and stays smooth at any speed. */
const WHEEL_BASE = 0.0022;
const DEFAULTS = { zoomSpeed: 1, textSize: 17, lineHeight: 1.68, invertZoom: false, openIn: 'tab', closeScope: 'tab', restoreTabs: false, updateOnStart: true };
let cfg = Object.assign({}, DEFAULTS, store.get('cfg', {}) || {});

/** % change a single mouse-wheel notch produces at the current speed. */
function notchPercent() {
  return Math.round((Math.exp(100 * WHEEL_BASE * cfg.zoomSpeed) - 1) * 100);
}

/**
 * Persist only the keys this call changed.
 *
 * Every window of the app is same-origin, so two windows share one localStorage.
 * Writing this window's whole in-memory `cfg` would silently roll back whatever
 * the other window just changed, so the stored object is re-read here and only
 * the named keys are merged over it.
 */
function saveCfgFields(changed) {
  const next = Object.assign({}, store.get('cfg', {}) || {});
  for (const k of changed) next[k] = cfg[k];
  store.set('cfg', next);
}

function applyCfg({ remeasure = true, save = true, changed = null } = {}) {
  cfg.zoomSpeed = Math.min(4, Math.max(0.25, Number(cfg.zoomSpeed) || 1));
  cfg.textSize = Math.min(26, Math.max(13, Number(cfg.textSize) || 17));
  cfg.lineHeight = Math.min(2.1, Math.max(1.3, Number(cfg.lineHeight) || 1.68));
  cfg.invertZoom = !!cfg.invertZoom;
  cfg.openIn = cfg.openIn === 'window' ? 'window' : 'tab';
  cfg.closeScope = cfg.closeScope === 'window' ? 'window' : 'tab';
  cfg.restoreTabs = !!cfg.restoreTabs;
  /* Default on, so anything but an explicit `false` keeps today's behaviour. */
  cfg.updateOnStart = cfg.updateOnStart !== false;

  root.style.setProperty('--base-size', cfg.textSize + 'px');
  root.style.setProperty('--line-height', String(cfg.lineHeight));

  $('#cfg-zoomspeed').value = String(cfg.zoomSpeed);
  $('#cfg-textsize').value = String(cfg.textSize);
  $('#cfg-lineheight').value = String(cfg.lineHeight);
  $('#cfg-invert').checked = cfg.invertZoom;
  $('#cfg-restore').checked = cfg.restoreTabs;
  $('#cfg-update-on-start').checked = cfg.updateOnStart;
  /* The hint is overwritten by the next check, so this only has to describe the
     state before one has happened. Keep it honest with the checkbox. */
  $('#cfg-update-hint').textContent = cfg.updateOnStart
    ? 'Checked automatically when the app starts'
    : 'Not checked automatically — use the button';
  $('#cfg-openin').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === cfg.openIn)));
  $('#cfg-openin-hint').textContent = cfg.openIn === 'window'
    ? 'Each file you open gets its own window'
    : 'Files you open join this window as tabs';
  $('#cfg-closescope').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === cfg.closeScope)));
  $('#cfg-closescope-hint').textContent = cfg.closeScope === 'window'
    ? 'Ctrl+W closes the window and every tab in it'
    : 'Ctrl+W closes one tab; Ctrl+Shift+W closes the window';
  $('#cfg-zoomspeed-val').textContent = cfg.zoomSpeed.toFixed(2).replace(/0$/, '') + '×';
  $('#cfg-zoomspeed-hint').textContent = 'about ' + notchPercent() + '% per wheel notch';
  $('#cfg-textsize-val').textContent = cfg.textSize + 'px';
  $('#cfg-lineheight-val').textContent = cfg.lineHeight.toFixed(2);

  if (save) saveCfgFields(changed || Object.keys(cfg));
  if (remeasure) measure();
}

function settingsOpen() { return $('#settings').classList.contains('on'); }

/* Whether the user is actually working inside the panel. Set while focus is in
   it, so closing restores focus to the trigger for a keyboard user but leaves a
   mouse user who clicked somewhere else alone. */
let settingsHadFocus = false;

function toggleSettings(force) {
  const on = force ?? !settingsOpen();
  /* Both panels are fixed at the same corner, so they may never be open
     together — one closes the other. */
  if (on && findBarOpen()) closeFind();
  $('#settings').classList.toggle('on', on);
  $('#btn-settings').setAttribute('aria-pressed', String(on));
  if (!on) {
    if (settingsHadFocus) { settingsHadFocus = false; $('#btn-settings').focus(); }
    return;
  }
  els.chrome.classList.remove('hidden');
  /* Focusing the first control fires focusin, which is what arms the restore. */
  settingsFocusables()[0]?.focus();
}

function settingsFocusables() {
  return [...$('#settings').querySelectorAll('input, button, select, [tabindex]')].filter((el) => !el.disabled);
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('on'), 1600);
}


/* ======================================================================
   Updater
   ----------------------------------------------------------------------
   Tauri's updater plugin fetches latest.json from the GitHub release, checks
   its minisign signature against the pubkey baked into tauri.conf.json, and
   swaps the installer in place. Everything below is just the UI around it:
   a quiet check on launch and a bar you can dismiss. Nothing installs
   without a click.

   Only the main window checks — extra document windows share the install,
   so prompting in each of them would just be noise.
   ====================================================================== */

const UPDATE_EVERY = 6 * 60 * 60 * 1000;   /* at most one silent check per 6h */
let pendingUpdate = null;                   /* the Update handle, once found */
let updateBusy = false;

function showUpdateBar(version) {
  $('#update-text').textContent = `Version ${version} is available`;
  $('#update').classList.add('on');
}

function hideUpdateBar() {
  $('#update').classList.remove('on');
}

/**
 * @param manual  true when the user pressed the settings button, which makes
 *                the "you are up to date" and error cases worth reporting.
 */
async function checkForUpdate({ manual = false } = {}) {
  if (!IS_TAURI) {
    if (manual) toast('Updates are only available in the desktop app');
    return;
  }
  if (updateBusy) return;

  if (!manual) {
    const last = store.get('updateCheckedAt', 0) || 0;
    if (Date.now() - last < UPDATE_EVERY) return;
  }

  if (manual) $('#cfg-update-hint').textContent = 'Checking…';
  updateBusy = true;
  /* Record the attempt, not the outcome. Written only on success, a permanently
     unreachable endpoint was retried on every single launch, forever. */
  store.set('updateCheckedAt', Date.now());
  try {
    const found = await checkUpdate();
    if (found) {
      pendingUpdate = found;
      /* A version the user already said no to stays dismissed until the next one. */
      if (manual || store.get('updateSkipped', '') !== found.version) {
        showUpdateBar(found.version);
      }
      $('#cfg-update-hint').textContent = `Version ${found.version} is ready to install`;
    } else {
      pendingUpdate = null;
      hideUpdateBar();
      $('#cfg-update-hint').textContent = 'You are on the latest version';
      if (manual) toast('You are on the latest version');
    }
  } catch (err) {
    $('#cfg-update-hint').textContent = 'Could not reach the update server';
    if (manual) toast('Could not check for updates');
  } finally {
    updateBusy = false;
  }
}

async function installUpdate() {
  if (!pendingUpdate || updateBusy) return;
  updateBusy = true;
  const btn = $('#update-go');
  btn.disabled = true;

  let total = 0;
  let got = 0;
  try {
    await pendingUpdate.downloadAndInstall((e) => {
      if (e.event === 'Started') { total = e.data.contentLength || 0; got = 0; btn.textContent = 'Downloading…'; }
      else if (e.event === 'Progress') {
        got += e.data.chunkLength || 0;
        btn.textContent = total ? `${Math.round((got / total) * 100)}%` : 'Downloading…';
      } else if (e.event === 'Finished') { btn.textContent = 'Installing…'; }
    });
    /* Windows hands off to the installer and exits on its own; elsewhere we
       restart into the new build ourselves. */
    await relaunch();
  } catch (err) {
    toast('Update failed — try downloading it from the releases page');
    btn.disabled = false;
    btn.textContent = 'Update';
    updateBusy = false;
  }
}

/* ======================================================================
   Zoom surface
   ----------------------------------------------------------------------
   #doc lays out once at its natural size and is then scaled with a CSS
   transform, exactly like browser pinch-zoom: no reflow, GPU-composited,
   and continuous rather than stepped. #canvas reserves the *scaled* box so
   the scroll container gets real scrollbars on both axes, which is what
   makes panning possible once the page is wider than the viewport.
   ====================================================================== */

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

let scale = clampScale((store.get('zoom', 100) || 100) / 100);
let natW = 0;      // natural (unscaled) width of #doc
let natH = 0;      // natural (unscaled) height of #doc
let docLeft = 0;   // horizontal offset that keeps the page centred
let measuring = false;

function clampScale(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }

/** Re-read the natural size of the document. Only needed when the content,
 *  the viewport, or a layout-affecting setting changes — never on zoom. */
let lastAvail = -1;

function measure() {
  if (measuring) return;
  const avail = els.scroller.clientWidth;

  /* A window that is hidden, minimised or still being shown lays out at zero
     width. Caching that would leave the document stuck at a few pixels with
     nothing to re-trigger it, so try again instead — requestAnimationFrame is
     suspended while hidden and fires as soon as the window appears. */
  if (!avail) { scheduleMeasure(); return; }

  measuring = true;
  lastAvail = avail;
  els.doc.style.transform = 'none';
  els.doc.style.width = avail + 'px';
  natW = els.doc.offsetWidth;
  natH = els.doc.offsetHeight;
  measuring = false;
  paint();
}

/* Belt and braces for the same problem: re-measure whenever the window
   becomes visible or finishes loading. */
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleMeasure(); });
window.addEventListener('load', () => scheduleMeasure());

/** Apply the current scale. Cheap: no layout reads. */
function paint() {
  const avail = els.scroller.clientWidth;
  const w = natW * scale;
  const h = natH * scale;
  const canvasW = Math.max(w, avail);
  docLeft = Math.max(0, (canvasW - w) / 2);
  els.canvas.style.width = canvasW + 'px';
  els.canvas.style.height = h + 'px';
  els.doc.style.transform = `translateX(${docLeft}px) scale(${scale})`;
  els.scroller.classList.toggle('pannable', w > avail + 1);
  els.zoomval.textContent = Math.round(scale * 100) + '%';
}

/**
 * Zoom to `next`, keeping the content point under (clientX, clientY) fixed.
 * Falls back to the viewport centre when no anchor is given.
 */
function zoomTo(next, clientX, clientY) {
  next = clampScale(next);
  if (Math.abs(next - scale) < 0.0001) return;

  const rect = els.scroller.getBoundingClientRect();
  /* Clamp: the pointer may be over the toolbar or sidebar, outside the scroller. */
  const vx = clientX == null ? rect.width / 2 : Math.min(rect.width, Math.max(0, clientX - rect.left));
  const vy = clientY == null ? rect.height / 2 : Math.min(rect.height, Math.max(0, clientY - rect.top));

  const cx = els.scroller.scrollLeft + vx;
  const cy = els.scroller.scrollTop + vy;
  const leftBefore = docLeft;
  const ratio = next / scale;

  scale = next;
  paint();

  els.scroller.classList.add('instant');
  els.scroller.scrollLeft = (cx - leftBefore) * ratio + docLeft - vx;
  els.scroller.scrollTop = cy * ratio - vy;
  els.scroller.classList.remove('instant');

  persistZoom();
}

/* A pinch fires dozens of wheel events a second and the button tween runs ~10
   frames; persisting on each one would mean a JSON write per frame. */
let zoomSaveTimer = 0;
function persistZoom() {
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => store.set('zoom', Math.round(scale * 100)), 250);
}

/* Button / keyboard zoom: tween so it reads as motion rather than a jump. */
const STEPS = [0.4, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
let tween = 0;

function zoomAnimated(target) {
  cancelAnimationFrame(tween);
  const from = scale;
  const to = clampScale(target);
  if (Math.abs(to - from) < 0.0001) return;
  /* rAF is suspended while the window is hidden, which would strand the tween
     part-way. Nothing to animate for an audience that cannot see it anyway. */
  if (document.hidden) { zoomTo(to); return; }
  const t0 = performance.now();
  const dur = 160;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    zoomTo(from + (to - from) * eased);
    if (k < 1) tween = requestAnimationFrame(step);
  };
  tween = requestAnimationFrame(step);
}

/** Scale so the document's text column exactly fills the viewport width. */
function zoomFitWidth() {
  if (!natW) return;
  const avail = els.scroller.clientWidth;
  zoomAnimated(clampScale(avail / natW));
  toast('Fit width');
}

function zoomStep(dir) {
  const eps = 0.0001;
  let next;
  if (dir > 0) {
    next = STEPS.find((s) => s > scale + eps) ?? STEPS[STEPS.length - 1];
  } else {
    const below = STEPS.filter((s) => s < scale - eps);
    next = below.length ? below[below.length - 1] : STEPS[0];
  }
  zoomAnimated(next);
}

/* Ctrl/Cmd + wheel, and trackpad pinch (which browsers report as ctrl+wheel).
   Continuous exponential scaling — small pinch deltas stay smooth, a mouse
   wheel notch lands on a browser-sized ~12% step. */
/* Bound to the window, not the scroller: over the toolbar or outline the event
   would otherwise fall through to WebView2's own ctrl+wheel zoom, giving two
   different zooms depending on where the cursor happened to be. */
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  cancelAnimationFrame(tween);
  const dir = cfg.invertZoom ? 1 : -1;
  zoomTo(scale * Math.exp(dir * e.deltaY * WHEEL_BASE * cfg.zoomSpeed), e.clientX, e.clientY);
}, { passive: false, capture: true });

/* ---------- pinch, the other ways it arrives ----------
   ctrl+wheel above covers Chromium's synthesized trackpad pinch. Two more
   paths exist and neither produces a wheel event:
     - a touchscreen or touch-capable surface, which gives two pointers
     - WebKit (macOS), which fires its own gesture* events
   Both are handled here so pinch works wherever the app runs. */

const livePointers = new Map();
let pinchStartDist = 0;
let pinchStartScale = 1;

function pinchDistance() {
  const [a, b] = [...livePointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function pinchCentre() {
  const [a, b] = [...livePointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

els.scroller.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  livePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (livePointers.size === 2) {
    pinchStartDist = pinchDistance();
    pinchStartScale = scale;
  }
}, { passive: true });

els.scroller.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch' || !livePointers.has(e.pointerId)) return;
  livePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (livePointers.size !== 2 || !pinchStartDist) return;
  e.preventDefault();
  cancelAnimationFrame(tween);
  const c = pinchCentre();
  zoomTo(pinchStartScale * (pinchDistance() / pinchStartDist), c.x, c.y);
}, { passive: false });

function dropPointer(e) {
  if (livePointers.delete(e.pointerId) && livePointers.size < 2) pinchStartDist = 0;
}
els.scroller.addEventListener('pointerup', dropPointer, { passive: true });
els.scroller.addEventListener('pointercancel', dropPointer, { passive: true });
els.scroller.addEventListener('pointerleave', dropPointer, { passive: true });

/* WebKit-only gesture events (macOS trackpads in a .app build) */
let gestureStartScale = 1;
window.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  gestureStartScale = scale;
}, { passive: false });
window.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  cancelAnimationFrame(tween);
  zoomTo(gestureStartScale * e.scale, e.clientX, e.clientY);
}, { passive: false });
window.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

/* ---------- panning ---------- */
/* Middle-drag or Alt+drag pans. Plain left-drag is left alone so that
   selecting text still works. Shift+wheel, trackpad swipes and the arrow
   keys already pan horizontally for free once overflow-x exists. */
let pan = null;

els.scroller.addEventListener('pointerdown', (e) => {
  const wants = e.button === 1 || (e.button === 0 && e.altKey);
  if (!wants) return;
  e.preventDefault();
  pan = {
    id: e.pointerId,
    x: e.clientX, y: e.clientY,
    left: els.scroller.scrollLeft, top: els.scroller.scrollTop,
  };
  try { els.scroller.setPointerCapture(e.pointerId); } catch {}
  els.scroller.classList.add('panning');
});

els.scroller.addEventListener('pointermove', (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  els.scroller.scrollLeft = pan.left - (e.clientX - pan.x);
  els.scroller.scrollTop = pan.top - (e.clientY - pan.y);
});

function endPan(e) {
  if (!pan || (e && e.pointerId !== pan.id)) return;
  try { els.scroller.releasePointerCapture(pan.id); } catch {}
  pan = null;
  els.scroller.classList.remove('panning');
}
els.scroller.addEventListener('pointerup', endPan);
els.scroller.addEventListener('pointercancel', endPan);
els.scroller.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

/* Keep the layout honest when the window or sidebar changes the viewport.
   Guarded on width: zooming changes #canvas, which can toggle a scrollbar,
   which would otherwise bounce us straight back into measure(). */
let resizeRaf = 0;
new ResizeObserver(() => {
  if (els.scroller.clientWidth === lastAvail) return;
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(measure);
}).observe(els.scroller);

/* ---------- render ---------- */
function slugify(text, used) {
  let base = text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'section';
  let out = base, n = 2;
  while (used.has(out)) out = base + '-' + n++;
  used.add(out);
  return out;
}

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

/* Obsidian / Jekyll / Hugo / Astro all open with a YAML block. Left in place
   it parses as a horizontal rule plus a bogus heading that then pollutes the
   outline, so strip it before the parser ever sees it.

   This is a line scan rather than one regex because a regex cannot tell a real
   closing fence from a `---` that is just content: a document opening with `---`
   used to lose everything up to the next `---` anywhere, a `+++` was allowed to
   close a `---` block, and a `---` inside a fenced code block ended the "front
   matter" early and left a stray fence that turned the rest of the file into one
   code block. So: the closing fence must match the opening one, and fenced code
   blocks in between are skipped entirely. A document with no matching pair comes
   back byte-identical. */
const FM_OPEN = /^(\uFEFF?)(---|\+\+\+)[ \t]*\r?\n/;
const FM_FENCE = /^(---|\+\+\+)[ \t]*$/;
const FM_CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

function stripFrontMatter(text) {
  const open = text.match(FM_OPEN);
  if (!open) return text;
  /* Keep each line's own terminator so a stripped document is reassembled
     byte-for-byte rather than re-joined with a guessed newline. */
  const lines = text.match(/[^\n]*\n|[^\n]+/g) || [];
  const marker = open[2];
  let inFence = false;
  let fenceChar = '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/, '');
    const code = line.match(FM_CODE_FENCE);
    if (code) {
      /* Inside a fenced block nothing closes the front matter, so a document
         whose own example contains `---` keeps its metadata intact. */
      if (!inFence) { inFence = true; fenceChar = code[1][0]; }
      else if (code[1][0] === fenceChar) inFence = false;
      continue;
    }
    if (inFence) continue;
    const close = line.match(FM_FENCE);
    if (close && close[1] === marker) return lines.slice(i + 1).join('');
  }
  return text;
}

function joinPath(dir, rel) {
  const sep = dir.includes('\\') ? '\\' : '/';
  /* Keep a leading empty segment (POSIX "/a/b") but drop trailing/interior
     ones, so a drive root like "C:\" does not produce a doubled separator. */
  const parts = dir.split(/[\\/]/).filter((p, i) => p !== '' || i === 0);
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join(sep);
}

function isAbsolutePath(p) {
  return /^([a-zA-Z]:[\\/]|[\\/]{1,2})/.test(p);
}

/* Rewrite relative <img src> through Tauri's asset protocol; without this a
   README that embeds ./screenshot.png just shows a broken image. */
function resolveImages() {
  if (!IS_TAURI || !state.docDir) return;
  els.doc.querySelectorAll('img[src]').forEach((img) => {
    const raw = img.getAttribute('src') || '';
    if (!raw || /^(https?:|data:|blob:|asset:|tauri:|file:)/i.test(raw)) return;
    let rel = raw;
    try { rel = decodeURIComponent(raw); } catch {}
    const abs = isAbsolutePath(rel) ? rel : joinPath(state.docDir, rel);
    try { img.src = convertFileSrc(abs); } catch {}
  });
}

/* ---------- links ----------
   Every link shape the parser can produce is decided here, because a click that
   is left to the browser navigates the window off the app page: the tab set, the
   outline, the scroll position and the live-reload watch all go with it. Worse,
   an href that resolves back to this app's own page — `index.html?file=<path>` —
   would make the boot code read an arbitrary local path, and same-origin
   navigation keeps the webview's IPC privileges. So nothing below is allowed to
   reach default navigation except an in-page `#` anchor and, in a plain browser,
   an `http(s)` link opened in a new tab. */
const DOC_EXT = /\.(?:md|markdown|mdown|mkd|mdx|txt)$/i;
const EXTERNAL_SCHEME = /^(?:https?|mailto|tel):/i;
const ANY_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** `protocol//host`, which stays meaningful for `tauri://` where `origin` is opaque. */
function urlRoot(u) {
  return u.protocol + '//' + u.host;
}

/** Resolve an href against the current page, or null if it is unparseable. */
function resolveHref(href) {
  const base = location && location.href ? location.href : undefined;
  try { return new URL(href, base); } catch { return null; }
}

/**
 * Turn a link target into a native path. `file:` URLs are decoded and made
 * absolute; a relative link is taken against the current document's folder, the
 * same rule the relative-image resolver uses.
 */
function linkToLocalPath(path) {
  let p = path;
  if (/^file:/i.test(p)) {
    const u = resolveHref(p);
    if (!u) return null;
    p = decodeURIComponent(u.pathname);
    /* A Windows file URL is /C:/dir/file.md — the leading slash is not part of the path. */
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  } else {
    try { p = decodeURIComponent(p); } catch {}
  }
  if (isAbsolutePath(p)) return p;
  return state.docDir ? joinPath(state.docDir, p) : p;
}

/**
 * Classify an href so render() can cancel the click unconditionally.
 * @returns {{kind:'anchor'|'top'|'external'|'doc'|'refuse'|'unsupported', path?:string}}
 */
function classifyLink(href) {
  if (href.startsWith('#')) return { kind: 'anchor' };
  if (!href.trim()) return { kind: 'top' };
  if (EXTERNAL_SCHEME.test(href)) return { kind: 'external' };
  /* Protocol-relative: a remote host, which is not a document and not this app. */
  if (href.startsWith('//')) return { kind: 'unsupported' };
  /* Drop any fragment and query before testing the extension: `index.html?file=x.md`
     ends in a markdown path but points back at this app, not at a document. */
  const bare = href.split('#')[0].split('?')[0];
  if (bare && DOC_EXT.test(bare) && (!ANY_SCHEME.test(bare) || /^file:/i.test(bare))) {
    const path = linkToLocalPath(bare);
    return path ? { kind: 'doc', path } : { kind: 'unsupported' };
  }
  /* Refuse anything that resolves to this app's own page. Blunt on purpose: a
     relative link into the app's own folder cannot open a document anyway, and
     the `?file=` re-entry above is the case that must never be reachable. */
  const target = resolveHref(href);
  const self = resolveHref(location && location.href ? location.href : '');
  if (target && self) {
    return urlRoot(target) === urlRoot(self) ? { kind: 'refuse' } : { kind: 'unsupported' };
  }
  /* With no resolvable page URL, a scheme-less href is a same-origin reference
     by definition, so refuse it rather than guess. */
  return ANY_SCHEME.test(href) ? { kind: 'unsupported' } : { kind: 'refuse' };
}

function render(text) {
  renderRevision++;
  const current = captureRenderGuard();
  const dirty = marked.parse(stripFrontMatter(text));
  els.doc.innerHTML = DOMPurify.sanitize(dirty, { ADD_ATTR: ['target', 'id'] });

  const used = new Set();
  /* The marked-footnote plugin injects its own `<h2 id="footnote-label" class="sr-only">Footnotes</h2>`
     into the footnotes section. That heading is not the author's content, so it
     gets no id, no anchor and no outline entry. (The class that visually hides
     it is styled in app.css, not here.) */
  const heads = [...els.doc.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .filter((h) => !h.closest('section.footnotes, [data-footnotes], .footnotes'));
  state.heads = heads.map((h) => {
    const title = h.textContent.trim();
    const id = slugify(title, used);
    h.id = id;
    const a = document.createElement('a');
    a.className = 'anchor';
    a.href = '#' + id;
    a.textContent = '#';
    a.setAttribute('aria-hidden', 'true');
    a.tabIndex = -1;
    h.prepend(a);
    return { el: h, id, title, level: Number(h.tagName[1]) };
  });

  els.doc.querySelectorAll('pre code').forEach((c) => {
    /* highlight.js has no Mermaid grammar, so it auto-detects a diagram as some
       arbitrary language, paints it in the wrong colours and logs a warning —
       on every render, just before Mermaid replaces the block. */
    if (!c.classList.contains('language-mermaid')) {
      try { hljs.highlightElement(c); } catch {}
    }
    const pre = c.parentElement;
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'btn copy';
    btn.type = 'button';
    btn.title = 'Copy code';
    btn.innerHTML = COPY_ICON;
    btn.style.cssText = 'position:absolute;top:6px;right:6px;opacity:0;transition:opacity .12s';
    pre.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    pre.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(c.textContent).then(
        () => { if (current()) toast('Copied'); },
        () => { if (current()) toast('Copy failed'); },
      );
    });
    pre.appendChild(btn);
  });

  els.doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const route = classifyLink(href);
    if (route.kind === 'anchor') {
      a.addEventListener('click', (e) => {
        const t = els.doc.querySelector('#' + CSS.escape(href.slice(1)));
        if (t) { e.preventDefault(); scrollToEl(t); }
      });
      return;
    }
    if (route.kind === 'external') {
      if (IS_TAURI) {
        /* The webview refuses target=_blank, so hand the URL to the OS. */
        a.addEventListener('click', (e) => {
          e.preventDefault();
          openUrl(href).catch(() => { if (current()) toast('Could not open link'); });
        });
      } else {
        /* A plain browser can do this itself — but only for http(s); mailto: and
           tel: still go through window.open so no href other than an in-page
           anchor ever reaches default navigation. */
        if (/^https?:/i.test(href)) {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          return;
        }
        a.addEventListener('click', (e) => {
          e.preventDefault();
          try { window.open(href, '_blank', 'noopener'); }
          catch { if (current()) toast('Could not open link'); }
        });
      }
      return;
    }
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (route.kind === 'doc') {
        if (IS_TAURI) openPath(route.path).catch(() => { if (current()) toast('Could not open that file'); });
        else if (current()) toast('Relative links only work in the desktop app');
        return;
      }
      if (route.kind === 'top') { els.scroller.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      if (route.kind === 'refuse') toast('Blocked: that link points back at the app');
      else toast('Cannot open that link');
    });
  });

  renderMath();
  resolveImages();

  /* An image that decodes after layout changes the document height, which
     would leave the measured zoom surface stale (short canvas, clipped scroll). */
  els.doc.querySelectorAll('img').forEach((img) => {
    if (img.complete) return;
    const loaded = () => { if (current()) scheduleMeasure(); };
    img.addEventListener('load', loaded, { once: true });
    img.addEventListener('error', loaded, { once: true });
  });

  buildOutline();
  updateDocMeta(text);
  measure();
  /* Diagrams finish after this call returns; the catch keeps a failure here
     from becoming an unhandled rejection. */
  renderMermaid().catch(() => {});
}

/** Word count and reading time for the toolbar. */
function updateDocMeta(source) {
  const el = $('#docmeta');
  if (!el) return;
  const words = (els.doc.textContent || '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) { el.textContent = ''; return; }
  const mins = Math.max(1, Math.round(words / 220));
  el.textContent = `${words.toLocaleString()} words · ${mins} min`;
}

let measureRaf = 0;
function scheduleMeasure() {
  cancelAnimationFrame(measureRaf);
  measureRaf = requestAnimationFrame(measure);
}

/* scrollIntoView is unreliable on transformed content — compute it instead */
function scrollToEl(el) {
  const top = el.offsetTop * scale - 60;
  els.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function buildOutline() {
  els.outlineList.innerHTML = '';
  if (!state.heads.length) {
    const p = document.createElement('div');
    p.style.cssText = 'padding:6px 8px;font-size:12.5px;color:var(--faint)';
    p.textContent = 'No headings';
    els.outlineList.appendChild(p);
    return;
  }
  const min = Math.min(...state.heads.map((h) => h.level));
  for (const h of state.heads) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.title;
    a.title = h.title;
    a.dataset.lvl = String(Math.min(h.level - min + 1, 4));
    a.dataset.id = h.id;
    a.addEventListener('click', (e) => { e.preventDefault(); scrollToEl(h.el); });
    els.outlineList.appendChild(a);
  }
}

/* ---------- document lifecycle ---------- */
/** Replace the active tab's content in place — used by live reload. */
function setDoc(text, resetScroll) {
  const keep = resetScroll ? 0 : els.scroller.scrollTop;
  const keepLeft = resetScroll ? 0 : els.scroller.scrollLeft;
  state.text = text;
  render(text);
  els.empty.classList.add('gone');
  els.scroller.classList.add('instant');
  els.scroller.scrollTop = keep;
  els.scroller.scrollLeft = keepLeft;
  const current = captureRenderGuard();
  requestAnimationFrame(() => { if (current()) els.scroller.classList.remove('instant'); });
  /* The native shell reopens by path, so caching the text there is dead weight
     — and this runs on every live-reload tick. */
  if (!(IS_TAURI && state.path) && text.length < 900000) {
    store.set('lastText', text);
    store.set('lastName', state.name);
  }
  updateTitle();
  syncOutlineActive();
  if ($('#find').classList.contains('on')) runFind($('#find-input').value, false);
}

function updateTitle() {
  if (!state.name) {
    els.title.textContent = '';
    document.title = 'Markdown Viewer';
    if (IS_TAURI) getCurrentWindow().setTitle(document.title).catch(() => {});
    return;
  }
  els.title.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = state.name;
  els.title.appendChild(b);
  if (state.pending && !state.handle) {
    const s = document.createElement('span');
    s.textContent = '  · click to reconnect';
    els.title.appendChild(s);
    els.title.style.cursor = 'pointer';
  } else {
    els.title.style.cursor = 'default';
  }
  document.title = state.name + ' — Markdown Viewer';
  /* document.title does not drive the OS titlebar in a native window */
  if (IS_TAURI) {
    getCurrentWindow().setTitle(document.title).catch(() => {});
  }
}

/** Browser path: a File (and optionally a handle) rather than a native path. */
async function loadFile(file, handle) {
  const text = await file.text();
  const existing = tabs.find((t) => !t.path && t.name === file.name);
  if (existing) {
    existing.text = text;
    existing.lastModified = file.lastModified;
    existing.handle = handle || null;
    activateTab(existing.id);
    if (state.id === existing.id) showActiveTab();
    return;
  }
  const tab = makeTab({
    name: file.name,
    text,
    lastModified: file.lastModified,
    handle: handle || null,
  });
  tabs.push(tab);
  stashScroll();
  state = tab;
  showActiveTab();
  els.scroller.focus({ preventScroll: true });
}

/** Clipboard content becomes its own tab, numbered so they stay tellable apart. */
function loadPasted(text) {
  const taken = tabs.filter((t) => /^Pasted text/.test(t.name)).length;
  const tab = makeTab({ name: taken ? `Pasted text ${taken + 1}` : 'Pasted text', text });
  tabs.push(tab);
  stashScroll();
  state = tab;
  showActiveTab();
}

async function openHandle(h) {
  try {
    const perm = await h.queryPermission?.({ mode: 'read' });
    if (perm === 'prompt') await h.requestPermission?.({ mode: 'read' });
  } catch {}
  const f = await h.getFile();
  await idbSet('handle', h).catch(() => {});
  await loadFile(f, h);
}

/* ---------- native (Tauri) file handling ---------- */

/** Directory of a document, for resolving relative image paths. */
function dirOf(path, name) {
  let dir = path.slice(0, Math.max(0, path.length - name.length - 1)) || null;
  if (dir && /^[a-zA-Z]:$/.test(dir)) dir += '\\';
  return dir;
}

/**
 * Open a file by native path.
 *
 * `allowNewWindow` is what makes the "open files in" setting work: an
 * externally-triggered open (file association, drag-drop, the Open dialog)
 * may spawn its own window, whereas restoring tabs at startup must not.
 *
 * @returns {Promise<boolean>} true when this call actually opened the file
 *   somewhere new (a tab, or a window when `allowNewWindow` applies), false when
 *   the path was already open and this call only selected the existing tab. A
 *   caller that needs to know whether anything was really restored has to use
 *   the return value: the already-open case resolves normally.
 */
async function openPath(path, { allowNewWindow = true } = {}) {
  /* already open? just go to it — never open the same file twice */
  const existing = tabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
  if (existing) {
    activateTab(existing.id);
    try { await getCurrentWindow().setFocus(); } catch {}
    return false;
  }

  if (allowNewWindow && IS_TAURI && cfg.openIn === 'window' && tabs.length > 0) {
    await openInNewWindow(path);
    return true;
  }

  const text = await invoke('read_text_file', { path });
  let mtime = 0;
  try { mtime = await invoke('file_mtime', { path }); } catch {}

  /* Another request may have opened this path while the read was pending. */
  const committed = tabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
  if (committed) {
    activateTab(committed.id);
    try { await getCurrentWindow().setFocus(); } catch {}
    return false;
  }

  const name = baseName(path);
  const tab = makeTab({ name, path, text, lastModified: mtime, docDir: dirOf(path, name) });
  tabs.push(tab);
  stashScroll();
  state = tab;
  store.set('lastPath', path);
  showActiveTab();
  els.scroller.focus({ preventScroll: true });
  return true;
}

/** Spawn a second app window already showing `path`. */
async function openInNewWindow(path) {
  try {
    const label = 'doc-' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const w = new WebviewWindow(label, {
      url: 'index.html?file=' + encodeURIComponent(path),
      title: baseName(path) + ' — Markdown Viewer',
      width: 1100,
      height: 820,
      dragDropEnabled: true,
    });
    await new Promise((resolve, reject) => {
      w.once('tauri://created', resolve);
      w.once('tauri://error', reject);
      setTimeout(resolve, 3000);
    });
  } catch (err) {
    toast('Could not open a new window');
    /* fall back to a tab rather than losing the file entirely */
    await openPath(path, { allowNewWindow: false });
  }
}

async function openViaPicker() {
  if (IS_TAURI) {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'] }],
      });
      const p = typeof sel === 'string' ? sel : sel?.path;
      if (p) await openPath(p);
    } catch (err) {
      toast('Could not open that file');
    }
    return;
  }
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: 'Markdown',
          accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx'], 'text/plain': ['.txt'] },
        }],
      });
      if (h) await openHandle(h);
    } catch {}
  } else {
    els.fileInput.click();
  }
}

/* ---------- live reload ---------- */
/* Editors that save atomically (VS Code, vim) delete and rename the file, so a
   poll can briefly fail on a perfectly healthy document. Give up only after a
   sustained run of failures, never on the first one. */
const WATCH_INTERVAL = 700;
const WATCH_MAX_FAILS = 20; // ~14s

let watchTimer = null;
let watchFails = 0;

/* ---------- watch-session guards ----------
   An asynchronous read belongs to the document and watch session that started
   it. `watchEpoch` is bumped whenever the active document or its watch session
   changes (tab switch, watch stop/restart, final close), so a read that
   finishes late is discarded instead of writing into whatever tab is now
   active — a tab-reference check alone is not enough, because switching
   A → B → A lands back on the original object. `opSeq` orders overlapping
   operations: only the newest one may commit, so an earlier slow read can
   never roll back a newer result. Polls wait while a read is in flight;
   explicit reloads supersede it. Stale IPC is ignored, not cancelled. */
let watchEpoch = 0;
let opSeq = 0;
let watchInFlight = null;

/** Snapshot taken before the first await of a reload/poll operation. */
function beginWatchOp() {
  const s = { tab: state, path: state.path, handle: state.handle, epoch: watchEpoch, op: ++opSeq };
  watchInFlight = s;
  return s;
}

/** True only while this exact operation is still the newest one for the
 *  still-active document in a still-current watch session. */
function watchOpCurrent(s) {
  return s.op === opSeq && s.epoch === watchEpoch && state === s.tab &&
    state.path === s.path && state.handle === s.handle && tabs.includes(s.tab);
}

function stopWatch() {
  watchEpoch++;   // invalidates every in-flight read for the old session
  watchInFlight = null;
  clearInterval(watchTimer);
  watchTimer = null;
  watchFails = 0;
  els.live.classList.remove('on');
  markActiveTabWatching(false);
}

function markActiveTabWatching(on) {
  const el = $('#tabbar .tab[aria-selected="true"]');
  if (el) el.dataset.watching = on ? 'yes' : 'no';
}

function onWatchError() {
  if (++watchFails >= WATCH_MAX_FAILS) {
    stopWatch();
    toast('Stopped watching — file unreadable');
  }
}

async function pollNative() {
  if (!state.path || !tabs.includes(state) || watchInFlight) return;
  const s = beginWatchOp();
  try {
    const m = await invoke('file_mtime', { path: s.path });
    if (!watchOpCurrent(s)) return;
    if (m !== s.tab.lastModified) {
      const text = await invoke('read_text_file', { path: s.path });
      if (!watchOpCurrent(s)) return;
      s.tab.lastModified = m;
      setDoc(text, false);
      toast('Reloaded');
    }
    watchFails = 0;
  } catch {
    if (watchOpCurrent(s)) onWatchError();
  } finally {
    if (watchInFlight === s) watchInFlight = null;
  }
}

async function pollHandle() {
  if (!state.handle || !tabs.includes(state) || watchInFlight) return;
  const s = beginWatchOp();
  try {
    const f = await s.handle.getFile();
    if (!watchOpCurrent(s)) return;
    if (f.lastModified !== s.tab.lastModified) {
      const text = await f.text();
      if (!watchOpCurrent(s)) return;
      s.tab.lastModified = f.lastModified;
      setDoc(text, false);
      toast('Reloaded');
    }
    watchFails = 0;
  } catch {
    if (watchOpCurrent(s)) onWatchError();
  } finally {
    if (watchInFlight === s) watchInFlight = null;
  }
}

function startWatch() {
  stopWatch();
  if (IS_TAURI && state.path) {
    els.live.classList.add('on');
    markActiveTabWatching(true);
    const epoch = watchEpoch;
    watchTimer = setInterval(() => { if (epoch === watchEpoch) pollNative(); }, WATCH_INTERVAL);
  } else if (state.handle) {
    els.live.classList.add('on');
    markActiveTabWatching(true);
    const epoch = watchEpoch;
    watchTimer = setInterval(() => { if (epoch === watchEpoch) pollHandle(); }, WATCH_INTERVAL);
  }
}

/** Force a re-read, ignoring mtime. Bound to F5. */
async function reloadNow() {
  if (!tabs.includes(state) || (!(IS_TAURI && state.path) && !state.handle)) return;
  /* Explicit reload supersedes pending work; timer ticks wait for it. */
  const s = beginWatchOp();
  try {
    if (IS_TAURI && s.path) {
      /* Sample metadata before reading: sampling afterwards could label old
         text with a newer save's mtime and make the next poll miss that save. */
      const mtime = await invoke('file_mtime', { path: s.path }).catch(() => 0);
      if (!watchOpCurrent(s)) return;
      const text = await invoke('read_text_file', { path: s.path });
      if (!watchOpCurrent(s)) return;
      s.tab.lastModified = mtime;
      setDoc(text, false);
      startWatch();
      toast('Reloaded');
    } else if (s.handle) {
      const f = await s.handle.getFile();
      if (!watchOpCurrent(s)) return;
      const text = await f.text();
      if (!watchOpCurrent(s)) return;
      s.tab.lastModified = f.lastModified;
      setDoc(text, false);
      startWatch();
      toast('Reloaded');
    }
  } catch {
    if (watchOpCurrent(s)) toast('Could not reload');
  } finally {
    if (watchInFlight === s) watchInFlight = null;
  }
}

/* ======================================================================
   Find in page
   ----------------------------------------------------------------------
   WebView2 gives the page no Ctrl+F of its own, so the app has to bring its
   own. Matches are wrapped in <mark> with zero padding so highlighting never
   reflows the document (which would invalidate the measured zoom surface).
   Matching is per text node: a query spanning an inline element boundary —
   "bold text" across `**bold** text` — will not match.
   ====================================================================== */

let findMarks = [];
let findIndex = -1;

function findBarOpen() { return $('#find').classList.contains('on'); }

/** Offset from the top of #doc, walking offsetParents (a <pre> is positioned). */
function offsetTopInDoc(el) {
  let y = 0;
  let node = el;
  while (node && node !== els.doc) {
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return y;
}

function clearFind() {
  for (const m of findMarks) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
  findMarks = [];
  findIndex = -1;
}

function updateFindCount() {
  const el = $('#find-count');
  const q = $('#find-input').value.trim();
  el.textContent = findMarks.length ? `${findIndex + 1}/${findMarks.length}` : (q ? '0/0' : '');
  el.classList.toggle('none', !!q && !findMarks.length);
}

function focusMatch(i, doScroll = true) {
  findMarks.forEach((m, k) => m.classList.toggle('current', k === i));
  const m = findMarks[i];
  if (!m) return;
  if (doScroll) {
    const top = offsetTopInDoc(m) * scale - els.scroller.clientHeight / 3;
    els.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
}

function runFind(query, scrollToFirst = true) {
  clearFind();
  const needle = (query || '').trim().toLowerCase();
  if (!needle) { updateFindCount(); return; }

  const walker = document.createTreeWalker(els.doc, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.classList.contains('anchor')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx === -1) continue;

    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'findhit';
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      findMarks.push(mark);
      last = idx + needle.length;
      idx = lower.indexOf(needle, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  findIndex = findMarks.length ? 0 : -1;
  focusMatch(findIndex, scrollToFirst);
  updateFindCount();
}

function findStep(dir) {
  if (!findMarks.length) return;
  findIndex = (findIndex + dir + findMarks.length) % findMarks.length;
  focusMatch(findIndex);
  updateFindCount();
}

function openFind() {
  /* Only one fixed panel at a time — they overlap in the same corner. */
  if (settingsOpen()) toggleSettings(false);
  $('#find').classList.add('on');
  $('#btn-find').setAttribute('aria-pressed', 'true');
  els.chrome.classList.remove('hidden');
  const input = $('#find-input');
  input.focus();
  input.select();
  if (input.value.trim()) runFind(input.value);
}

function closeFind() {
  $('#find').classList.remove('on');
  $('#btn-find').setAttribute('aria-pressed', 'false');
  clearFind();
  updateFindCount();
  els.scroller.focus({ preventScroll: true });
}

$('#find-input').addEventListener('input', (e) => runFind(e.target.value));
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
});
$('#find-next').addEventListener('click', () => findStep(1));
$('#find-prev').addEventListener('click', () => findStep(-1));
$('#find-close').addEventListener('click', closeFind);
$('#btn-find').addEventListener('click', (e) => { e.stopPropagation(); findBarOpen() ? closeFind() : openFind(); });
$('#find').addEventListener('click', (e) => e.stopPropagation());

function baseName(p) { return p.split(/[\\/]/).pop() || p; }

/* ---------- tab bar ---------- */
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function renderTabs() {
  root.setAttribute('data-tabs', tabs.length > 1 ? 'many' : 'one');
  const bar = $('#tabbar');
  bar.innerHTML = '';

  for (const t of tabs) {
    const selected = t.id === state.id;
    const el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('id', 'tab-' + t.id);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(selected));
    el.setAttribute('aria-controls', 'doc');
    /* Roving tabindex: the strip is a single tab stop, and the arrows move
       within it. The close button is not a stop of its own (see below). */
    el.tabIndex = selected ? 0 : -1;
    el.dataset.watching = selected && watchTimer ? 'yes' : 'no';
    el.title = t.path || t.name;

    const dot = document.createElement('span');
    dot.className = 'tab-dot';

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name || 'Untitled';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.setAttribute('aria-label', `Close ${t.name}`);
    /* Not a focus stop: the strip is one tab stop, and an 18px button that a
       keyboard user has to arrow past on every tab is worse than none. The
       mouse and middle-click paths are unchanged; Delete closes the focused
       tab. */
    close.tabIndex = -1;
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });

    el.append(dot, name, close);
    el.addEventListener('click', () => activateTab(t.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    bar.appendChild(el);
  }

  /* The panel is the target of every tab, and is named by the selected one. */
  if (tabs.length) els.doc.setAttribute('aria-labelledby', 'tab-' + state.id);

  const active = bar.querySelector('.tab[aria-selected="true"]');
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Focus the selected tab. The strip is rebuilt on every switch, so focus has
 *  to be put back after a move rather than kept. */
function focusSelectedTab() {
  $('#tabbar').querySelector('.tab[aria-selected="true"]')?.focus();
}

/* Arrow keys, Home, End and Delete — scoped to the strip, so they never fight
   the document's own arrow scrolling or the Find box. */
$('#tabbar').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const i = tabs.findIndex((t) => t.id === state.id);
  if (i === -1) return;
  let next;
  if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    closeTab(state.id);
    focusSelectedTab();
    return;
  } else return;
  e.preventDefault();
  activateTab(tabs[next].id);
  focusSelectedTab();
});

/** Remember where we were before leaving a tab. */
function stashScroll() {
  if (!state.id) return;
  state.scrollTop = els.scroller.scrollTop;
  state.scrollLeft = els.scroller.scrollLeft;
}

function activateTab(id) {
  if (id === state.id) return;
  const next = tabs.find((t) => t.id === id);
  if (!next) return;
  stashScroll();
  state = next;
  showActiveTab();
}

function showActiveTab() {
  startWatch(); // invalidate the previous active session before rendering
  render(state.text);
  els.empty.classList.add('gone');
  els.scroller.classList.add('instant');
  els.scroller.scrollTop = state.scrollTop;
  els.scroller.scrollLeft = state.scrollLeft;
  const current = captureRenderGuard();
  requestAnimationFrame(() => { if (current()) els.scroller.classList.remove('instant'); });
  updateTitle();
  renderTabs();
  syncOutlineActive();
  persistTabs();
  if (findBarOpen()) runFind($('#find-input').value, false);
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i === -1) return;
  const wasActive = tabs[i].id === state.id;
  const [closed] = tabs.splice(i, 1);
  if (closed.path) rememberClosed([closed.path]);

  if (!tabs.length) {
    stopWatch();
    renderRevision++;
    clearFind();
    updateFindCount();
    state = makeTab({});
    els.doc.innerHTML = '';
    els.empty.classList.remove('gone');
    els.outlineList.innerHTML = '';
    $('#docmeta').textContent = '';
    updateTitle();
    renderTabs();
    persistTabs();
    measure();
    els.scroller.scrollTop = 0;
    els.scroller.scrollLeft = 0;
    els.scroller.classList.remove('instant');
    /* Like a browser: the last tab takes its window with it. */
    if (IS_TAURI) destroyWindow();
    return;
  }
  if (wasActive) {
    state = tabs[Math.min(i, tabs.length - 1)];
    showActiveTab();
  } else {
    renderTabs();
    persistTabs();
  }
}

function stepTab(dir) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === state.id);
  activateTab(tabs[(i + dir + tabs.length) % tabs.length].id);
}

/* Ctrl+Shift+W, and Ctrl+W when the close scope is set to the whole window.
   In a browser tab there is nothing to close, so drop every tab instead. */
function closeWindow() {
  if (IS_TAURI) {
    const paths = tabs.map((t) => t.path).filter(Boolean);
    if (paths.length) rememberClosed(paths);
    destroyWindow();
    return;
  }
  while (tabs.length) closeTab(tabs[tabs.length - 1].id);
}

/** What Ctrl+W does, per the close-scope setting. */
function closeRequested() {
  if (cfg.closeScope === 'window') { closeWindow(); return; }
  if (state.id) closeTab(state.id);
}

let isMainWindow = true;
let windowLabel = 'main';

/* ---------- session and recently closed ----------
   `session` maps each live window's label to its open paths. Quitting (title-bar
   close / Alt+F4) exits without running any page code, so it must always be
   current. The next launch either restores it (setting) or turns it into one
   Ctrl+Shift+T entry, the way a browser does. */
const CLOSED_MAX = 25;

function readSession() {
  const s = store.get('session', {});
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

function persistTabs() {
  if (!IS_TAURI) return;
  const session = readSession();
  const paths = tabs.map((t) => t.path).filter(Boolean);
  if (paths.length) session[windowLabel] = paths;
  else delete session[windowLabel];
  store.set('session', session);
}

function cleanPaths(list) {
  return Array.isArray(list)
    ? list.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : [];
}

function rememberClosed(paths) {
  if (!IS_TAURI) return;
  const stack = store.get('closed', []);
  const next = (Array.isArray(stack) ? stack : []).concat([paths]).slice(-CLOSED_MAX);
  store.set('closed', next);
}

/** Ctrl+Shift+T: reopen the most recently closed tab, window or session. */
async function reopenClosed() {
  if (!IS_TAURI) return;
  const stack = store.get('closed', []);
  if (!Array.isArray(stack) || !stack.length) { toast('Nothing to reopen'); return; }
  const paths = cleanPaths(stack.pop());
  store.set('closed', stack);
  let opened = 0;
  const failed = [];
  for (const p of paths) {
    /* Already-open paths only select a tab: they are not failures, but do
       not count as genuinely reopened either. */
    try {
      if (await openPath(p, { allowNewWindow: false })) opened++;
    } catch {
      failed.push(p); /* moved or deleted */
    }
  }
  /* Put back only the paths that genuinely failed, so a partially-restored
     group keeps its remainder recoverable. */
  if (failed.length) rememberClosed(failed);
  if (!opened) toast('Could not reopen that file');
}

/** Close this window without the native close request, which quits the app. */
function destroyWindow() {
  const session = readSession();
  delete session[windowLabel];
  store.set('session', session);
  getCurrentWindow().destroy().catch(() => {});
}

/** Step to the next/previous markdown file sitting in the same folder. */
async function stepFile(dir) {
  if (!IS_TAURI || !state.path) return;
  let siblings;
  try {
    siblings = await invoke('sibling_files', { path: state.path });
  } catch {
    return;
  }
  if (!siblings || siblings.length < 2) { toast('No other files in this folder'); return; }
  const lower = state.path.toLowerCase();
  const i = siblings.findIndex((p) => p.toLowerCase() === lower);
  if (i === -1) return;
  const next = siblings[(i + dir + siblings.length) % siblings.length];
  try {
    await openPath(next);
    toast(`${baseName(next)}  (${((i + dir + siblings.length) % siblings.length) + 1}/${siblings.length})`);
  } catch {
    toast('Could not open that file');
  }
}

/* ---------- appearance ---------- */
const THEMES = ['auto', 'light', 'dark'];
let theme = window.__mdvTheme.read();
function applyTheme(t, announce, save = true) {
  theme = window.__mdvTheme.apply(t);
  if (save) store.set('theme', theme);
  $('#btn-theme').setAttribute('aria-pressed', String(theme !== 'auto'));
  $('#btn-theme').title = 'Theme: ' + theme + ' (t)';
  /* Diagrams are re-rendered after the change, which finishes later. */
  refreshMermaidTheme().catch(() => {});
  if (announce) toast('Theme: ' + theme);
}

const WIDTHS = ['normal', 'wide', 'full'];
let width = store.get('width', 'normal');
function applyWidth(w, announce, save = true) {
  width = WIDTHS.includes(w) ? w : 'normal';
  root.setAttribute('data-width', width);
  if (save) store.set('width', width);
  $('#btn-width').setAttribute('aria-pressed', String(width !== 'normal'));
  $('#btn-width').title = 'Width: ' + width + ' (w)';
  measure();
  if (announce) toast('Width: ' + width);
}

let font = store.get('font', 'sans');
function applyFont(f, announce, save = true) {
  font = f === 'serif' ? 'serif' : 'sans';
  root.setAttribute('data-font', font);
  if (save) store.set('font', font);
  $('#btn-font').setAttribute('aria-pressed', String(font === 'serif'));
  $('#btn-font').title = 'Font: ' + font + ' (f)';
  measure();
  if (announce) toast('Font: ' + font);
}

let outlineOn = store.get('outline', false);
function applyOutline(on, announce, save = true) {
  outlineOn = !!on;
  root.setAttribute('data-outline', outlineOn ? 'on' : 'off');
  if (save) store.set('outline', outlineOn);
  $('#btn-outline').setAttribute('aria-pressed', String(outlineOn));
  syncOutlineActive();
  if (announce) toast(outlineOn ? 'Outline shown' : 'Outline hidden');
}

/* Another window of this app is same-origin, so its `storage` write genuinely
   arrives here. Re-read and repaint without writing back — writing from inside
   this handler would bounce straight back and could ping-pong. `session` and
   `closed` are deliberately absent: both are re-read immediately before each
   write, so a listener there would only fight the write path. */
window.addEventListener('storage', (e) => {
  if (!e || !String(e.key || '').startsWith('mdv.')) return;
  switch (e.key.slice(4)) {
    case 'cfg':
      cfg = Object.assign({}, DEFAULTS, store.get('cfg', {}) || {});
      break;
    case 'theme':
      applyTheme(store.get('theme', 'auto'), false, false);
      break;
    case 'width':
      applyWidth(store.get('width', 'normal'), false, false);
      break;
    case 'font':
      applyFont(store.get('font', 'sans'), false, false);
      break;
    case 'outline':
      applyOutline(store.get('outline', false), false, false);
      break;
    default:
      return;
  }
  applyCfg({ remeasure: false, save: false });
});

/* ---------- scroll behaviour ---------- */
let lastScroll = 0;
function syncOutlineActive() {
  if (!outlineOn || !state.heads.length) return;
  let active = state.heads[0];
  for (const h of state.heads) {
    if (h.el.getBoundingClientRect().top <= 90) active = h; else break;
  }
  els.outlineList.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', a.dataset.id === active.id);
  });
}

els.scroller.addEventListener('scroll', () => {
  const y = els.scroller.scrollTop;
  els.chrome.classList.toggle('scrolled', y > 4);
  if (y > 90 && y > lastScroll + 6) els.chrome.classList.add('hidden');
  else if (y < lastScroll - 6 || y <= 90) els.chrome.classList.remove('hidden');
  lastScroll = y;
  syncOutlineActive();
}, { passive: true });

window.addEventListener('mousemove', (e) => {
  if (e.clientY < 56) els.chrome.classList.remove('hidden');
});

/* ---------- printing ----------
   window.print() is a silent no-op on Windows — WebView2 does not implement it
   — so printing is routed natively: the app's own `print_windows` command on
   Windows, the Tauri webview window's print() on macOS and Linux (where wry
   reaches a real native dialog), and the browser's own dialog on the web.
   A failure is reported, never swallowed: a button that silently does nothing
   is the defect this replaces. */
const IS_WINDOWS = /win/i.test(`${navigator.userAgent || ''} ${navigator.platform || ''}`);

async function printDocument() {
  try {
    if (!IS_TAURI) { window.print(); return; }
    if (IS_WINDOWS) { await invoke('print_windows'); return; }
    await getCurrentWebviewWindow().print();
  } catch {
    toast('Could not open the print dialog');
  }
}

/* Input types that are not text entry: a focused slider or checkbox is a
   control the user is operating, not typing into, so the bare-key shortcuts
   stay available there. */
const NON_TEXT_INPUT = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** True when a bare keypress would be consumed as typing or as a button press. */
function inTextEntry(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') return !NON_TEXT_INPUT.has((target.type || '').toLowerCase());
  /* Buttons (including the settings radio groups) and selects have no text to
     type, but a bare letter on one is just as mysterious as typing. */
  return tag === 'button' || tag === 'select';
}

/* ---------- keyboard ---------- */
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;

  /* Escape works even from inside the settings panel's own controls, and
     closes exactly one thing: the Find box handles its own Escape and stops
     the event there. */
  if (e.key === 'Escape') {
    e.preventDefault();
    if (findBarOpen()) { closeFind(); return; }
    if (settingsOpen()) { toggleSettings(false); return; }
    els.scroller.focus({ preventScroll: true });
    return;
  }

  /* Only bare keys are suppressed inside text entry. Modifier combinations and
     function keys are app-wide, so a focused slider, checkbox or search box
     cannot lock the user out of Ctrl+O, Ctrl+Tab, F5 and the rest. */
  if (inTextEntry(e.target) && !mod && !e.altKey && !/^F\d+$/.test(e.key)) return;

  if (mod && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    e.shiftKey ? closeWindow() : closeRequested();
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    reopenClosed();
    return;
  }

  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomStep(-1); return; }
  if (mod && e.key === '0') { e.preventDefault(); zoomAnimated(1); return; }
  if (mod && e.key === '9') { e.preventDefault(); zoomFitWidth(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openViaPicker(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
  if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); printDocument(); return; }
  if (mod && e.key === 'Tab') { e.preventDefault(); stepTab(e.shiftKey ? -1 : 1); return; }
  if (mod && (e.key === 'PageDown' || e.key === 'PageUp')) {
    e.preventDefault();
    stepTab(e.key === 'PageDown' ? 1 : -1);
    return;
  }
  if (mod && /^[1-8]$/.test(e.key)) {
    e.preventDefault();
    const t = tabs[Number(e.key) - 1];
    if (t) activateTab(t.id);
    return;
  }
  if (e.key === 'F3') { e.preventDefault(); findBarOpen() ? findStep(e.shiftKey ? -1 : 1) : openFind(); return; }
  if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) { e.preventDefault(); reloadNow(); return; }
  if (mod) return;

  switch (e.key) {
    case '[': stepFile(-1); break;
    case ']': stepFile(1); break;
    case ',': toggleSettings(); break;
    case 'o': applyOutline(!outlineOn, true); break;
    case 't': applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % 3], true); break;
    case 'w': applyWidth(WIDTHS[(WIDTHS.indexOf(width) + 1) % 3], true); break;
    case 'f': applyFont(font === 'sans' ? 'serif' : 'sans', true); break;
    default: return;
  }
  e.preventDefault();
});

/* ---------- drag and drop ---------- */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; els.drop.classList.add('on'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; els.drop.classList.remove('on'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.classList.remove('on');
  const item = e.dataTransfer?.items?.[0];
  if (item && item.getAsFileSystemHandle) {
    try {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === 'file') { await openHandle(h); return; }
    } catch {}
  }
  const f = e.dataTransfer?.files?.[0];
  if (f) { stopWatch(); await loadFile(f, null); }
});

/* Readiness must wait for registration as well as boot, including URL opens. */
let externalOpenListener = Promise.resolve();

/* The native shell swallows HTML drop events, so wire Tauri's own instead. */
if (IS_TAURI) {
  listen('tauri://drag-enter', () => els.drop.classList.add('on'));
  listen('tauri://drag-leave', () => els.drop.classList.remove('on'));
  listen('tauri://drag-drop', (e) => {
    els.drop.classList.remove('on');
    const p = e.payload?.paths?.[0];
    if (p) openPath(p).catch(() => toast('Could not open that file'));
  });
  /* second launch (double-clicking another .md) routes through single-instance */
  externalOpenListener = listen('open-file', async (e) => {
    if (!e.payload) return;
    try {
      if (await invoke('claim_external_open', { path: e.payload })) await openPath(e.payload);
    } catch { toast('Could not open that file'); }
  }, { target: { kind: 'WebviewWindow', label: getCurrentWindow().label } });
  /* Handle early registration failure immediately; readiness still observes it. */
  externalOpenListener.catch(() => {});
}

window.addEventListener('paste', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text || !text.trim()) return;
  loadPasted(text);
  toast('Rendered from clipboard');
});

/* ---------- buttons ---------- */
$('#btn-open').addEventListener('click', openViaPicker);
$('#btn-zoom-in').addEventListener('click', () => zoomStep(1));
$('#btn-zoom-out').addEventListener('click', () => zoomStep(-1));
els.zoomval.addEventListener('click', () => zoomAnimated(1));
$('#btn-outline').addEventListener('click', () => applyOutline(!outlineOn, false));
$('#btn-theme').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % 3], false));
$('#btn-width').addEventListener('click', () => applyWidth(WIDTHS[(WIDTHS.indexOf(width) + 1) % 3], false));
$('#btn-font').addEventListener('click', () => applyFont(font === 'sans' ? 'serif' : 'sans', false));
$('#btn-print').addEventListener('click', printDocument);
$('#btn-settings').addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
$('#btn-fit').addEventListener('click', zoomFitWidth);

/* settings controls — live, no apply button */
const bindRange = (id, key) => {
  $(id).addEventListener('input', (e) => {
    cfg[key] = Number(e.target.value);
    applyCfg({ remeasure: key !== 'zoomSpeed', changed: [key] });
  });
};
bindRange('#cfg-zoomspeed', 'zoomSpeed');
bindRange('#cfg-textsize', 'textSize');
bindRange('#cfg-lineheight', 'lineHeight');
$('#cfg-invert').addEventListener('change', (e) => {
  cfg.invertZoom = e.target.checked;
  applyCfg({ remeasure: false, changed: ['invertZoom'] });
});
$('#cfg-restore').addEventListener('change', (e) => {
  cfg.restoreTabs = e.target.checked;
  applyCfg({ remeasure: false, changed: ['restoreTabs'] });
});
$('#cfg-update-on-start').addEventListener('change', (e) => {
  cfg.updateOnStart = e.target.checked;
  applyCfg({ remeasure: false, changed: ['updateOnStart'] });
});
$('#cfg-openin').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  cfg.openIn = btn.dataset.val;
  applyCfg({ remeasure: false, changed: ['openIn'] });
});
$('#cfg-closescope').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  cfg.closeScope = btn.dataset.val;
  applyCfg({ remeasure: false, changed: ['closeScope'] });
});
$('#cfg-check').addEventListener('click', () => checkForUpdate({ manual: true }));
$('#update-go').addEventListener('click', installUpdate);
$('#update-later').addEventListener('click', () => {
  if (pendingUpdate) store.set('updateSkipped', pendingUpdate.version);
  hideUpdateBar();
});
$('#cfg-reset').addEventListener('click', () => {
  cfg = Object.assign({}, DEFAULTS);
  applyCfg({ changed: Object.keys(DEFAULTS) });
  toast('Settings reset');
});
$('#settings').addEventListener('click', (e) => e.stopPropagation());
/* Keep Tab inside the panel while it is open, and remember that the user is in
   it so closing can hand focus back to the trigger. */
$('#settings').addEventListener('focusin', () => { settingsHadFocus = true; });
$('#settings').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !settingsOpen()) return;
  const items = settingsFocusables();
  if (!items.length) return;
  const active = document.activeElement;
  const inside = !!(active && active.closest && active.closest('#settings'));
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
});
document.addEventListener('click', () => toggleSettings(false));
$('#empty-open').addEventListener('click', openViaPicker);
els.title.addEventListener('click', async () => {
  if (state.pending && !state.handle) { try { await openHandle(state.pending); } catch {} }
});
els.fileInput.addEventListener('change', async () => {
  const f = els.fileInput.files?.[0];
  if (f) { stopWatch(); await loadFile(f, null); }
  els.fileInput.value = '';
});

/* ---------- boot ---------- */
applyCfg({ remeasure: false, save: false });
applyTheme(theme, false);
applyWidth(width, false);
applyFont(font, false);
applyOutline(outlineOn, false);
paint();

const boot = (async function boot() {
  renderTabs();

  if (IS_TAURI) {
    /* A window spawned by "open in new window" is told which file to show and
       must not touch the saved tab set — that belongs to the original window. */
    try { windowLabel = getCurrentWindow().label; } catch {}
    isMainWindow = windowLabel === 'main';

    const params = new URLSearchParams(location.search);
    const requested = params.get('file');
    if (requested) {
      try {
        const owned = params.get('externalOpen') !== '1' ||
          await invoke('claim_external_open', { path: requested });
        if (owned) await openPath(requested, { allowNewWindow: false });
      } catch { toast('Could not open that file'); }
      els.scroller.focus({ preventScroll: true });
      return;
    }

    /* a file passed on the command line wins over the restored session */
    let initial = null;
    try { initial = await invoke('initial_file'); } catch {}

    /* Only the first window of a launch picks up what the last run left open,
       every window's tabs included. */
    let saved = [];
    if (isMainWindow) {
      const last = readSession();
      const legacy = store.get('openTabs', null);
      if (legacy !== null) last.legacy = legacy;
      try { localStorage.removeItem('mdv.openTabs'); } catch {}
      store.set('session', {});
      const seen = new Set();
      for (const p of Object.values(last).flatMap(cleanPaths)) {
        if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); saved.push(p); }
      }
      if (!cfg.restoreTabs && saved.length) { rememberClosed(saved); saved = []; }
    }
    for (const p of saved) {
      if (initial && p.toLowerCase() === initial.toLowerCase()) continue;
      try { await openPath(p, { allowNewWindow: false }); } catch { /* moved or deleted */ }
    }
    if (initial) {
      try { await openPath(initial, { allowNewWindow: false }); } catch { toast('Could not open that file'); }
    }
    if (!tabs.length) persistTabs();
    els.scroller.focus({ preventScroll: true });
    return;
  }

  /* browser: restore the last rendered text so the page is not blank */
  const lastText = store.get('lastText', null);
  const lastName = store.get('lastName', '');
  if (lastText) {
    const tab = makeTab({ name: lastName || 'Untitled.md', text: lastText });
    tabs.push(tab);
    state = tab;
    showActiveTab();
  }

  try {
    const h = await idbGet('handle');
    if (!h) return;
    const perm = await h.queryPermission?.({ mode: 'read' });
    if (perm === 'granted') {
      await openHandle(h);
    } else {
      state.pending = h;
      if (!state.name) state.name = h.name;
      updateTitle();
    }
  } catch {}
  els.scroller.focus({ preventScroll: true });
})();

boot.finally(async () => {
  if (!IS_TAURI) return;
  await externalOpenListener;
  await invoke('external_open_ready');
}).catch(() => toast('Could not finish startup'));

/* Version label and the launch update check live outside boot() so its early
   returns cannot skip them, and run late so they never compete with first
   paint. Only the main window prompts; document windows share the install. */
if (IS_TAURI) {
  getVersion().then((v) => { $('#cfg-version').textContent = 'v' + v; }).catch(() => {});
  let bootLabel = 'main';
  try { bootLabel = getCurrentWindow().label; } catch {}
  /* The setting gates the automatic check only — the Settings button still
     checks whenever it is pressed, which is what makes it a preference. */
  if (bootLabel === 'main' && cfg.updateOnStart) setTimeout(() => { checkForUpdate(); }, 3000);
} else {
  $('#cfg-update').style.display = 'none';
  $('#cfg-update-start-field').style.display = 'none';
  $('#cfg-restore-field').style.display = 'none';
}
