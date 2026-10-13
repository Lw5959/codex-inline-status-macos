import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./native-statusbar-deps/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('../src/visible_stream_observer.js', import.meta.url), 'utf8');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const turn = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const epoch = 1700000000000;
const uuid = i => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const limit = 256 * 1024;

function setup(t) {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => { dom.window.__CODEX_VISIBLE_STREAM__?.destroy(); dom.window.close(); });
  let time = 0;
  Object.defineProperty(dom.window.performance, 'now', { value: () => time });
  dom.window.Date.now = () => epoch;
  let active = [A, B, ...Array.from({ length: 40 }, (_, i) => uuid(i))];
  dom.window.__CODEX_INLINE_STATUS__ = { discover: () => active.map(threadId => ({ threadId })) };
  dom.window.eval(source);
  const api = dom.window.__CODEX_VISIBLE_STREAM__;
  const emit = (method, params, options = {}) => {
    time = options.at ?? time + 1;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      source: options.source ?? null,
      data: { type: options.type ?? 'mcp-notification', hostId: options.hostId ?? 'local', method, params },
    }));
  };
  const start = (id = 'one', extra = {}, options) => emit('item/started', { threadId: A, turnId: turn, item: { id, type: 'agentMessage', text: '', startedAtMs: epoch, ...extra } }, options);
  const delta = (text, id = 'one', options) => emit('item/agentMessage/delta', { threadId: A, turnId: turn, itemId: id, delta: text }, options);
  const complete = (text, id = 'one', extra = {}, options) => emit('item/completed', { threadId: A, turnId: turn, item: { id, type: 'agentMessage', text, ...extra } }, options);
  return { dom, api, emit, start, delta, complete, setActive: threads => { active = threads; } };
}

test('only threads currently bound in this renderer can start sampling', t => {
  const { api, emit, start, delta, setActive } = setup(t);
  setActive([A]);
  emit('item/started', { threadId: B, turnId: turn, item: { id: 'background', type: 'agentMessage', startedAtMs: epoch } });
  emit('item/agentMessage/delta', { threadId: B, turnId: turn, itemId: 'background', delta: 'not-this-window' });
  start(); delta('local');
  assert.equal(api.snapshot(B).items.length, 0);
  assert.equal(api.snapshot(A).items.length, 1);
  assert.equal(api.snapshot(A).items[0].text, 'local');
});

test('leaving a thread invalidates its unfinished item and returning never joins missed deltas', t => {
  const { api, emit, start, delta, complete, setActive } = setup(t);
  setActive([A]); start(); delta('first'); delta('second');
  assert.equal(api.snapshot(A).items[0].state, 'provisional');
  setActive([B]);
  emit('item/started', { threadId: B, turnId: turn, item: { id: 'other', type: 'agentMessage', startedAtMs: epoch } });
  let old = api.snapshot(A).items[0];
  assert.equal(old.state, 'invalid');
  assert.equal(old.issue, 'thread_not_active');
  assert.equal(old.text, '');
  setActive([A]); delta('missed-middle'); complete('firstsecondmissed-middle');
  old = api.snapshot(A).items[0];
  assert.equal(old.state, 'invalid');
  assert.equal(old.text, '');
});

test('a temporary empty binding or failed discovery fails closed without cross-thread fallback', t => {
  const { dom, api, start, delta, setActive } = setup(t);
  setActive([A]); start('gap'); delta('a', 'gap');
  setActive([]); delta('b', 'gap');
  assert.equal(api.snapshot(A).items[0].issue, 'thread_not_active');
  setActive([A]); start('error'); delta('a', 'error');
  dom.window.__CODEX_INLINE_STATUS__.discover = () => { throw Error('temporary failure'); };
  delta('b', 'error'); start('blocked');
  assert.equal(api.snapshot(A).items.find(item => item.itemId === 'error').state, 'invalid');
  assert.equal(api.snapshot(A).items.some(item => item.itemId === 'blocked'), false);
});

test('a frontend that is not yet installed cannot authorize a new item', t => {
  const { dom, api, start, delta, setActive } = setup(t);
  delete dom.window.__CODEX_INLINE_STATUS__;
  start('early'); delta('early');
  assert.equal(api.snapshot(A).items.length, 0);
  setActive([A]);
  dom.window.__CODEX_INLINE_STATUS__ = { discover: () => [{ threadId: A }] };
  start('later'); delta('accepted', 'later');
  assert.equal(api.snapshot(A).items[0].itemId, 'later');
});

test('provisional and completed measurements use first-to-last delta only and retain the first batch separately', t => {
  const { dom, api, start, delta, complete } = setup(t);
  start('one', {}, { at: 1 });
  delta('hello', 'one', { at: 10 });
  let item = api.snapshot(A).items[0];
  assert.equal(item.state, 'collecting');
  assert.equal(item.deltaCount, 1);
  assert.equal(item.durationMs, 0);
  delta(' world', 'one', { at: 20, source: dom.window });
  item = api.snapshot(A).items[0];
  assert.deepEqual([item.state, item.text, item.firstText, item.durationMs, item.deltaCount], ['provisional', 'hello world', 'hello', 10, 2]);
  delta('!', 'one', { at: 30 });
  const provisional = api.snapshot(A);
  complete('hello world!', 'one', {}, { at: 1000 });
  const completed = api.snapshot(A);
  item = completed.items[0];
  assert.deepEqual([item.state, item.text, item.firstText, item.durationMs, item.deltaCount], ['completed', 'hello world!', 'hello', 20, 3]);
  assert.ok(completed.revision > provisional.revision);
  assert.equal(item.revision, completed.revision);
});

test('empty deltas do not count and fewer than two timed batches cannot become a completed sample', t => {
  const { api, start, delta, complete } = setup(t);
  start(); delta(''); delta('first'); delta('');
  assert.equal(api.snapshot(A).items[0].deltaCount, 1);
  complete('first');
  assert.equal(api.snapshot(A).items[0].state, 'invalid');
  assert.equal(api.snapshot(A).items[0].issue, 'insufficient_delta_span');
  start('same-time'); delta('a', 'same-time', { at: 20 }); delta('b', 'same-time', { at: 20 });
  complete('ab', 'same-time');
  assert.equal(api.snapshot(A).items.find(item => item.itemId === 'same-time').state, 'invalid');
});

test('reasoning, summaries, tools, nonlocal traffic, and malformed identities are ignored', t => {
  const { dom, api, emit } = setup(t);
  const foreign = new JSDOM(''); t.after(() => foreign.window.close());
  emit('item/started', { threadId: A, turnId: turn, item: { id: 'reason', type: 'reasoning', startedAtMs: epoch } });
  for (const method of ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta']) emit(method, { threadId: A, turnId: turn, itemId: 'other', delta: 'ignored' });
  const params = { threadId: A, turnId: turn, item: { id: 'one', type: 'agentMessage', startedAtMs: epoch } };
  emit('item/started', params, { hostId: 'remote' });
  emit('item/started', params, { source: foreign.window });
  emit('item/started', { ...params, threadId: 'bad' });
  emit('item/started', { ...params, turnId: 'bad' });
  emit('item/started', { ...params, item: { ...params.item, id: 'x'.repeat(161) } });
  assert.equal(api.snapshot(A).items.length, 0);
  assert.equal(dom.window.__CODEX_STREAM_TIMING__, undefined);
});

test('pre-install, absent, and already populated starts are permanently invalid', t => {
  const { api, start, delta, complete } = setup(t);
  start('old', { startedAtMs: epoch - 1 }); delta('old-secret', 'old');
  start('missing-time', { startedAtMs: undefined });
  start('populated', { text: 'already-streamed' });
  delta('orphan-secret', 'orphan'); start('orphan');
  complete('unknown', 'no-start');
  const items = api.snapshot(A).items;
  assert.equal(items.length, 5);
  assert.ok(items.every(item => item.state === 'invalid' && item.text === '' && item.firstText === ''));
});

test('a final text mismatch retracts provisional data and never retains the mismatching final text', t => {
  const { api, start, delta, complete } = setup(t);
  start(); delta('a'); delta('b');
  const before = api.snapshot(A);
  assert.equal(before.items[0].state, 'provisional');
  complete('different-final-secret');
  const after = api.snapshot(A);
  assert.equal(after.items[0].state, 'invalid');
  assert.equal(after.items[0].issue, 'final_text_mismatch');
  assert.equal(after.items[0].text, '');
  assert.ok(after.items[0].revision > before.items[0].revision);
  assert.equal(JSON.stringify(after).includes('different-final-secret'), false);
});

test('late deltas, replayed starts, and conflicting completion metadata invalidate existing samples', t => {
  const { api, emit, start, delta, complete } = setup(t);
  start('late'); delta('a', 'late'); delta('b', 'late'); complete('ab', 'late'); delta('c', 'late');
  start('replay'); delta('a', 'replay'); delta('b', 'replay'); start('replay');
  start('conflict'); delta('a', 'conflict'); delta('b', 'conflict');
  const params = { threadId: A, turnId: turn, completedAtMs: epoch + 20, item: { id: 'conflict', type: 'agentMessage', text: 'ab' } };
  emit('item/completed', params); emit('item/completed', params);
  assert.equal(api.snapshot(A).items.find(item => item.itemId === 'conflict').state, 'completed');
  emit('item/completed', { ...params, completedAtMs: epoch + 21 });
  assert.ok(api.snapshot(A).items.every(item => item.state === 'invalid' && item.text === ''));
});

test('backwards monotonic clocks invalidate the affected item', t => {
  const { api, start, delta } = setup(t);
  start('one', {}, { at: 10 }); delta('a', 'one', { at: 20 }); delta('b', 'one', { at: 19 });
  assert.equal(api.snapshot(A).items[0].issue, 'non_monotonic_time');
});

test('same item identifiers remain isolated by thread and turn', t => {
  const { api, emit } = setup(t);
  for (const [threadId, turnId, text] of [[A, turn, 'first'], [B, turn, 'second'], [A, uuid(2), 'third']]) {
    emit('item/started', { threadId, turnId, item: { id: 'same', type: 'agentMessage', startedAtMs: epoch } });
    emit('item/agentMessage/delta', { threadId, turnId, itemId: 'same', delta: text });
  }
  assert.deepEqual(Array.from(api.snapshot(A).items, item => item.text), ['first', 'third']);
  assert.equal(api.snapshot(B).items[0].text, 'second');
  assert.equal(api.snapshot('bad').items.length, 0);
});

test('per-item overlimit data is excluded as a whole rather than truncated', t => {
  const { api, start, delta } = setup(t);
  start(); delta('x'.repeat(limit)); delta('y');
  const item = api.snapshot(A).items[0];
  assert.equal(item.state, 'invalid');
  assert.equal(item.issue, 'item_text_limit');
  assert.equal(item.text, '');
  assert.equal(item.firstText, '');
});

test('snapshot character budget excludes old whole items and preserves invalid identities for revocation', t => {
  const { api, start, delta } = setup(t);
  for (let i = 0; i < 3; i++) { start(`large-${i}`); delta('x'.repeat(100000), `large-${i}`); delta('y', `large-${i}`); }
  const snapshot = api.snapshot(A);
  assert.equal(snapshot.items.length, 3);
  assert.equal(snapshot.items[0].itemId, 'large-0');
  assert.equal(snapshot.items[0].state, 'invalid');
  assert.equal(snapshot.items[0].issue, 'snapshot_text_limit');
  assert.ok(snapshot.items.reduce((sum, item) => sum + item.text.length + item.firstText.length, 0) <= 512 * 1024);
});

test('retention caps at 128 renderer records and 32 threads', t => {
  const { api, start, emit } = setup(t);
  for (let i = 0; i < 140; i++) start(`item-${i}`);
  assert.equal(api.snapshot(A).items.length, 128);
  assert.equal(api.snapshot(A).items[0].itemId, 'item-12');
  for (let i = 0; i < 33; i++) emit('item/started', { threadId: uuid(i), turnId: turn, item: { id: 'one', type: 'agentMessage', startedAtMs: epoch } });
  assert.equal(api.snapshot(A).items.length, 0);
  assert.equal(api.snapshot(uuid(0)).items.length, 0);
  assert.equal(api.snapshot(uuid(32)).items.length, 1);
});

test('snapshot is a non-draining copy with a stable read-only revision', t => {
  const { api, start, delta } = setup(t);
  start(); delta('a'); delta('b');
  const snapshot = api.snapshot(A);
  const revision = snapshot.revision;
  snapshot.items[0].text = 'mutated'; snapshot.items.length = 0;
  assert.equal(api.snapshot(A).items[0].text, 'ab');
  assert.equal(api.snapshot(A).revision, revision);
});

test('reinjection is idempotent and destroy clears listener, memory, and observer identity', t => {
  const { dom, api, start, delta } = setup(t);
  start(); delta('private');
  const id = api.snapshot(A).observerId;
  dom.window.eval(source);
  assert.equal(dom.window.__CODEX_VISIBLE_STREAM__, api);
  api.destroy(); delta('ignored');
  assert.equal(api.snapshot(A).items.length, 0);
  assert.equal(dom.window.__CODEX_VISIBLE_STREAM__, undefined);
  dom.window.eval(source); start('new');
  const next = dom.window.__CODEX_VISIBLE_STREAM__;
  assert.notEqual(next.snapshot(A).observerId, id);
  assert.equal(next.snapshot(A).items.length, 1);
});
