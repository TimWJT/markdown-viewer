import './startup.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

/* Tauri APIs. Safe to import in a plain browser — nothing touches the native
   bridge until called, and every call site is behind the IS_TAURI check. */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
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
   Absent in the standalone single-file build, where the fetch simply fails and
   the diagram stays a syntax-highlighted code block. */
let mermaidPromise = null;

function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve, reject) => {
    if (window.__mermaid) { resolve(window.__mermaid); return; }
    const s = document.createElement('script');
    s.src = 'mermaid.js';
    s.onload = () => (window.__mermaid ? resolve(window.__mermaid) : reject(new Error('no mermaid')));
    s.onerror = () => reject(new Error('mermaid unavailable'));
    document.head.appendChild(s);
  });
  return mermaidPromise;
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
    return; /* leave the code blocks exactly as they are */
  }

  if (!current()) return;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const explicit = root.getAttribute('data-theme');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: (explicit === 'dark' || (!explicit && dark)) ? 'dark' : 'default',
  });

  for (const code of blocks) {
    const source = code.textContent;
    try {
      const { svg } = await mermaid.render('mmd-' + ++mermaidSeq, source);
      if (!current()) return;
      const figure = document.createElement('div');
      figure.className = 'mermaid-figure';
      figure.dataset.source = source;
      figure.innerHTML = svg;
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
const DEFAULTS = { zoomSpeed: 1, textSize: 17, lineHeight: 1.68, invertZoom: false, openIn: 'tab', closeScope: 'tab', restoreTabs: false };
let cfg = Object.assign({}, DEFAULTS, store.get('cfg', {}) || {});

/** % change a single mouse-wheel notch produces at the current speed. */
function notchPercent() {
  return Math.round((Math.exp(100 * WHEEL_BASE * cfg.zoomSpeed) - 1) * 100);
}

function applyCfg({ remeasure = true, save = true } = {}) {
  cfg.zoomSpeed = Math.min(4, Math.max(0.25, Number(cfg.zoomSpeed) || 1));
  cfg.textSize = Math.min(26, Math.max(13, Number(cfg.textSize) || 17));
  cfg.lineHeight = Math.min(2.1, Math.max(1.3, Number(cfg.lineHeight) || 1.68));
  cfg.invertZoom = !!cfg.invertZoom;
  cfg.openIn = cfg.openIn === 'window' ? 'window' : 'tab';
  cfg.closeScope = cfg.closeScope === 'window' ? 'window' : 'tab';
  cfg.restoreTabs = !!cfg.restoreTabs;

  root.style.setProperty('--base-size', cfg.textSize + 'px');
  root.style.setProperty('--line-height', String(cfg.lineHeight));

  $('#cfg-zoomspeed').value = String(cfg.zoomSpeed);
  $('#cfg-textsize').value = String(cfg.textSize);
  $('#cfg-lineheight').value = String(cfg.lineHeight);
  $('#cfg-invert').checked = cfg.invertZoom;
  $('#cfg-restore').checked = cfg.restoreTabs;
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

  if (save) store.set('cfg', cfg);
  if (remeasure) measure();
}

function toggleSettings(force) {
  const on = force ?? !$('#settings').classList.contains('on');
  $('#settings').classList.toggle('on', on);
  $('#btn-settings').setAttribute('aria-pressed', String(on));
  if (on) els.chrome.classList.remove('hidden');
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
  try {
    const found = await checkUpdate();
    store.set('updateCheckedAt', Date.now());
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
   outline, so strip it before the parser ever sees it. */
const FRONT_MATTER = /^﻿?(?:---|\+\+\+)[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\+\+\+)[ \t]*(?:\r?\n|$)/;

function stripFrontMatter(text) {
  return text.replace(FRONT_MATTER, '');
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

function render(text) {
  renderRevision++;
  const current = captureRenderGuard();
  const dirty = marked.parse(stripFrontMatter(text));
  els.doc.innerHTML = DOMPurify.sanitize(dirty, { ADD_ATTR: ['target', 'id'] });

  const used = new Set();
  const heads = [...els.doc.querySelectorAll('h1, h2, h3, h4')];
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
    try { hljs.highlightElement(c); } catch {}
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
    if (/^https?:/i.test(href)) {
      if (IS_TAURI) {
        /* The webview refuses target=_blank, so hand the URL to the OS. */
        a.addEventListener('click', (e) => {
          e.preventDefault();
          openUrl(href).catch(() => { if (current()) toast('Could not open link'); });
        });
      } else {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    } else if (href.startsWith('#')) {
      a.addEventListener('click', (e) => {
        const t = els.doc.querySelector('#' + CSS.escape(href.slice(1)));
        if (t) { e.preventDefault(); scrollToEl(t); }
      });
    }
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
  renderMermaid();
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
 */
async function openPath(path, { allowNewWindow = true } = {}) {
  /* already open? just go to it — never open the same file twice */
  const existing = tabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
  if (existing) {
    activateTab(existing.id);
    try { await getCurrentWindow().setFocus(); } catch {}
    return;
  }

  if (allowNewWindow && IS_TAURI && cfg.openIn === 'window' && tabs.length > 0) {
    await openInNewWindow(path);
    return;
  }

  const text = await invoke('read_text_file', { path });
  let mtime = 0;
  try { mtime = await invoke('file_mtime', { path }); } catch {}

  /* Another request may have opened this path while the read was pending. */
  const committed = tabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
  if (committed) {
    activateTab(committed.id);
    try { await getCurrentWindow().setFocus(); } catch {}
    return;
  }

  const name = baseName(path);
  const tab = makeTab({ name, path, text, lastModified: mtime, docDir: dirOf(path, name) });
  tabs.push(tab);
  stashScroll();
  state = tab;
  store.set('lastPath', path);
  showActiveTab();
  els.scroller.focus({ preventScroll: true });
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
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
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
    const el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(t.id === state.id));
    el.dataset.watching = t.id === state.id && watchTimer ? 'yes' : 'no';
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
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });

    el.append(dot, name, close);
    el.addEventListener('click', () => activateTab(t.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    bar.appendChild(el);
  }

  const active = bar.querySelector('.tab[aria-selected="true"]');
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

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
  for (const p of paths) {
    try { await openPath(p, { allowNewWindow: false }); opened++; } catch { /* moved or deleted */ }
  }
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
function applyTheme(t, announce) {
  theme = window.__mdvTheme.apply(t);
  store.set('theme', theme);
  $('#btn-theme').setAttribute('aria-pressed', String(theme !== 'auto'));
  $('#btn-theme').title = 'Theme: ' + theme + ' (t)';
  refreshMermaidTheme();
  if (announce) toast('Theme: ' + theme);
}

const WIDTHS = ['normal', 'wide', 'full'];
let width = store.get('width', 'normal');
function applyWidth(w, announce) {
  width = WIDTHS.includes(w) ? w : 'normal';
  root.setAttribute('data-width', width);
  store.set('width', width);
  $('#btn-width').setAttribute('aria-pressed', String(width !== 'normal'));
  $('#btn-width').title = 'Width: ' + width + ' (w)';
  measure();
  if (announce) toast('Width: ' + width);
}

let font = store.get('font', 'sans');
function applyFont(f, announce) {
  font = f === 'serif' ? 'serif' : 'sans';
  root.setAttribute('data-font', font);
  store.set('font', font);
  $('#btn-font').setAttribute('aria-pressed', String(font === 'serif'));
  $('#btn-font').title = 'Font: ' + font + ' (f)';
  measure();
  if (announce) toast('Font: ' + font);
}

let outlineOn = store.get('outline', false);
function applyOutline(on, announce) {
  outlineOn = !!on;
  root.setAttribute('data-outline', outlineOn ? 'on' : 'off');
  store.set('outline', outlineOn);
  $('#btn-outline').setAttribute('aria-pressed', String(outlineOn));
  syncOutlineActive();
  if (announce) toast(outlineOn ? 'Outline shown' : 'Outline hidden');
}

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

/* ---------- keyboard ---------- */
window.addEventListener('keydown', (e) => {
  /* Escape works even from inside the settings panel's own controls */
  if (e.key === 'Escape') {
    if (findBarOpen()) { closeFind(); return; }
    toggleSettings(false);
    els.scroller.focus({ preventScroll: true });
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
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

  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomStep(-1); return; }
  if (mod && e.key === '0') { e.preventDefault(); zoomAnimated(1); return; }
  if (mod && e.key === '9') { e.preventDefault(); zoomFitWidth(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openViaPicker(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
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
$('#btn-print').addEventListener('click', () => window.print());
$('#btn-settings').addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
$('#btn-fit').addEventListener('click', zoomFitWidth);

/* settings controls — live, no apply button */
const bindRange = (id, key) => {
  $(id).addEventListener('input', (e) => {
    cfg[key] = Number(e.target.value);
    applyCfg({ remeasure: key !== 'zoomSpeed' });
  });
};
bindRange('#cfg-zoomspeed', 'zoomSpeed');
bindRange('#cfg-textsize', 'textSize');
bindRange('#cfg-lineheight', 'lineHeight');
$('#cfg-invert').addEventListener('change', (e) => {
  cfg.invertZoom = e.target.checked;
  applyCfg({ remeasure: false });
});
$('#cfg-restore').addEventListener('change', (e) => {
  cfg.restoreTabs = e.target.checked;
  applyCfg({ remeasure: false });
});
$('#cfg-openin').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  cfg.openIn = btn.dataset.val;
  applyCfg({ remeasure: false });
});
$('#cfg-closescope').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  cfg.closeScope = btn.dataset.val;
  applyCfg({ remeasure: false });
});
$('#cfg-check').addEventListener('click', () => checkForUpdate({ manual: true }));
$('#update-go').addEventListener('click', installUpdate);
$('#update-later').addEventListener('click', () => {
  if (pendingUpdate) store.set('updateSkipped', pendingUpdate.version);
  hideUpdateBar();
});
$('#cfg-reset').addEventListener('click', () => {
  cfg = Object.assign({}, DEFAULTS);
  applyCfg();
  toast('Settings reset');
});
$('#settings').addEventListener('click', (e) => e.stopPropagation());
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
  if (bootLabel === 'main') setTimeout(() => { checkForUpdate(); }, 3000);
} else {
  $('#cfg-update').style.display = 'none';
  $('#cfg-restore-field').style.display = 'none';
}
