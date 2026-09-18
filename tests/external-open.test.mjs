import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, settle } from './helpers/source-harness.mjs';

const path = 'C:/fixture/日本語 & notes #1.md';
const savedPath = 'C:/fixture/Saved.md';
const count = (h, command) => h.calls.filter(c => c.command === command).length;

for (const finishFirst of ['listener', 'boot']) {
  test(`external open: readiness waits for both boot and targeted registration (${finishFirst} first)`, async () => {
    const registration = deferred(), initial = deferred();
    const h = createHarness({
      label: 'doc-fixture',
      listen: name => name === 'open-file' ? registration.promise : Promise.resolve(() => {}),
      invoke: command => {
        if (command === 'initial_file') return initial.promise;
        if (command === 'external_open_ready') return;
        throw new Error('Unexpected IPC: ' + command);
      },
    });
    const boot = h.boot();
    const listener = h.listeners.find(l => l.name === 'open-file');
    assert.deepEqual(JSON.parse(JSON.stringify(listener.options)), {
      target: { kind: 'WebviewWindow', label: 'doc-fixture' },
    });
    await settle();
    assert.equal(count(h, 'external_open_ready'), 0);
    if (finishFirst === 'listener') registration.resolve(() => {});
    else initial.resolve(null);
    await settle();
    assert.equal(count(h, 'external_open_ready'), 0);
    registration.resolve(() => {});
    initial.resolve(null);
    await boot;
    await settle();
    assert.equal(count(h, 'external_open_ready'), 1);
  });
}

test('external open: rejected registration is handled immediately and never advertises readiness', async () => {
  const initial = deferred();
  const h = createHarness({
    listen: name => name === 'open-file' ? Promise.reject(new Error('fixture denied')) : Promise.resolve(() => {}),
    invoke: command => command === 'initial_file' ? initial.promise : undefined,
  });
  const boot = h.boot();
  // A full turn, not just microtasks: an unhandled rejection would fail this test.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count(h, 'external_open_ready'), 0);
  initial.resolve(null);
  await boot;
  await settle();
  assert.equal(count(h, 'external_open_ready'), 0);
  assert.ok(h.notices.includes('Could not finish startup'));
});

test('external open: an unexpected boot rejection still releases readiness and is caught', async () => {
  const h = createHarness();
  h.run("renderTabs = () => { throw new Error('fixture render failed'); }");
  await assert.rejects(h.boot(), /fixture render failed/);
  await settle();
  assert.equal(count(h, 'external_open_ready'), 1);
  assert.ok(h.notices.includes('Could not finish startup'));
});

test('external open: readiness IPC failure is caught', async () => {
  const h = createHarness({ invoke: async command => {
    if (command === 'initial_file') return null;
    throw new Error('fixture readiness failure');
  } });
  await h.boot();
  await settle();
  assert.equal(count(h, 'external_open_ready'), 1);
  assert.ok(h.notices.includes('Could not finish startup'));
});

for (const decision of [true, false, 'error']) {
  test(`external open: claim ${decision} is awaited before any file read`, async () => {
    const claim = deferred();
    const h = createHarness({ invoke: async (command, args) => {
      if (command === 'claim_external_open') return claim.promise;
      if (command === 'read_text_file') return 'accepted:' + args.path;
      if (command === 'file_mtime') return 1;
      throw new Error('Unexpected IPC: ' + command);
    } });
    const event = h.emit('open-file', path);
    await settle();
    assert.equal(count(h, 'claim_external_open'), 1);
    assert.equal(count(h, 'read_text_file'), 0);
    if (decision === 'error') claim.reject(new Error('fixture failed claim'));
    else claim.resolve(decision);
    await event;
    assert.equal(h.tabs.length, decision === true ? 1 : 0);
    assert.equal(count(h, 'read_text_file'), decision === true ? 1 : 0);
    assert.equal(h.notices.includes('Could not open that file'), decision === 'error');
  });
}

for (const openIn of ['tab', 'window']) {
  test(`external open: repeated accepted requests remain distinct in ${openIn} mode`, async () => {
    const h = createHarness({ saved: { cfg: { openIn } }, allowNewWindows: true });
    await h.boot();
    await settle();
    // With no document yet, even window mode opens in this recipient.
    await h.emit('open-file', savedPath);
    assert.equal(h.tabs.length, 1);
    assert.equal(h.newWindows.length, 0);
    await Promise.all([h.emit('open-file', path), h.emit('open-file', path)]);
    assert.equal(count(h, 'claim_external_open'), 3, 'no frontend path-based request suppression');
    if (openIn === 'tab') {
      assert.equal(h.tabs.length, 2, 'T1 commit guard still merges overlapping same-path tab opens');
      assert.equal(h.newWindows.length, 0);
      await h.emit('open-file', path);
      assert.equal(h.tabs.length, 2);
    } else {
      assert.equal(h.tabs.length, 1);
      assert.equal(h.newWindows.length, 2, 'each accepted request may create one window');
      for (const child of h.newWindows) {
        const params = new URLSearchParams(child.options.url.split('?')[1]);
        assert.equal(params.get('file'), path);
        assert.equal(params.has('externalOpen'), false, 'the parent already claimed ownership');
      }
    }
  });
}

for (const external of [false, true]) {
  for (const decision of [true, false, 'error']) {
    test(`external open: URL ${external ? 'owned' : 'regular'} with claim ${decision}`, async () => {
      const claim = deferred();
      const h = createHarness({
        label: 'doc-external-fixture',
        search: '?file=' + encodeURIComponent(path) + (external ? '&externalOpen=1' : ''),
        saved: { openTabs: [savedPath], cfg: { openIn: 'window' } },
        invoke: async (command, args) => {
          if (command === 'claim_external_open') return claim.promise;
          if (command === 'read_text_file') return 'fixture:' + args.path;
          if (command === 'file_mtime') return 1;
          if (command === 'external_open_ready') return;
          throw new Error('Unexpected IPC: ' + command);
        },
      });
      const boot = h.boot();
      await settle();
      if (external) {
        assert.equal(count(h, 'read_text_file'), 0);
        assert.equal(count(h, 'external_open_ready'), 0);
        assert.equal(h.calls[0].path, path);
        if (decision === 'error') claim.reject(new Error('fixture claim failed'));
        else claim.resolve(decision);
      }
      await boot;
      await settle();
      const accepted = !external || decision === true;
      assert.equal(h.tabs.length, accepted ? 1 : 0);
      assert.equal(count(h, 'claim_external_open'), external ? 1 : 0);
      assert.equal(count(h, 'external_open_ready'), 1);
      assert.equal(count(h, 'initial_file'), 0);
      assert.deepEqual(JSON.parse(h.storage.get('mdv.openTabs')), [savedPath]);
      assert.equal(h.newWindows.length, 0);
      if (accepted) assert.equal(h.state.path, path);
      else assert.equal(h.element('#empty').classList.contains('gone'), false);
    });
  }
}

test('external open: unreadable accepted file is reported, not retried or claimed again', async () => {
  const h = createHarness({ invoke: async command => {
    if (command === 'claim_external_open') return true;
    throw new Error('fixture unreadable');
  } });
  await h.emit('open-file', path);
  assert.equal(count(h, 'claim_external_open'), 1);
  assert.equal(count(h, 'read_text_file'), 1);
  assert.equal(h.tabs.length, 0);
  assert.ok(h.notices.includes('Could not open that file'));
});

test('external open: browser startup does not register or announce native readiness', async () => {
  const h = createHarness({ native: false });
  await h.boot();
  await settle();
  assert.equal(h.listeners.length, 0);
  assert.equal(h.calls.length, 0);
});
