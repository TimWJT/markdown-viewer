import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHarness } from './helpers/source-harness.mjs';

/* Pinch-to-zoom on Windows.
 *
 * WebView2 reports a trackpad pinch as a ctrl+wheel WheelEvent, and that event
 * is the only way the page hears about a pinch at all. So these tests are as
 * much about the event arriving and being claimable as about the arithmetic:
 * the gesture is handled here, and the native side has to stay out of the way
 * (see the note in src-tauri/src/main.rs where the pinch-zoom setting used to
 * be switched off, which silently dropped every one of these events).
 */

const MIN = 0.4, MAX = 4;

/* `scale` is a top-level `let` in the frontend, and a vm context only exposes
   top-level `var` and `function` as properties, so it has to be read by
   evaluating source rather than off the context object. */
const scaleOf = h => vm.runInContext('scale', h.context);

/** A pinch event as WebView2 delivers it: ctrl held, small pixel delta. */
function pinch(h, { deltaY = -20, ctrlKey = true, clientX = 400, clientY = 300 } = {}) {
  const event = {
    type: 'wheel', deltaY, deltaMode: 0,
    ctrlKey, metaKey: false, shiftKey: false,
    clientX, clientY,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
  h.window.dispatch('wheel', event);
  return event;
}

/** Run the pending one-shot timers, as the debounce in persistZoom() uses. */
function flushTimers(h) {
  for (const timer of [...h.timers.values()]) if (timer.kind === 'timeout') timer.fn();
}

test('a trackpad pinch reaches the page as ctrl+wheel and zooms the document', () => {
  const h = createHarness();
  const before = scaleOf(h);

  const event = pinch(h, { deltaY: -30 });

  assert.ok(scaleOf(h) > before, 'pinch out should increase the scale');
  /* preventDefault is what stops WebView2 *also* scaling the page underneath,
     which is the whole reason the document is zoomed with a transform instead
     of the browser's own reflowing zoom. */
  assert.equal(event.defaultPrevented, true, 'the event must be claimed or WebView2 double-zooms');
});

test('the wheel listener is registered passive:false and in the capture phase', () => {
  const h = createHarness();
  const wheel = h.listenerOptions('wheel');
  assert.ok(wheel.length, 'expected a wheel listener on window');

  /* Two separate requirements, and it is easy to satisfy one and lose the other:
     passive:false or preventDefault() is silently ignored, and no capture or
     the event falls through to WebView2's own zoom wherever the cursor is not
     over the scroller. */
  for (const options of wheel) {
    assert.equal(options?.passive, false, 'preventDefault() does nothing on a passive listener');
    assert.equal(options?.capture, true, 'a non-capturing listener misses the toolbar and outline');
  }
});

test('a wheel event without ctrl is left alone, so scrolling still scrolls', () => {
  const h = createHarness();
  const before = scaleOf(h);

  const event = pinch(h, { deltaY: -120, ctrlKey: false });

  assert.equal(scaleOf(h), before, 'plain two-finger scroll must not zoom');
  assert.equal(event.defaultPrevented, false, 'plain scroll must not be swallowed');
});

test('pinch scaling is exponential, so small trackpad deltas stay smooth', () => {
  const h = createHarness();
  h.call('zoomTo', 1);

  /* The bug this guards against is quantising pinch to a fixed step list: a
     trackpad emits dozens of tiny deltas, and a stepped scale turns a smooth
     gesture into a stutter. Four identical small deltas must multiply, not add
     the same jump four times. */
  const seen = [];
  for (let i = 0; i < 4; i++) { pinch(h, { deltaY: -10 }); seen.push(scaleOf(h)); }

  for (const s of seen) assert.ok(s > 1, 'each step should still be zooming in');

  const ratio = Math.exp(10 * 0.0022);
  for (const s of seen) {
    assert.ok(Math.abs(s - seen[0] * ratio ** seen.indexOf(s)) < 1e-9,
      `each step should be the same ratio, got ${seen.join(', ')}`);
  }
  assert.ok(seen.at(-1) < 1.3, `four small deltas should be a small change, got ${seen.at(-1)}`);
});

test('one mouse-wheel notch is a browser-sized step, not a hair trigger', () => {
  const h = createHarness();
  h.call('zoomTo', 1);

  pinch(h, { deltaY: -100 });

  /* deltaY 100 is a single notch. It has to land near the ~12-25% a browser
     gives, because the same handler serves ctrl+wheel from a mouse. */
  const s = scaleOf(h);
  assert.ok(s > 1.1 && s < 1.35, `a wheel notch should be a visible step, got ${s}`);
});

test('zoom is clamped to the documented range in both directions', () => {
  const h = createHarness();

  for (let i = 0; i < 200; i++) pinch(h, { deltaY: -400 });
  assert.ok(Math.abs(scaleOf(h) - MAX) < 1e-9, `clamped to ${MAX}, got ${scaleOf(h)}`);

  for (let i = 0; i < 400; i++) pinch(h, { deltaY: 400 });
  assert.ok(Math.abs(scaleOf(h) - MIN) < 1e-9, `clamped to ${MIN}, got ${scaleOf(h)}`);
});

test('invert zoom swaps the direction', () => {
  const h = createHarness({ saved: { cfg: { invertZoom: true } } });

  const before = scaleOf(h);
  pinch(h, { deltaY: -30 });

  assert.ok(scaleOf(h) < before, 'with invert on, pinch out should zoom the document out');
});

test('zoom speed scales the response, and 1x is the default', () => {
  const step = h => { const b = scaleOf(h); pinch(h, { deltaY: -30 }); return scaleOf(h) / b; };
  const plain = step(createHarness());
  const slow = step(createHarness({ saved: { cfg: { zoomSpeed: 0.5 } } }));
  const fast = step(createHarness({ saved: { cfg: { zoomSpeed: 2 } } }));

  assert.ok(slow < plain && plain < fast, `speed should order the response: 0.5x=${slow}, 1x=${plain}, 2x=${fast}`);
  assert.ok(Math.abs(plain - Math.exp(30 * 0.0022)) < 1e-9, 'default speed is 1x');
});

test('a burst of pinch events persists zoom once, not once per event', () => {
  const h = createHarness();
  const zoomWrites = () => h.writes.filter(([key]) => key === 'mdv.zoom');

  for (let i = 0; i < 25; i++) pinch(h, { deltaY: -10 });

  /* A pinch fires dozens of events a second. Writing localStorage on each one
     would mean a JSON write per event, which is exactly the kind of stutter
     this gesture must not have. persistZoom() debounces, so nothing is stored
     until the timer runs. */
  assert.equal(zoomWrites().length, 0, 'no write should land before the debounce fires');

  flushTimers(h);
  assert.equal(zoomWrites().length, 1, 'one write for the whole burst');
});

test('the touch and macOS pinch paths are still wired up and claimable', () => {
  const h = createHarness();

  /* Windows pinch goes through the wheel path above. macOS in a .app build
     fires WebKit's own gesture events, and a touchscreen delivers two
     pointers. Neither produces a wheel event, so they need their own
     listeners, and both must be claimable for the same preventDefault reason. */
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    const options = h.listenerOptions(type);
    assert.ok(options.length, `expected a ${type} listener`);
    for (const o of options) assert.equal(o?.passive, false, `${type} must be claimable`);
  }

  const scroller = h.element('#scroller');
  const move = scroller.listenerOptions.get(
    [...(scroller.listeners.get('pointermove') || [])][0],
  );
  assert.ok(move, 'expected a pointermove listener for a two-finger touch pinch');
  assert.equal(move?.passive, false, 'the touch pinch must be able to preventDefault');
});

test('the native side does not disable WebView2 pinch zoom', () => {
  /* The regression this whole file exists for. SetIsPinchZoomEnabled(false)
     does not hand pinch to the frontend, it stops WebView2 emitting the
     ctrl+wheel event the frontend listens for, so pinch does nothing at all
     on Windows while every test above still passes. Nothing in Node can catch
     that, so the native source is asserted directly.

     Line comments are stripped first: the file discusses this exact call at
     length, and prose about it must not read as a live call. */
  const code = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.ok(
    !/SetIsPinchZoomEnabled\s*\(\s*false\s*\)/.test(code),
    'WebView2 pinch zoom must stay enabled or the page never sees the gesture',
  );
});
