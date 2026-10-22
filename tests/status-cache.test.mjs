import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(process.env.STATUSBAR_SOURCE || new URL('../src/native_statusbar.js', import.meta.url), 'utf8');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const markup = id => `<section><div data-above-composer-conversation-id="${id}"></div><div data-testid="composer"><textarea data-codex-thread-reference-drop-target></textarea><button>Send</button></div></section>`;

function setup(t) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { throw error; });
  const dom = new JSDOM(`<main>${markup(A)}</main>`, { runScripts: 'outside-only', virtualConsole, url: 'https://statusbar.fixture/' });
  let now = 0;
  let timerSerial = 0;
  let observerId = 'observer-a';
  const timers = new Map();
  dom.window.Date.now = () => 1700000000000 + now;
  Object.defineProperty(dom.window.performance, 'now', { value: () => now });
  dom.window.setTimeout = (callback, delay = 0) => {
    const id = ++timerSerial;
    timers.set(id, { callback, delay, due: now + delay });
    return id;
  };
  dom.window.clearTimeout = id => timers.delete(id);
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 100, width: 600, height: 100 });
  dom.window.__CODEX_VISIBLE_STREAM__ = { snapshot: () => ({ observerId, revision: 1, items: [] }) };
  dom.window.eval(source);
  t.after(() => { dom.window.__CODEX_INLINE_STATUS__?.destroy(); dom.window.close(); });

  const current = () => dom.window.__CODEX_INLINE_STATUS__;
  const binding = () => current().discover()[0];
  const metric = (tps, cache = .95) => ({
    scope: 'visible_text_client', measurement_method: 'visible_stream', observation_id: observerId,
    state: 'completed', tps, tokens: tps * 2, seconds: 2,
    measured_tokens: tps * 2, measured_seconds: 2, measured_samples: 1,
    completed: { tps, tokens: tps * 2, seconds: 2, measured_samples: 1 },
    cache_hit: cache, issue: null, cache_issue: null,
  });
  const apply = value => current().apply({ key: binding().key, metrics: typeof value === 'number' ? metric(value) : value });
  const go = id => {
    dom.window.document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', id);
    return current().discover()[0];
  };
  const labels = () => Array.from(current().inspect().bindings[0]?.labels || []);
  const title = () => dom.window.document.querySelector('[data-codex-inline-status]')?.shadowRoot.querySelector('[data-metric="speed"]').title || '';
  const advance = ms => {
    const until = now + ms;
    let remaining = 1000;
    while (remaining--) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].due; next[1].callback();
    }
    assert.ok(remaining >= 0, 'timer loop terminates');
    now = until;
  };
  return { dom, current, binding, metric, apply, go, labels, title, advance, timers, setObserver: id => { observerId = id; } };
}

test('A and B synchronously restore their own confirmed statistics without a placeholder flash', t => {
  const h = setup(t);
  h.apply(112); h.go(B); h.apply(h.metric(42, .8));
  h.go(A);
  assert.deepEqual(h.labels(), ['112 tok/s', '缓存命中 95.0%']);
  h.go(B);
  assert.deepEqual(h.labels(), ['42 tok/s', '缓存命中 80.0%']);
});

test('replacing the entire same-thread composer synchronously restores the correct cache', t => {
  const h = setup(t);
  h.apply(112);
  const document = h.dom.window.document;
  const replacement = document.createElement('div');
  replacement.innerHTML = '<div data-testid="composer"><textarea data-codex-thread-reference-drop-target></textarea><button>Send</button></div>';
  document.querySelector('[data-testid="composer"]').replaceWith(replacement.firstElementChild);
  h.current().discover();
  assert.deepEqual(h.labels(), ['112 tok/s', '缓存命中 95.0%']);
});

test('new, unknown, and draft conversations never borrow A or B values', t => {
  const h = setup(t);
  h.apply(112); h.go(B); h.apply(42);
  h.go(C);
  assert.deepEqual(h.labels(), ['— tok/s', '缓存命中 —']);
  h.go('');
  assert.deepEqual(h.labels(), ['— tok/s', '缓存命中 —']);
  assert.equal(h.binding().threadId, null);
  h.go('unknown');
  assert.equal(h.current().inspect().count, 0);
  h.go(A);
  assert.equal(h.labels()[0], '112 tok/s');
});

test('a rejected old key cannot poison either thread cache', t => {
  const h = setup(t);
  h.apply(112);
  const oldKey = h.binding().key;
  h.go(B); h.apply(42);
  assert.equal(h.current().apply({ key: oldKey, metrics: h.metric(999) }), false);
  h.go(A); assert.equal(h.labels()[0], '112 tok/s');
  h.go(B); assert.equal(h.labels()[0], '42 tok/s');
});

test('a provisional reading restores its last display separately from confirmed completion totals', t => {
  const h = setup(t);
  h.apply({ ...h.metric(999), state: 'provisional', completed: { tps: 50, tokens: 100, seconds: 2, measured_samples: 1 } });
  assert.equal(h.labels()[0], '999 tok/s');
  h.go(B); h.go(A);
  assert.equal(h.labels()[0], '999 tok/s');
  assert.match(h.title(), /尚未完成核对/);
  assert.equal(h.labels()[1], '缓存命中 95.0%');
});

test('a sampled speed can restore as history before any reply has completed', t => {
  const h = setup(t);
  h.apply({ ...h.metric(999), state: 'provisional', completed: { tps: null, tokens: 0, seconds: 0, measured_samples: 0 } });
  h.go(B); h.go(A);
  assert.equal(h.labels()[0], '999 tok/s');
  assert.match(h.title(), /尚未完成核对/);
});

test('an invalid scope removes the affected cache before a later return', t => {
  const h = setup(t);
  h.apply(112);
  assert.equal(h.apply({ ...h.metric(999), scope: 'untrusted' }), false);
  h.go(B); h.go(A);
  assert.deepEqual(h.labels(), ['— tok/s', '缓存命中 —']);
});

test('cache stores a clone and external mutations cannot alter restored metrics', t => {
  const h = setup(t);
  const supplied = h.metric(112);
  h.apply(supplied);
  supplied.tps = 999; supplied.completed.tps = 888; supplied.cache_hit = 1;
  supplied.completed.tokens = 777; supplied.completed.seconds = .001;
  h.go(B); h.go(A);
  assert.deepEqual(h.labels(), ['112 tok/s', '缓存命中 95.0%']);
});

test('returning to an old cache labels it stale and clears it if revalidation fails for 15 seconds', t => {
  const h = setup(t);
  h.apply(112); h.go(B);
  h.advance(60000);
  h.go(A);
  assert.equal(h.labels()[0], '112 tok/s');
  assert.match(h.title(), /上次统计/);
  assert.match(h.title(), /后台刷新/);
  h.advance(14999); assert.equal(h.labels()[0], '112 tok/s');
  h.advance(1); assert.equal(h.labels()[0], '— tok/s');
  h.go(B); h.go(A); assert.equal(h.labels()[0], '— tok/s');
});

test('a fresh valid update replaces the stale display and refresh deadline', t => {
  const h = setup(t);
  h.apply(112); h.go(B); h.advance(30000); h.go(A);
  assert.match(h.title(), /后台刷新/);
  h.advance(14000); h.apply(120);
  assert.equal(h.labels()[0], '120 tok/s');
  assert.doesNotMatch(h.title(), /上次统计.*后台刷新/);
  h.advance(1000); assert.equal(h.labels()[0], '120 tok/s');
});

test('an already queued old watchdog cannot clear a newly bound thread', t => {
  const h = setup(t);
  h.apply(112);
  const oldWatchdog = [...h.timers.values()].find(timer => timer.delay === 15000)?.callback;
  assert.equal(typeof oldWatchdog, 'function');
  h.go(B); h.apply(42);
  oldWatchdog();
  assert.deepEqual(h.labels(), ['42 tok/s', '缓存命中 95.0%']);
});

test('an observer identity change restores history without inheriting its measurement epoch', t => {
  const h = setup(t);
  h.apply(112); h.go(B); h.setObserver('observer-b'); h.go(A);
  assert.deepEqual(h.labels(), ['112 tok/s', '缓存命中 95.0%']);
  assert.equal(h.current().inspect().bindings[0].speedPersisted, true);
});

test('a source failure immediately clears a restored cache and prevents later resurrection', t => {
  const h = setup(t);
  h.apply(112); h.go(B); h.go(A);
  h.apply({ ...h.metric(null), state: 'noData', completed: { tps: null, tokens: 0, seconds: 0, measured_samples: 0 }, issue: 'source_unavailable', cache_issue: 'source_unavailable' });
  assert.deepEqual(h.labels(), ['— tok/s', '缓存命中 —']);
  h.go(B); h.go(A);
  assert.deepEqual(h.labels(), ['— tok/s', '缓存命中 —']);
});

test('renderer rebuild restores its durable display while an unrelated renderer inherits no live state', t => {
  const first = setup(t);
  first.apply(112);
  const second = setup(t);
  assert.deepEqual(second.labels(), ['— tok/s', '缓存命中 —']);
  first.current().destroy();
  first.dom.window.eval(source);
  assert.deepEqual(first.labels(), ['112 tok/s', '缓存命中 95.0%']);
});

test('returning after more than 32 chats synchronously restores the UUID-specific durable mirror', t => {
  const h=setup(t);h.apply(112);
  for(let i=1;i<=40;i++){h.go(`00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`);h.apply(i)}
  h.go(A);assert.deepEqual(h.labels(),['112 tok/s','缓存命中 95.0%']);
  h.current().destroy();h.dom.window.eval(source);
  assert.deepEqual(h.labels(),['112 tok/s','缓存命中 95.0%']);
});

test('returning to an interrupted sample keeps its last display through empty refreshes and log catch-up', t => {
  const h=setup(t),key='sample-a';
  h.apply({...h.metric(117,.972),state:'provisional',sample_key:key,completed:{tps:null,measured_samples:0}});
  h.go(B);h.apply(h.metric(42,.8));h.go(A);
  assert.deepEqual(h.labels(),['117 tok/s','缓存命中 97.2%']);
  h.apply({...h.metric(null,null),state:'noData',sample_key:null,cache_issue:'catching_up',invalidated_keys:[key],interrupted_keys:[key]});
  assert.deepEqual(h.labels(),['117 tok/s','缓存命中 97.2%']);
  assert.match(h.title(),/尚未完成核对/);
  h.apply({...h.metric(125,.98),state:'provisional',sample_key:'new-sample'});
  assert.deepEqual(h.labels(),['125 tok/s','缓存命中 98.0%']);
});

test('a strong invalidation retracts both the cached and durable display', t => {
  const h=setup(t),key='invalid-sample';
  h.apply({...h.metric(117,.972),state:'provisional',sample_key:key});h.go(B);h.go(A);
  h.apply({...h.metric(null,.972),state:'noData',invalidated_keys:[key],interrupted_keys:[]});
  assert.equal(h.labels()[0],'— tok/s');
  h.current().destroy();h.dom.window.eval(source);assert.equal(h.labels()[0],'— tok/s');
});

test('a malformed or foreign-thread durable mirror cannot supply a restored reading', t => {
  const h=setup(t);h.apply(112);h.go(B);
  const name='codex-inline-status:display:v1:'+A;
  const record=JSON.parse(h.dom.window.localStorage.getItem(name));record.threadId=B;
  h.dom.window.localStorage.setItem(name,JSON.stringify(record));
  h.current().destroy();h.dom.window.eval(source);h.go(A);
  assert.deepEqual(h.labels(),['— tok/s','缓存命中 —']);
});
