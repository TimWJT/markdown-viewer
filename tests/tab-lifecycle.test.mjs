import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, addWatchedTabs, deferred, settle } from './helpers/source-harness.mjs';

function fixture(native) {
  const io = {
    read: async path => path.endsWith('A.md') ? 'A original' : 'B original',
    stat: async () => 1,
    getFile: async () => ({ lastModified: 1, text: async () => 'A original' }),
  };
  const h = createHarness({ native, invoke: (command, args) => {
    if (command === 'read_text_file') return io.read(args.path);
    if (command === 'file_mtime') return io.stat(args.path);
    if (command === 'initial_file') return null;
    throw new Error('Unexpected fixture IPC: ' + command);
  } });
  const { a, b } = addWatchedTabs(h, native);
  if (!native) a.handle.getFile = () => io.getFile();
  return { h, a, b, io };
}

function delayRead(io, native, stage = 'text') {
  const gate = deferred();
  if (native) {
    io.stat = async () => stage === 'metadata' ? gate.promise : 2;
    io.read = async () => stage === 'metadata' ? 'A late' : gate.promise;
  } else {
    io.getFile = async () => stage === 'metadata' ? gate.promise : { lastModified: 2, text: () => gate.promise };
  }
  return {
    reject: gate.reject,
    resolve() { gate.resolve(stage === 'metadata' ? (native ? 2 : { lastModified: 2, text: async () => 'A late' }) : 'A late'); },
  };
}

for (const native of [true, false]) {
  const backend = native ? 'native' : 'browser handle';
  const poll = native ? 'pollNative' : 'pollHandle';
  for (const operation of ['reloadNow', poll]) {
    for (const transition of ['A → B', 'close A → B', 'A → B → A', 'final close']) {
      test(`${backend}: delayed ${operation} cannot mutate after ${transition}`, async () => {
        const { h, a, b, io } = fixture(native);
        const gate = delayRead(io, native);
        const work = h.call(operation);
        await settle(); // The actual source is now waiting for text, not a timer.
        if (transition === 'A → B') h.activate(b);
        if (transition === 'close A → B') h.call('closeTab', a.id);
        if (transition === 'A → B → A') { h.activate(b); h.activate(a); }
        if (transition === 'final close') { h.call('closeTab', b.id); h.call('closeTab', a.id); }
        const active = h.state;
        const timer = h.run('watchTimer');
        const rendered = h.element('#doc').textContent;
        const savedWrites = h.writes.length;
        gate.resolve();
        await work;
        h.flushFrames();
        assert.equal(a.text, 'A original', 'old read must not mutate its previous tab either');
        assert.equal(b.text, 'B original', 'remaining B must keep its own text');
        assert.equal(h.state, active, 'active/empty state must not be replaced');
        assert.equal(h.element('#doc').textContent, rendered, 'late work must not render into the current viewer');
        assert.equal(h.run('watchTimer'), timer, 'late work must not restart another session');
        assert.equal(h.writes.length, savedWrites, 'stale work must not persist content');
        assert.equal(h.notices.length, 0, 'stale success must not report Reloaded');
        if (transition === 'final close') {
          assert.equal(h.state.text, '');
          assert.equal(h.element('#empty').classList.contains('gone'), false);
          assert.equal(h.nativeWindow.closeCalls, 0, 'Q1 unanswered: keep empty window');
          assert.equal(h.document.title, 'Markdown Viewer');
        } else {
          assert.equal(h.state.lastModified, 1, 'mtime belongs to the new session');
        }
      });
    }
  }

  test(`${backend}: a delayed metadata lookup must not start a read for B`, async () => {
    const { h, a, b, io } = fixture(native);
    const gate = delayRead(io, native, 'metadata');
    const work = h.call(poll);
    await settle();
    h.activate(b);
    gate.resolve();
    await work;
    assert.equal(a.text, 'A original');
    assert.equal(b.text, 'B original');
    assert.equal(b.lastModified, 1);
    assert.equal(h.notices.length, 0);
    assert.equal(h.calls.filter(c => c.command === 'read_text_file' && c.path === b.path).length, 0,
      'an old A stat must never cause a B read');
  });

  for (const operation of ['reloadNow', poll]) {
    test(`${backend}: stale ${operation} failure cannot report an error or stop B's watcher`, async () => {
      const { h, b, io } = fixture(native);
      const gate = delayRead(io, native);
      const work = h.call(operation);
      await settle();
      h.activate(b);
      h.run('watchFails = WATCH_MAX_FAILS - 1'); // B is already tolerating an atomic-save gap.
      const timer = h.run('watchTimer');
      gate.reject(new Error('A was removed during read'));
      await work;
      assert.equal(h.run('watchFails'), 19, 'A failure must not change B failure budget');
      assert.equal(h.run('watchTimer'), timer);
      assert.equal(h.element('#live').classList.contains('on'), true);
      assert.deepEqual(h.notices, []);
    });
  }

  test(`${backend}: stale poll success must not clear B's accumulated errors`, async () => {
    const { h, b, io } = fixture(native);
    const gate = delayRead(io, native);
    const work = h.call(poll);
    await settle();
    h.activate(b);
    h.run('watchFails = 7');
    gate.resolve();
    await work;
    assert.equal(h.run('watchFails'), 7);
  });

  test(`${backend}: active polling still tolerates 19 failures and stops at 20`, async () => {
    const { h, io } = fixture(native);
    io.stat = async () => { throw new Error('atomic rename gap'); };
    io.getFile = async () => { throw new Error('atomic rename gap'); };
    for (let i = 0; i < 19; i++) await h.call(poll);
    assert.equal(h.run('watchFails'), 19);
    assert.notEqual(h.run('watchTimer'), null);
    await h.call(poll);
    assert.equal(h.run('watchTimer'), null);
    assert.equal(h.element('#live').classList.contains('on'), false);
    assert.deepEqual(h.notices, ['Stopped watching — file unreadable']);
  });

  test(`${backend}: current manual reload preserves scroll and foreground-only 700 ms watching`, async () => {
    const { h, a, io } = fixture(native);
    h.element('#scroller').scrollTop = 137;
    h.element('#scroller').scrollLeft = 42;
    io.read = async () => 'A refreshed';
    io.stat = async () => 2;
    io.getFile = async () => ({ lastModified: 2, text: async () => 'A refreshed' });
    await h.call('reloadNow');
    assert.equal(a.text, 'A refreshed');
    assert.equal(a.lastModified, 2);
    assert.equal(h.element('#scroller').scrollTop, 137);
    assert.equal(h.element('#scroller').scrollLeft, 42);
    const intervals = [...h.timers.values()].filter(t => t.kind === 'interval');
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 700);
    assert.deepEqual(h.notices, ['Reloaded']);
  });

  for (const [earlier, later] of [['reloadNow', 'reloadNow'], [poll, 'reloadNow'], ['reloadNow', poll], [poll, poll]]) {
    test(`${backend}: overlapping ${earlier} then ${later} cannot roll back newer content`, async () => {
      const { h, a, io } = fixture(native);
      const firstText = deferred();
      let reads = 0;
      io.stat = async () => 2 + reads;
      io.read = async () => ++reads === 1 ? firstText.promise : 'A newest';
      io.getFile = async () => {
        const index = ++reads;
        return { lastModified: index + 1, text: async () => index === 1 ? firstText.promise : 'A newest' };
      };
      const first = h.call(earlier);
      await settle();
      assert.equal(reads, 1);
      const second = h.call(later);
      await settle();
      const concurrentRead = reads > 1;
      if (concurrentRead) await second;
      firstText.resolve('A older');
      await Promise.all([first, second]);
      if (!concurrentRead) {
        // Serialising polling is valid too: a later tick must catch the latest
        // file once the previous operation finishes. Do not require a specific
        // private lock or operation-counter design.
        await h.call(later);
      }
      assert.equal(a.text, 'A newest', 'older completion must not overwrite the later read');
      assert.equal(h.element('#doc').textContent, 'A newest');
      assert.equal([...h.timers.values()].filter(t => t.kind === 'interval').length, 1);
    });
  }
}

for (const native of [true, false]) {
  test(`${native ? 'native' : 'browser handle'}: closing a background tab does not invalidate the active read`, async () => {
    const { h, a, b, io } = fixture(native);
    const gate = delayRead(io, native);
    const work = h.call('reloadNow');
    await settle();
    h.call('closeTab', b.id);
    gate.resolve();
    await work;
    assert.equal(h.state, a);
    assert.equal(a.text, 'A late');
    assert.equal(a.lastModified, 2);
    assert.deepEqual(h.notices, ['Reloaded']);
  });
}

test('native: whole-window close closes only this window and can be reopened with Ctrl+Shift+T', async () => {
  const h = createHarness();
  const { a, b } = addWatchedTabs(h);
  assert.deepEqual(JSON.parse(h.storage.get('mdv.session')), { main: [a.path, b.path] });
  h.call('closeWindow');
  assert.equal(h.nativeWindow.destroyCalls, 1);
  assert.equal(h.nativeWindow.closeCalls, 0, 'a native close request would quit the app');
  assert.deepEqual(JSON.parse(h.storage.get('mdv.session')), {});
  assert.deepEqual(JSON.parse(h.storage.get('mdv.closed')), [[a.path, b.path]]);
});

test('native: closed tabs reopen most recent first with Ctrl+Shift+T', async () => {
  const h = createHarness();
  const { a, b } = addWatchedTabs(h);
  h.call('closeTab', a.id);
  assert.equal(h.nativeWindow.destroyCalls, 0);
  const event = h.key({ target: h.element('#doc'), key: 'T', shiftKey: true });
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.deepEqual(Array.from(h.tabs, tab => tab.path), [b.path, a.path]);
  assert.deepEqual(JSON.parse(h.storage.get('mdv.closed')), []);
});

test('native: simultaneous case-insensitive same-path opens create one tab', async () => {
  const gate = deferred();
  let reads = 0;
  const h = createHarness({ invoke: async (command) => {
    if (command === 'read_text_file') { reads++; return gate.promise; }
    if (command === 'file_mtime') return 1;
    throw new Error('Unexpected IPC');
  } });
  const first = h.call('openPath', 'C:/fixture/Same.md');
  const second = h.call('openPath', 'c:/FIXTURE/same.MD');
  await settle();
  assert.ok(reads >= 1 && reads <= 2, 'shared reads and commit-time rechecks are both valid');
  gate.resolve('same contents');
  await Promise.all([first, second]);
  assert.equal(h.tabs.length, 1);
  assert.equal(h.state, h.tabs[0]);
  assert.equal(h.state.text, 'same contents');
  assert.equal(JSON.parse(h.storage.get('mdv.session')).main.length, 1);
  await h.call('openPath', 'C:/FIXTURE/SAME.md');
  assert.equal(h.tabs.length, 1, 'later duplicate still selects the existing tab');
});

test('final close releases actual Find matches, resets navigation and retains the open Find panel', () => {
  const h = createHarness();
  const a = h.addTab({ name: 'A.md', path: 'C:/fixture/A.md', text: 'apple apple' });
  h.activate(a);
  h.element('#find-input').value = 'apple';
  h.call('openFind');
  assert.equal(h.run('findMarks.length'), 2, 'fixture must create real production Find matches');
  h.call('findStep', 1);
  assert.equal(h.element('#find-count').textContent, '2/2');
  h.call('closeTab', a.id);
  h.flushFrames();
  assert.equal(h.run('findMarks.length'), 0, 'release references to detached matching nodes');
  assert.equal(h.run('findIndex'), -1);
  assert.equal(h.element('#find-count').textContent, '0/0');
  assert.equal(h.element('#find').classList.contains('on'), true);
  assert.equal(h.element('#doc').textContent, '');
  assert.equal(h.element('#docmeta').textContent, '');
  assert.equal(h.nativeWindow.destroyCalls, 1, 'the last tab closes its window');
  assert.deepEqual(JSON.parse(h.storage.get('mdv.session')), {});
  h.call('findStep', 1);
  assert.equal(h.run('findIndex'), -1);
});

for (const target of ['input', 'textarea', 'contenteditable']) {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    for (const scope of ['tab', 'window']) {
      test(`${modifier}+W from ${target} respects ${scope} close scope`, () => {
        const h = createHarness({ saved: { cfg: { closeScope: scope } } });
        const { a, b } = addWatchedTabs(h);
        const node = target === 'input' ? h.element('#find-input') : h.document.createElement(target === 'textarea' ? 'textarea' : 'div');
        node.isContentEditable = target === 'contenteditable';
        const event = h.key({ target: node, ctrlKey: false, [modifier]: true });
        assert.equal(event.defaultPrevented, true);
        if (scope === 'tab') {
          assert.equal(h.tabs.length, 1);
          assert.equal(h.state, b);
          assert.equal(h.tabs.includes(a), false);
          assert.equal(h.nativeWindow.closeCalls, 0);
        } else {
          assert.equal(h.nativeWindow.destroyCalls, 1);
          assert.equal(h.tabs.length, 2);
          assert.deepEqual(JSON.parse(h.storage.get('mdv.closed')), [[a.path, b.path]]);
        }
      });
    }
    test(`${modifier}+Shift+W from ${target} closes the window even with tab scope`, () => {
      const h = createHarness();
      addWatchedTabs(h);
      const node = h.document.createElement(target === 'contenteditable' ? 'div' : target);
      node.isContentEditable = target === 'contenteditable';
      const event = h.key({ target: node, ctrlKey: false, [modifier]: true, shiftKey: true, key: 'W' });
      assert.equal(event.defaultPrevented, true);
      assert.equal(h.nativeWindow.destroyCalls, 1);
      assert.equal(h.tabs.length, 2);
    });
  }
}

test('input editing remains excluded; Escape still closes Find rather than a tab', () => {
  const h = createHarness();
  addWatchedTabs(h);
  h.call('openFind');
  const event = h.key({ key: 'w', ctrlKey: false });
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.tabs.length, 2);
  assert.equal(h.run('width'), 'normal');
  h.key({ key: 'Escape', ctrlKey: false });
  assert.equal(h.element('#find').classList.contains('on'), false);
  assert.equal(h.tabs.length, 2);
});

test('active close chooses right neighbour, then left at the edge; background close keeps the watcher', () => {
  const h = createHarness();
  const { a, b } = addWatchedTabs(h);
  const c = h.addTab({ name: 'C.md', path: 'C:/fixture/C.md', text: 'C original' });
  h.activate(b);
  h.call('closeTab', b.id);
  assert.equal(h.state, c);
  h.call('closeTab', c.id);
  assert.equal(h.state, a);
  const d = h.addTab({ name: 'D.md', path: 'C:/fixture/D.md', text: 'D original' });
  const timer = h.run('watchTimer');
  h.call('closeTab', d.id);
  assert.equal(h.state, a);
  assert.equal(h.run('watchTimer'), timer);
  h.call('closeTab', -1);
  assert.equal(h.state, a);
});

test('tab close button and middle-click use the same neighbour selection', () => {
  for (const gesture of ['button', 'middle']) {
    const h = createHarness();
    const { b } = addWatchedTabs(h);
    const active = h.element('#tabbar').querySelector('.tab[aria-selected="true"]');
    const event = { button: 1, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    if (gesture === 'button') active.querySelector('button').dispatch('click', event);
    else active.dispatch('auxclick', event);
    assert.equal(h.state, b);
    assert.equal(h.tabs.length, 1);
    if (gesture === 'middle') assert.equal(event.prevented, true);
  }
});

test('browser window-scoped close clears local tabs without closing a real browser window', () => {
  const h = createHarness({ native: false, saved: { cfg: { closeScope: 'window' } } });
  addWatchedTabs(h, false);
  const event = h.key();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.tabs.length, 0);
  assert.equal(h.state.text, '');
  assert.equal(h.nativeWindow.closeCalls, 0);
});
