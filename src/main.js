import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

/* Tauri APIs. Safe to import in a plain browser — nothing touches the native
   bridge until called, and every call site is behind the IS_TAURI check. */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

marked.setOptions({ gfm: true, breaks: false, async: false });

const root = document.documentElement;
const $ = (s) => document.querySelector(s);

const els = {
  bar: $('#bar'),
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

const state = { name: '', path: null, handle: null, pending: null, lastModified: 0, heads: [] };

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
const DEFAULTS = { zoomSpeed: 1, textSize: 17, lineHeight: 1.68, invertZoom: false };
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

  root.style.setProperty('--base-size', cfg.textSize + 'px');
  root.style.setProperty('--line-height', String(cfg.lineHeight));

  $('#cfg-zoomspeed').value = String(cfg.zoomSpeed);
  $('#cfg-textsize').value = String(cfg.textSize);
  $('#cfg-lineheight').value = String(cfg.lineHeight);
  $('#cfg-invert').checked = cfg.invertZoom;
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
  if (on) els.bar.classList.remove('hidden');
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
  measuring = true;
  lastAvail = els.scroller.clientWidth;
  els.doc.style.transform = 'none';
  els.doc.style.width = lastAvail + 'px';
  natW = els.doc.offsetWidth;
  natH = els.doc.offsetHeight;
  measuring = false;
  paint();
}

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

/* Directory of the open document, so relative image paths can resolve. */
let docDir = null;

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
  if (!IS_TAURI || !docDir) return;
  els.doc.querySelectorAll('img[src]').forEach((img) => {
    const raw = img.getAttribute('src') || '';
    if (!raw || /^(https?:|data:|blob:|asset:|tauri:|file:)/i.test(raw)) return;
    let rel = raw;
    try { rel = decodeURIComponent(raw); } catch {}
    const abs = isAbsolutePath(rel) ? rel : joinPath(docDir, rel);
    try { img.src = convertFileSrc(abs); } catch {}
  });
}

function render(text) {
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
      navigator.clipboard.writeText(c.textContent).then(() => toast('Copied'), () => toast('Copy failed'));
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
          openUrl(href).catch(() => toast('Could not open link'));
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

  resolveImages();

  /* An image that decodes after layout changes the document height, which
     would leave the measured zoom surface stale (short canvas, clipped scroll). */
  els.doc.querySelectorAll('img').forEach((img) => {
    if (img.complete) return;
    img.addEventListener('load', scheduleMeasure, { once: true });
    img.addEventListener('error', scheduleMeasure, { once: true });
  });

  buildOutline();
  measure();
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
function setDoc(text, resetScroll) {
  const keep = resetScroll ? 0 : els.scroller.scrollTop;
  const keepLeft = resetScroll ? 0 : els.scroller.scrollLeft;
  render(text);
  els.empty.classList.add('gone');
  els.scroller.classList.add('instant');
  els.scroller.scrollTop = keep;
  els.scroller.scrollLeft = keepLeft;
  requestAnimationFrame(() => els.scroller.classList.remove('instant'));
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
}

async function loadFile(file, handle) {
  const text = await file.text();
  state.name = file.name;
  state.lastModified = file.lastModified;
  state.handle = handle || null;
  state.path = null;
  docDir = null;
  state.pending = null;
  setDoc(text, true);
  startWatch();
  els.scroller.focus({ preventScroll: true });
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
async function openPath(path) {
  const text = await invoke('read_text_file', { path });
  let mtime = 0;
  try { mtime = await invoke('file_mtime', { path }); } catch {}
  state.name = path.split(/[\\/]/).pop() || path;
  state.path = path;
  /* Directory of this document — relative image paths resolve against it. */
  docDir = path.slice(0, Math.max(0, path.length - state.name.length - 1)) || null;
  if (docDir && /^[a-zA-Z]:$/.test(docDir)) docDir += '\\';
  state.handle = null;
  state.pending = null;
  state.lastModified = mtime;
  store.set('lastPath', path);
  setDoc(text, true);
  startWatch();
  try { await getCurrentWindow().setTitle(state.name + ' — Markdown Viewer'); } catch {}
  els.scroller.focus({ preventScroll: true });
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

function stopWatch() {
  clearInterval(watchTimer);
  watchTimer = null;
  watchFails = 0;
  els.live.classList.remove('on');
}

function onWatchError() {
  if (++watchFails >= WATCH_MAX_FAILS) {
    stopWatch();
    toast('Stopped watching — file unreadable');
  }
}

async function pollNative() {
  try {
    const m = await invoke('file_mtime', { path: state.path });
    if (m !== state.lastModified) {
      const text = await invoke('read_text_file', { path: state.path });
      state.lastModified = m;
      setDoc(text, false);
      toast('Reloaded');
    }
    watchFails = 0;
  } catch {
    onWatchError();
  }
}

async function pollHandle() {
  try {
    const f = await state.handle.getFile();
    if (f.lastModified !== state.lastModified) {
      const text = await f.text();
      state.lastModified = f.lastModified;
      setDoc(text, false);
      toast('Reloaded');
    }
    watchFails = 0;
  } catch {
    onWatchError();
  }
}

function startWatch() {
  stopWatch();
  if (IS_TAURI && state.path) {
    els.live.classList.add('on');
    watchTimer = setInterval(pollNative, WATCH_INTERVAL);
  } else if (state.handle) {
    els.live.classList.add('on');
    watchTimer = setInterval(pollHandle, WATCH_INTERVAL);
  }
}

/** Force a re-read, ignoring mtime. Bound to F5. */
async function reloadNow() {
  try {
    if (IS_TAURI && state.path) {
      const text = await invoke('read_text_file', { path: state.path });
      state.lastModified = await invoke('file_mtime', { path: state.path }).catch(() => 0);
      setDoc(text, false);
      startWatch();
      toast('Reloaded');
    } else if (state.handle) {
      const f = await state.handle.getFile();
      state.lastModified = f.lastModified;
      setDoc(await f.text(), false);
      startWatch();
      toast('Reloaded');
    }
  } catch {
    toast('Could not reload');
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
  els.bar.classList.remove('hidden');
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

/* ---------- appearance ---------- */
const THEMES = ['auto', 'light', 'dark'];
let theme = store.get('theme', 'auto');
function applyTheme(t, announce) {
  theme = THEMES.includes(t) ? t : 'auto';
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  store.set('theme', theme);
  $('#btn-theme').setAttribute('aria-pressed', String(theme !== 'auto'));
  $('#btn-theme').title = 'Theme: ' + theme + ' (t)';
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
  els.bar.classList.toggle('scrolled', y > 4);
  if (y > 90 && y > lastScroll + 6) els.bar.classList.add('hidden');
  else if (y < lastScroll - 6 || y <= 90) els.bar.classList.remove('hidden');
  lastScroll = y;
  syncOutlineActive();
}, { passive: true });

window.addEventListener('mousemove', (e) => {
  if (e.clientY < 56) els.bar.classList.remove('hidden');
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

  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomStep(-1); return; }
  if (mod && e.key === '0') { e.preventDefault(); zoomAnimated(1); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openViaPicker(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
  if (e.key === 'F3') { e.preventDefault(); findBarOpen() ? findStep(e.shiftKey ? -1 : 1) : openFind(); return; }
  if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) { e.preventDefault(); reloadNow(); return; }
  if (mod) return;

  switch (e.key) {
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
  listen('open-file', (e) => {
    if (e.payload) openPath(e.payload).catch(() => toast('Could not open that file'));
  });
}

window.addEventListener('paste', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text || !text.trim()) return;
  stopWatch();
  state.name = 'Pasted text';
  state.handle = null;
  state.path = null;
  state.pending = null;
  setDoc(text, true);
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

(async function boot() {
  const lastText = store.get('lastText', null);
  const lastName = store.get('lastName', '');
  if (lastText) {
    state.name = lastName || 'Untitled.md';
    render(lastText);
    els.empty.classList.add('gone');
    updateTitle();
  }
  /* native shell: a file passed on the command line wins, then the last one */
  if (IS_TAURI) {
    try {
      const initial = await invoke('initial_file');
      if (initial) { await openPath(initial); return; }
    } catch {}
    const lastPath = store.get('lastPath', null);
    if (lastPath) {
      try { await openPath(lastPath); } catch { store.set('lastPath', null); }
    }
    els.scroller.focus({ preventScroll: true });
    return;
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
