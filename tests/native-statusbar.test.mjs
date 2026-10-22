import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
const source = fs.readFileSync(process.env.STATUSBAR_SOURCE || new URL("../src/native_statusbar.js", import.meta.url), "utf8");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const metrics = (tps, cache = .95) => ({ scope: "sampled_session", measurement_method: "turn_elapsed", tps, measured_samples: 2, measured_tokens: tps * 2, measured_seconds: 2, cache_hit: cache, context_used: .25 });
const composer = marker => `<section><div data-above-composer-conversation-id="${marker}"></div><div data-testid="composer"><textarea aria-label="Message"></textarea><button>Send</button></div></section>`;
const codexComposer = marker => composer(marker).replace('<textarea ', '<textarea data-codex-thread-reference-drop-target ');
const portalDraft = () => codexComposer("").replace('data-above-composer-conversation-id=""', 'data-above-composer-portal');
const stableComposer = () => `<div data-testid="composer" data-codex-composer-root><div class="ComposerLayoutFooter"><div class="AdaptiveFooterInput"><textarea data-codex-thread-reference-drop-target></textarea></div><div data-controls="left"><button>+</button><button>权限</button></div><div data-controls="right"><button>模型</button><button>麦克风</button><button data-send>发送</button></div></div></div>`;
const stableFooter = id => `<div data-thread-scroll-footer style="position:absolute"><div data-above-composer-portal data-above-composer-conversation-id="${id}"></div>${stableComposer()}</div>`;

test('visible stream scope displays its own speed and documents the counting convention', () => {
  const { dom, document, api } = setup(composer(A));
  const key = api.discover()[0].key;
  assert.equal(api.apply({ key, metrics: { scope:'visible_text_client', measurement_method:'visible_stream',
    tps:123, measured_samples:1, measured_tokens:246, measured_seconds:2, cache_hit:.95 } }), true);
  const state = api.inspect().bindings[0];
  assert.deepEqual(Array.from(state.labels), ['123 tok/s', '缓存命中 95.0%']);
  const title = document.querySelector('[data-codex-inline-status]').shadowRoot.querySelector('[data-metric="speed"]').title;
  assert.match(title,/可见文本流式速度/); assert.match(title,/o200k_base/); assert.match(title,/不包含隐藏推理/);
  api.apply({key,metrics:{scope:'visible_text_client',measurement_method:'visible_stream',tps:123,cache_issue:'source_unavailable',cache_hit:.95}});
  assert.deepEqual(Array.from(api.inspect().bindings[0].labels), ['123 tok/s', '缓存命中 —']);
  api.apply({key,metrics:{scope:'visible_text_client',measurement_method:'stream_decode',tps:12047}});
  assert.equal(api.inspect().bindings[0].labels[0], '— tok/s');
  api.destroy(); dom.window.close();
});

test('identical metric updates preserve text nodes and avoid redundant DOM writes', () => {
  const { dom, document, api } = setup(composer(A));
  const key = api.discover()[0].key;
  api.apply({ key, metrics: metrics(112) });
  const shadow = document.querySelector('[data-codex-inline-status]').shadowRoot;
  const label = shadow.querySelector('[data-metric="speed"] > span');
  const originalText = label.firstChild;
  const changes = new dom.window.MutationObserver(() => {});
  changes.observe(shadow, { subtree: true, childList: true, attributes: true, characterData: true });
  api.apply({ key, metrics: metrics(112) });
  assert.equal(label.firstChild, originalText, '相同读数应保留文本节点，避免触发额外观察和重排');
  assert.equal(changes.takeRecords().length, 0);
  api.apply({ key, metrics: metrics(113) });
  assert.equal(label.textContent, '113 tok/s');
  assert.ok(changes.takeRecords().length > 0, '实际变化仍应更新可见数据');
  changes.disconnect(); api.destroy(); dom.window.close();
});

test('cheap streaming identity lookup handles a pending route mutation synchronously', () => {
  const { dom, document, api } = setup(composer(A));
  assert.deepEqual(Array.from(api.currentThreadIds()),[A]);
  document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id',B);
  assert.deepEqual(Array.from(api.currentThreadIds()),[B]);
  api.destroy(); dom.window.close();
});

test('metric refreshes reuse bindings and skip global queries and geometry reads', () => {
  const { dom, document, api } = setup(composer(A), false, { resizeObserver: true });
  const key = api.bindings()[0].key;
  let scans = 0, geometry = 0;
  const originalGeometry = dom.window.HTMLElement.prototype.getBoundingClientRect;
  const original = document.querySelectorAll.bind(document);
  document.querySelectorAll = selector => { scans++; return original(selector); };
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => { geometry++; return {}; };
  for (let i = 0; i < 50; i++) {
    api.apply({ key, metrics: metrics(100 + i) });
    api.inspect({ refresh: false, geometry: false });
  }
  assert.equal(scans, 0); assert.equal(geometry, 0);
  // 没有及时交付的路由切换仍必须先被消费，不能为了性能接受旧绑定。
  dom.window.HTMLElement.prototype.getBoundingClientRect = originalGeometry;
  document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', B);
  assert.equal(api.apply({ key, metrics: metrics(999) }), false);
  assert.deepEqual(Array.from(api.currentThreadIds()), [B]);
  api.destroy(); dom.window.close();
});

test('style-hidden pages cannot keep authorizing cached thread bindings', () => {
  const { dom, document, api } = setup(composer(A));
  const key = api.bindings()[0].key;
  document.querySelector('section').style.display = 'none';
  assert.deepEqual(Array.from(api.currentThreadIds()), []);
  assert.equal(api.apply({ key, metrics: metrics(999) }), false);
  document.querySelector('section').style.display = '';
  assert.deepEqual(Array.from(api.currentThreadIds()), [A]);
  api.destroy(); dom.window.close();
});

test('number changes blur only digits, preserve current labels and respect reduced motion', () => {
  const { dom, document, api, timers } = setup(composer(A), true);
  const key = api.bindings()[0].key;
  api.apply({ key, metrics: metrics(100, .95) });
  api.apply({ key, metrics: metrics(120, .96) });
  const shadow = document.querySelector('[data-codex-inline-status]').shadowRoot;
  const digits = shadow.querySelector('[data-metric="speed"] .number-switch');
  assert.equal(digits.dataset.previous, '100'); assert.equal(digits.textContent, '120');
  assert.ok(digits.classList.contains('is-switching'));
  const cacheDigits = shadow.querySelector('[data-metric="cache"] .number-switch');
  assert.equal(cacheDigits.dataset.previous, '95.0'); assert.equal(cacheDigits.textContent, '96.0');
  assert.ok(cacheDigits.classList.contains('is-switching'), '缓存百分比也应播放相同的上下模糊切换');
  assert.deepEqual(Array.from(api.inspect().bindings[0].labels), ['120 tok/s', '缓存命中 96.0%']);
  assert.match(shadow.querySelector('style').textContent, /gap:3px/);
  const animationCSS = shadow.querySelector('style').textContent;
  for (const keyframes of animationCSS.matchAll(/@keyframes[^@]+/g)) assert.doesNotMatch(keyframes[0], /filter\s*:/, '模糊保持静态，动画只改变 transform/opacity');
  for (const [id, timer] of [...timers]) if (timer.delay === 850) { timers.delete(id); timer.callback(); }
  assert.equal(digits.dataset.previous, undefined); assert.equal(digits.classList.contains('is-switching'), false);
  api.apply({ key, metrics: metrics(120, .96) });
  assert.equal(digits.classList.contains('is-switching'), false, '相同数字不能重启动效');
  dom.window.matchMedia = () => ({ matches: true });
  api.apply({ key, metrics: metrics(130, .97) });
  assert.equal(digits.textContent, '130'); assert.equal(digits.classList.contains('is-switching'), false);
  api.destroy(); assert.equal(timers.size, 0); dom.window.close();
});

test('sub-unit speeds stay positive in the label instead of rounding down to zero', t => {
  const { dom, api } = setup(composer(A));t.after(() => { api.destroy(); dom.window.close(); });
  api.apply({ key: api.bindings()[0].key, metrics: metrics(.2) });
  assert.equal(api.inspect({refresh:false,geometry:false}).bindings[0].labels[0], '<1 tok/s');
});

test('digit width follows asynchronous intrinsic sizes and releases observation on removal', t => {
  const {dom,api,document,resizeObservers}=setup(composer(A),true,{resizeObserver:true});
  t.after(()=>{api.destroy();dom.window.close()});
  const key=api.bindings()[0].key;api.apply({key,metrics:metrics(100)});
  const shadow=document.querySelector('[data-codex-inline-status]').shadowRoot;
  const digits=shadow.querySelector('[data-metric="speed"] .number-switch');
  const text=digits.querySelector('.number-text'),observer=resizeObservers[1];
  text.getBoundingClientRect=()=>{throw Error('数字更新不能同步测量布局')};
  assert.ok(observer.nodes.has(text));
  observer.callback([{target:text,contentBoxSize:[{inlineSize:21}]}]);assert.equal(digits.style.width,'21px');
  api.apply({key,metrics:metrics(99)});
  assert.equal(digits.style.width,'21px','新文字不能先把旧宽度瞬间改掉');
  observer.callback([{target:text,contentBoxSize:[{inlineSize:14}]}]);assert.equal(digits.style.width,'14px');
  assert.match(shadow.querySelector('style').textContent,/transition:width 700ms/);
  api.destroy();assert.equal(observer.nodes.size,0);assert.equal(observer.disconnected,true);
});

test('placeholder-to-number keeps its width container and animates both speed and cache', t => {
  const {dom,api,document,resizeObservers}=setup(composer(A),true,{resizeObserver:true});
  t.after(()=>{api.destroy();dom.window.close()});
  const shadow=document.querySelector('[data-codex-inline-status]').shadowRoot;
  const speed=shadow.querySelector('[data-metric="speed"] .number-switch');
  const cache=shadow.querySelector('[data-metric="cache"] .number-switch');
  const observer=resizeObservers[1];
  for(const digits of [speed,cache])observer.callback([{target:digits.querySelector('.number-text'),contentBoxSize:[{inlineSize:7}]}]);
  api.apply({key:api.bindings()[0].key,metrics:metrics(100,.95)});
  for(const digits of [speed,cache]){
    assert.equal(digits.dataset.previous,'—');assert.ok(digits.classList.contains('is-switching'));
    assert.equal(digits.style.width,'7px','横线的实测宽度保留到新字宽异步交付');
  }
  assert.deepEqual(Array.from(api.inspect({refresh:false,geometry:false}).bindings[0].labels),['100 tok/s','缓存命中 95.0%']);
});

test('number-to-placeholder animates both metrics without retaining a previous conversation', t => {
  const {dom,api,document,resizeObservers}=setup(composer(A),true,{resizeObserver:true});
  t.after(()=>{api.destroy();dom.window.close()});
  const key=api.bindings()[0].key;api.apply({key,metrics:metrics(100,.95)});
  const shadow=document.querySelector('[data-codex-inline-status]').shadowRoot;
  const digits=[...shadow.querySelectorAll('.number-switch')],observer=resizeObservers[1];
  for(const value of digits)observer.callback([{target:value.querySelector('.number-text'),contentBoxSize:[{inlineSize:21}]}]);
  api.apply({key,metrics:metrics(null,null)});
  for(const [i,value] of digits.entries()){
    assert.equal(value.textContent,'—');assert.equal(value.dataset.previous,i===0?'100':'95.0');
    assert.ok(value.classList.contains('is-switching'));assert.equal(value.style.width,'21px');
    observer.callback([{target:value.querySelector('.number-text'),contentBoxSize:[{inlineSize:7}]}]);
    assert.equal(value.style.width,'7px');
  }
  api.apply({key,metrics:metrics(120,.96)});
  document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id',B);
  api.bindings();
  for(const value of digits){assert.equal(value.dataset.previous,undefined);assert.equal(value.classList.contains('is-switching'),false)}
});

test('restored conversation metrics identify their saved source and remain available during log catch-up', t => {
  const {dom,api,document}=setup(composer(A));t.after(()=>{api.destroy();dom.window.close()});
  const key=api.bindings()[0].key;
  api.apply({key,metrics:{...metrics(120,.95),scope:'visible_text_client',measurement_method:'visible_stream',state:'saved',
    speed_persisted:true,cache_persisted:true,speed_saved_at:1700000000,cache_saved_at:1700000000,cache_issue:'catching_up'}});
  const state=api.inspect({refresh:false,geometry:false}).bindings[0];
  assert.deepEqual(Array.from(state.labels),['120 tok/s','缓存命中 95.0%']);assert.equal(state.speedPersisted,true);assert.equal(state.cachePersisted,true);
  const shadow=document.querySelector('[data-codex-inline-status]').shadowRoot;
  assert.match(shadow.querySelector('[data-metric="speed"]').title,/上次保存.*已确认速度/);
  assert.match(shadow.querySelector('[data-metric="cache"]').title,/上次保存的缓存命中率/);
  api.apply({key,metrics:metrics(125,.96)});
  assert.equal(api.inspect({refresh:false,geometry:false}).bindings[0].speedPersisted,false);
});
const rect = (left, top, width, height) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height });

test('speed always uses tok/s and phase text remains in the tooltip', t => {
  const { dom, api } = setup(composer(A));
  t.after(() => { api.destroy(); dom.window.close(); });
  const key = api.bindings()[0].key;
  for (const [phase, label] of [['thinking', '思考中'], ['tool', '工具执行中'], ['waiting', '等待正文']]) {
    api.apply({ key, metrics: { ...metrics(112, .95), scope: 'visible_text_client',
      measurement_method: 'visible_stream', state: 'waiting', phase, tps: null } });
    const reading = api.inspect({ refresh: false, geometry: false }).bindings[0];
    assert.equal(reading.labels[0], '— tok/s'); assert.equal(reading.labels[1], '缓存命中 95.0%');
    assert.equal(reading.phase, phase); assert.equal(reading.state, 'waiting');
    assert.ok(dom.window.document.querySelector('[data-codex-inline-status]').shadowRoot.querySelector('[data-metric="speed"]').title.includes(label));
  }
  api.apply({ key, metrics: { ...metrics(120, .96), scope: 'visible_text_client', measurement_method: 'visible_stream', state: 'provisional' } });
  const shadow = dom.window.document.querySelector('[data-codex-inline-status]').shadowRoot;
  assert.ok(shadow.querySelector('[data-metric="speed"] .number-switch').classList.contains('is-switching'), '等待后首次出现数字也默认播放动画');
  assert.ok(shadow.querySelector('[data-metric="cache"] .number-switch').classList.contains('is-switching'));
});
function footerGeometry(node) {
  if (node.matches('[data-thread-scroll-footer]')) return rect(291, 400, 789, 150);
  if (node.matches('[data-codex-inline-status]')) return rect(291 + (parseFloat(node.style.left) || 0), 400 + (parseFloat(node.style.top) || 0), parseFloat(node.style.width) || 240, 26);
  if (node.matches('[data-testid="composer"]')) return rect(317.5, 450, 736, 82);
  if (node.classList.contains('ComposerLayoutFooter')) return rect(317.5, 450, 736, 82);
  if (node.getAttribute('data-controls') === 'left') return rect(325, 500, 119, 32);
  if (node.getAttribute('data-controls') === 'right') return rect(454.5, 500, 591, 32);
  if (node.tagName === 'BUTTON') {
    const group = node.closest('[data-controls]');
    const index = [...group.querySelectorAll('button')].indexOf(node);
    if (group.getAttribute('data-controls') === 'left') return index === 0 ? rect(325, 500, 28, 32) : rect(361, 500, 83, 32);
    return [rect(827, 500, 146, 32), rect(981, 500, 28, 32), rect(1017, 500, 28, 32)][index];
  }
  if (node.classList.contains('AdaptiveFooterInput')) return rect(317.5, node.getAttribute('data-codex-inline-footer-slot') === 'input' ? 450 : 500, 736, 30);
  return rect(325, 450, 100, 30);
}

function setup(html, fakeTimers = false, options = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => { throw error; });
  const dom = new JSDOM(`<body><main>${html}</main></body>`, { runScripts: "outside-only", virtualConsole });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (options.geometry) return options.geometry(this);
    return { x: 0, y: 0, left: 0, top: 0, width: 600, height: 100, right: 600, bottom: 100 };
  };
  const resizeObservers = [];
  if (options.resizeObserver) dom.window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); this.disconnected = false; resizeObservers.push(this); }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); this.disconnected = true; }
  };
  const timers = new Map();
  let timerId = 0;
  if (fakeTimers) {
    dom.window.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
    dom.window.clearTimeout = id => timers.delete(id);
  }
  dom.window.eval(source);
  return { dom, document: dom.window.document, api: dom.window.__CODEX_INLINE_STATUS__, timers, resizeObservers };
}

test("stable footer uses the requested 16px optical correction with asymmetric buttons", t => {
  const { dom, document, api } = setup(stableFooter(A), true, { geometry: footerGeometry });
  t.after(() => { api.destroy(); dom.window.close(); });
  const footer = document.querySelector('[data-thread-scroll-footer]');
  const element = document.querySelector('[data-testid="composer"]');
  const row = element.querySelector('.ComposerLayoutFooter');
  const host = footer.querySelector('[data-codex-inline-status]');
  const originalClass = row.className;
  api.apply({ key: api.discover()[0].key, metrics: metrics(112) });
  const box = host.getBoundingClientRect();
  const left = document.querySelector('[data-controls="left"]').getBoundingClientRect();
  const rightSlot = document.querySelector('[data-controls="right"]').getBoundingClientRect();
  const rightButtons = [...document.querySelectorAll('[data-controls="right"] button')].map(node => node.getBoundingClientRect());
  const input = document.querySelector('.AdaptiveFooterInput').getBoundingClientRect();
  assert.equal(host.parentElement, footer);
  assert.equal(element.contains(host), false);
  const composerBox = element.getBoundingClientRect();
  assert.equal((box.left + box.right) / 2, (composerBox.left + composerBox.right) / 2 - 16);
  assert.equal((box.top + box.bottom) / 2, 516);
  assert.ok(box.left >= left.right + 8);
  assert.ok(rightSlot.width > box.width, 'full-width right slot retains space for the native model label');
  assert.ok(box.right <= Math.min(...rightButtons.map(button => button.left)) - 8, 'only actual button rectangles limit the middle status');
  assert.notEqual((box.left + box.right) / 2, (left.right + Math.min(...rightButtons.map(button => button.left))) / 2, 'asymmetric button gap must not determine the center');
  assert.ok(box.top >= input.bottom);
  assert.equal(row.className, originalClass);
  assert.equal(document.querySelector('.AdaptiveFooterInput').getAttribute('data-codex-inline-footer-slot'), 'input');
  assert.equal(document.querySelectorAll('button').length, 5);
  assert.equal(host.style.pointerEvents, 'none');
  const scopedCss = document.querySelector('[data-codex-inline-layout-style]').textContent;
  assert.match(scopedCss, /grid-template-columns:auto minmax\(0,1fr\)/);
  assert.match(scopedCss, /slot="right"\][^{]*\{[^}]*justify-self:stretch/);
});

test("status is above a positioned composer body without changing the official stacking levels", t => {
  const ordinary = stableComposer();
  const nested = ordinary.replace('data-codex-composer-root>', 'data-codex-composer-root><div class="ComposerLayoutBody" style="position:relative;z-index:10">').replace(/<\/div>$/, '</div></div>');
  const { dom, document, api } = setup(stableFooter(A).replace(ordinary, nested), true, { geometry: footerGeometry });
  t.after(() => { api.destroy(); dom.window.close(); });
  const body = document.querySelector('.ComposerLayoutBody');
  const host = document.querySelector('[data-codex-inline-status]');
  assert.ok(Number(host.style.zIndex) > 10);
  assert.equal(body.style.zIndex, '10');
  assert.equal(body.style.position, 'relative');
});

test("replacing the entire composer and send controls preserves the stable host and same-thread metrics", async t => {
  const { dom, document, api } = setup(stableFooter(A), true, { geometry: footerGeometry });
  t.after(() => { api.destroy(); dom.window.close(); });
  const footer = document.querySelector('[data-thread-scroll-footer]');
  const host = footer.querySelector('[data-codex-inline-status]');
  const first = api.discover()[0];
  api.apply({ key: first.key, metrics: metrics(112) });
  const replacement = document.createElement('div'); replacement.innerHTML = stableComposer();
  document.querySelector('[data-testid="composer"]').replaceWith(replacement.firstElementChild);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(footer.querySelector('[data-codex-inline-status]'), host);
  assert.equal(api.discover()[0].key, first.key);
  assert.equal(api.inspect().bindings[0].labels[0], '112 tok/s');
  document.querySelector('[data-send]').outerHTML = '<button data-send>停止</button>';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(footer.querySelector('[data-codex-inline-status]'), host);
  assert.equal(api.inspect().bindings[0].labels[0], '112 tok/s');
  const previousRight = document.querySelector('[data-controls="right"]');
  previousRight.outerHTML = '<div data-controls="right"><button>模型</button><button>麦克风</button><button data-send>发送</button></div>';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('[data-controls="right"]').getAttribute('data-codex-inline-footer-slot'), 'right');
  assert.equal(previousRight.hasAttribute('data-codex-inline-footer-slot'), false);
  assert.equal(footer.querySelector('[data-codex-inline-status]'), host);
});

test("a stable footer gap retains the host, rejects updates, and clears stale values once without removing it", async t => {
  const { dom, document, api, timers } = setup(stableFooter(A), true, { geometry: footerGeometry });
  t.after(() => { api.destroy(); dom.window.close(); });
  const footer = document.querySelector('[data-thread-scroll-footer]');
  const host = footer.querySelector('[data-codex-inline-status]');
  const first = api.discover()[0];
  api.apply({ key: first.key, metrics: metrics(112) });
  document.querySelector('[data-testid="composer"]').remove();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.isConnected, true);
  assert.equal(api.inspect().bindings[0].labels[0], '112 tok/s');
  assert.equal(api.discover()[0].threadId, null);
  assert.equal(api.apply({ key: first.key, metrics: metrics(999) }), false);
  const [timerId, timer] = [...timers.entries()].find(([, value]) => value.delay === 1200);
  timers.delete(timerId); timer.callback();
  assert.equal(host.isConnected, true);
  assert.equal(api.inspect().bindings[0].labels[0], '— tok/s');
  assert.equal(api.inspect().bindings[0].issue, 'awaiting_composer');
  for (const [id, animation] of [...timers]) if (animation.delay === 850) { timers.delete(id); animation.callback(); }
  assert.equal(timers.size, 0);
  footer.insertAdjacentHTML('beforeend', stableComposer());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(footer.querySelector('[data-codex-inline-status]'), host);
  assert.equal(api.discover()[0].key, first.key);
  assert.equal(api.apply({ key: first.key, metrics: metrics(44) }), true);
});

test("stable footer identity changes clear values and reject old keys while keeping its host", async t => {
  const { dom, document, api } = setup(stableFooter(A), true, { geometry: footerGeometry });
  t.after(() => { api.destroy(); dom.window.close(); });
  const host = document.querySelector('[data-codex-inline-status]');
  const marker = document.querySelector('[data-above-composer-conversation-id]');
  const first = api.discover()[0];
  api.apply({ key: first.key, metrics: metrics(112) });
  marker.removeAttribute('data-above-composer-conversation-id');
  await new Promise(resolve => setImmediate(resolve));
  const draft = api.discover()[0];
  assert.equal(document.querySelector('[data-codex-inline-status]'), host);
  assert.equal(draft.threadId, null);
  assert.notEqual(draft.key, first.key);
  assert.equal(api.inspect().bindings[0].labels[0], '— tok/s');
  assert.equal(api.apply({ key: first.key, metrics: metrics(999) }), false);
  marker.setAttribute('data-above-composer-conversation-id', B);
  await new Promise(resolve => setImmediate(resolve));
  const next = api.discover()[0];
  assert.equal(next.threadId, B);
  assert.notEqual(next.key, draft.key);
  assert.equal(document.querySelector('[data-codex-inline-status]'), host);
  assert.equal(api.apply({ key: draft.key, metrics: metrics(999) }), false);
  assert.equal(api.apply({ key: next.key, metrics: metrics(44) }), true);
});

test("a stable footer with an explicit foreign identity is removed even during a composer gap", async t => {
  const { dom, document, api } = setup(stableFooter(A), true, { geometry: footerGeometry });
  t.after(() => { api.destroy(); dom.window.close(); });
  const first = api.discover()[0];
  api.apply({ key: first.key, metrics: metrics(112) });
  const host = document.querySelector('[data-codex-inline-status]');
  document.querySelector('[data-testid="composer"]').remove();
  document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', 'chatgpt:' + A);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.isConnected, false);
  assert.equal(api.inspect().count, 0);
  assert.equal(api.apply({ key: first.key, metrics: metrics(999) }), false);
});

test("stable footer removal and destroy release scoped styles, observers, and timers", t => {
  const { dom, document, api, timers, resizeObservers } = setup(stableFooter(A), true, { geometry: footerGeometry, resizeObserver: true });
  t.after(() => dom.window.close());
  const footer = document.querySelector('[data-thread-scroll-footer]');
  const row = document.querySelector('.ComposerLayoutFooter');
  api.apply({ key: api.discover()[0].key, metrics: metrics(112) });
  assert.ok(resizeObservers[0].nodes.size > 0);
  api.destroy();
  assert.equal(footer.querySelector('[data-codex-inline-status]'), null);
  assert.equal(row.hasAttribute('data-codex-inline-footer-layout'), false);
  assert.equal(row.style.getPropertyValue('--codex-inline-row-height'), '');
  assert.equal(row.querySelector('[data-codex-inline-footer-slot]'), null);
  assert.equal(document.querySelector('[data-codex-inline-layout-style]'), null);
  assert.equal(resizeObservers[0].disconnected, true);
  assert.equal(timers.size, 0);
});

test("one to two to one lanes leave exactly one host per current composer", async t => {
  const lane = () => `<section><div data-above-composer-portal data-above-composer-conversation-id="${A}"></div>${stableComposer()}</section>`;
  const { dom, document, api } = setup(`<div data-thread-scroll-footer style="position:absolute">${lane()}</div>`, true, { geometry: footerGeometry });
  t.after(() => { api.destroy(); dom.window.close(); });
  const footer = document.querySelector('[data-thread-scroll-footer]');
  assert.equal(api.discover().length, 1);
  footer.insertAdjacentHTML('beforeend', lane());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.discover().length, 2);
  assert.equal(footer.querySelectorAll('[data-codex-inline-status]').length, 2);
  footer.querySelectorAll('section')[1].remove();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.discover().length, 1);
  assert.equal(footer.querySelectorAll('[data-codex-inline-status]').length, 1);
});

test("an externally removed stable host and layout stylesheet are restored without losing data", async t => {
  const { dom, document, api } = setup(stableFooter(A), true, { geometry: footerGeometry });
  t.after(() => { api.destroy(); dom.window.close(); });
  const first = api.discover()[0];
  api.apply({ key: first.key, metrics: metrics(112) });
  const host = document.querySelector('[data-codex-inline-status]');
  host.remove();
  document.querySelector('[data-codex-inline-layout-style]').remove();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('[data-codex-inline-status]'), host);
  assert.ok(document.querySelector('[data-codex-inline-layout-style]'));
  assert.equal(api.discover()[0].key, first.key);
  assert.equal(api.inspect().bindings[0].labels[0], '112 tok/s');
});

test("main and side composers bind independent UUIDs without moving React content", () => {
  const { dom, document, api } = setup(composer(A) + composer(B));
  const inputs = [...document.querySelectorAll("textarea")];
  const buttons = [...document.querySelectorAll("button")];
  const bindings = api.discover();
  assert.equal(bindings.length, 2);
  assert.equal(api.apply({ key: bindings[0].key, metrics: metrics(112) }), true);
  api.apply({ key: bindings[1].key, metrics: metrics(44, .8) });
  assert.deepEqual(Array.from(api.inspect().bindings, item => Array.from(item.labels)), [["112 tok/s", "缓存命中 95.0%"], ["44 tok/s", "缓存命中 80.0%"]]);
  inputs.forEach((node, i) => assert.equal(document.querySelectorAll("textarea")[i], node));
  buttons.forEach((node, i) => assert.equal(document.querySelectorAll("button")[i], node));
  for (const [index, element] of [...document.querySelectorAll('[data-testid="composer"]')].entries()) {
    const host = element.nextElementSibling;
    assert.equal(host.dataset.codexInlineStatus, "1");
    assert.equal(host.parentElement, element.parentElement);
    assert.equal(element.contains(host), false);
    assert.deepEqual([...element.children], [inputs[index], buttons[index]]);
    assert.equal(host.style.position, "relative");
    assert.equal(host.shadowRoot.querySelectorAll("svg").length, 2);
  }
  assert.doesNotThrow(() => JSON.stringify(api.inspect()));
  dom.window.close();
});

test("switching a mounted composer clears values and rejects an old in-flight key", () => {
  const { dom, document, api } = setup(composer(A));
  const first = api.discover()[0];
  const element = document.querySelector('[data-testid="composer"]');
  const firstHost = element.nextElementSibling;
  api.apply({ key: first.key, metrics: metrics(112) });
  document.querySelector("[data-above-composer-conversation-id]").setAttribute("data-above-composer-conversation-id", B);
  const next = api.discover()[0];
  assert.notEqual(next.key, first.key);
  assert.equal(next.threadId, B);
  assert.equal(firstHost.isConnected, true);
  assert.equal(element.nextElementSibling, firstHost);
  assert.equal(element.nextElementSibling.dataset.codexInlineStatus, "1");
  assert.equal(document.querySelectorAll("[data-codex-inline-status]").length, 1);
  assert.equal(api.apply({ key: first.key, metrics: metrics(900) }), false);
  assert.equal(api.inspect().bindings[0].labels[0], "— tok/s");
  dom.window.close();
});

test("a confirmed Codex draft starts with placeholders and rejects supplied metrics", t => {
  for (const markup of [codexComposer(""), portalDraft(), codexComposer("").replace('<div data-above-composer-conversation-id=""></div>', '')]) {
    const { dom, document, api, timers } = setup(markup, true);
    t.after(() => dom.window.close());
    const [binding] = api.discover();
    assert.equal(binding.threadId, null);
    assert.equal(document.querySelector('[data-testid="composer"]').nextElementSibling.dataset.codexInlineStatus, "1");
    assert.equal(api.apply({ key: binding.key, metrics: metrics(900) }), false);
    const state = api.inspect().bindings[0];
    assert.equal(state.pending, true);
    assert.equal(state.issue, "awaiting_thread");
    assert.equal(state.hasMetrics, false);
    assert.deepEqual(Array.from(state.labels), ["— tok/s", "缓存命中 —"]);
    assert.equal(timers.size, 0);
    assert.equal(api.discover()[0].key, binding.key);
    assert.equal(api.destroy().removed, 1);
    assert.equal(document.querySelectorAll('[data-codex-inline-status]').length, 0);
  }
});

test("A to draft to B keeps its external host but clears values, timers, and in-flight keys", async t => {
  const { dom, document, api, timers } = setup(codexComposer(A), true);
  t.after(() => dom.window.close());
  const marker = document.querySelector('[data-above-composer-conversation-id]');
  const element = document.querySelector('[data-testid="composer"]');
  const host = element.nextElementSibling;
  const first = api.discover()[0];
  api.apply({ key: first.key, metrics: metrics(112) });
  assert.equal([...timers.values()].filter(timer => timer.delay === 15000).length, 1);
  marker.setAttribute('data-above-composer-conversation-id', '');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.shadowRoot.querySelector('[data-metric="speed"] > span').textContent, "— tok/s");
  const draft = api.discover()[0];
  assert.equal(draft.threadId, null);
  assert.notEqual(draft.key, first.key);
  assert.equal(element.nextElementSibling, host);
  assert.equal(timers.size, 0);
  assert.equal(api.apply({ key: first.key, metrics: metrics(900) }), false);
  assert.equal(api.apply({ key: draft.key, metrics: metrics(901) }), false);
  assert.equal(api.discover()[0].key, draft.key);
  marker.setAttribute('data-above-composer-conversation-id', B);
  await new Promise(resolve => setImmediate(resolve));
  const next = api.discover()[0];
  assert.equal(next.threadId, B);
  assert.notEqual(next.key, draft.key);
  assert.equal(element.nextElementSibling, host);
  assert.equal(api.inspect().bindings[0].pending, false);
  assert.equal(api.inspect().bindings[0].hasMetrics, false);
  assert.equal(api.apply({ key: first.key, metrics: metrics(902) }), false);
  assert.equal(api.apply({ key: draft.key, metrics: metrics(903) }), false);
  assert.equal(api.apply({ key: next.key, metrics: metrics(44) }), true);
  assert.equal(api.inspect().bindings[0].labels[0], "44 tok/s");
  assert.equal([...timers.values()].filter(timer => timer.delay === 15000).length, 1);
  api.destroy();
  assert.equal(timers.size, 0);
});

test("a previously bound composer is removed on foreign, invalid, or ambiguous identity", t => {
  for (const invalid of ['chatgpt:' + A, 'unknown', 'ambiguous']) {
    const { dom, document, api, timers } = setup(codexComposer(A), true);
    t.after(() => dom.window.close());
    const first = api.discover()[0];
    const host = document.querySelector('[data-codex-inline-status]');
    api.apply({ key: first.key, metrics: metrics(112) });
    const marker = document.querySelector('[data-above-composer-conversation-id]');
    if (invalid === 'ambiguous') marker.insertAdjacentHTML('afterend', `<div data-thread-id="${B}"></div>`);
    else marker.setAttribute('data-above-composer-conversation-id', invalid);
    assert.equal(api.discover().length, 0);
    assert.equal(host.isConnected, false);
    assert.equal(timers.size, 0);
    assert.equal(api.apply({ key: first.key, metrics: metrics(999) }), false);
  }
});

test("a portal-only Codex draft beside A keeps its own placeholder and unknown side input borrows nothing", t => {
  const unknown = '<section><div data-above-composer-portal></div><div data-testid="composer"><textarea></textarea><button>Send</button></div></section>';
  const { dom, document, api } = setup(composer(A) + portalDraft() + unknown);
  t.after(() => dom.window.close());
  const bindings = api.discover();
  assert.deepEqual(Array.from(bindings, binding => binding.threadId), [A, null]);
  api.apply({ key: bindings[0].key, metrics: metrics(112) });
  assert.equal(api.apply({ key: bindings[1].key, metrics: metrics(999) }), false);
  assert.deepEqual(Array.from(api.inspect().bindings, binding => binding.labels[0]), ["112 tok/s", "— tok/s"]);
  const elements = document.querySelectorAll('[data-testid="composer"]');
  assert.equal(elements[1].nextElementSibling.dataset.codexInlineStatus, "1");
  assert.equal(elements[2].nextElementSibling, null);
});

test("a hidden nested Codex input cannot establish ownership for an unknown visible input", t => {
  const { dom, document, api } = setup('<section><div data-above-composer-portal></div><div data-testid="composer"><textarea></textarea><button>Send</button><aside style="display:none"><textarea data-codex-thread-reference-drop-target></textarea></aside></div></section>');
  t.after(() => dom.window.close());
  assert.equal(api.discover().length, 0);
  assert.equal(document.querySelectorAll('[data-codex-inline-status]').length, 0);
});

test("the observer mounts an added portal draft without UUID and reacts to its input attribute", async t => {
  const { dom, document, api } = setup("");
  t.after(() => dom.window.close());
  document.querySelector('main').insertAdjacentHTML('beforeend', portalDraft());
  await new Promise(resolve => setImmediate(resolve));
  const element = document.querySelector('[data-testid="composer"]');
  const input = element.querySelector('textarea');
  const firstHost = element.nextElementSibling;
  assert.equal(firstHost?.dataset.codexInlineStatus, "1");
  assert.equal(firstHost.shadowRoot.querySelector('[data-metric="speed"] > span').textContent, "— tok/s");
  input.removeAttribute('data-codex-thread-reference-drop-target');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstHost.isConnected, false);
  input.setAttribute('data-codex-thread-reference-drop-target', '');
  await new Promise(resolve => setImmediate(resolve));
  const nextHost = element.nextElementSibling;
  assert.equal(nextHost?.dataset.codexInlineStatus, "1");
  assert.notEqual(nextHost, firstHost);
  element.remove();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextHost.isConnected, false);
  assert.equal(api.inspect().count, 0);
});

test("removing only a composer cleans its external host and retains another conversation", () => {
  const { dom, document, api, timers } = setup(composer(A) + composer(B), true);
  const [first, second] = api.discover();
  const [firstComposer, secondComposer] = document.querySelectorAll('[data-testid="composer"]');
  const firstHost = firstComposer.nextElementSibling;
  const secondHost = secondComposer.nextElementSibling;
  api.apply({ key: first.key, metrics: metrics(112) });
  api.apply({ key: second.key, metrics: metrics(44) });
  firstComposer.remove();
  const remaining = api.discover();
  assert.equal(firstHost.isConnected, false);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].key, second.key);
  assert.equal(remaining[0].threadId, B);
  assert.equal(secondComposer.nextElementSibling, secondHost);
  assert.equal(api.inspect().bindings[0].labels[0], "44 tok/s");
  assert.equal(api.apply({ key: first.key, metrics: metrics(999) }), false);
  assert.equal(document.querySelectorAll("[data-codex-inline-status]").length, 1);
  assert.equal([...timers.values()].filter(timer => timer.delay === 15000).length, 1);
  api.destroy();
  assert.equal(secondHost.isConnected, false);
  assert.equal(document.querySelectorAll("[data-codex-inline-status]").length, 0);
  assert.equal(timers.size, 0);
  dom.window.close();
});

test("empty display-none identity markers still bind their own visible composers", () => {
  const hiddenMarkerComposer = id => composer(id).replace('data-above-composer-conversation-id=', 'class="empty:hidden" style="display:none" data-above-composer-conversation-id=');
  const { dom, document, api } = setup(hiddenMarkerComposer(A) + hiddenMarkerComposer(B));
  const bindings = api.discover();
  assert.deepEqual(Array.from(bindings, binding => binding.threadId), [A, B]);
  api.apply({ key: bindings[0].key, metrics: metrics(112) });
  api.apply({ key: bindings[1].key, metrics: metrics(44) });
  assert.deepEqual(Array.from(api.inspect().bindings, binding => binding.labels[0]), ["112 tok/s", "44 tok/s"]);
  for (const element of document.querySelectorAll('[data-testid="composer"]')) {
    assert.equal(element.nextElementSibling.dataset.codexInlineStatus, "1");
  }
  dom.window.close();
});

test("a hidden marker parent and a hidden conversation cannot supply a visible composer identity", () => {
  const { dom, document, api } = setup(`<section><div style="display:none"><div data-thread-id="${A}" style="display:none"></div></div><div data-testid="composer"><textarea></textarea><button>Send</button></div></section><div style="display:none">${composer(B)}</div>`);
  assert.equal(api.discover().length, 0);
  assert.equal(document.querySelectorAll("[data-codex-inline-status]").length, 0);
  dom.window.close();
});

test("identity mutation clears old values before the next external polling cycle", async () => {
  const { dom, document, api } = setup(composer(A));
  const previous = api.discover()[0];
  api.apply({ key: previous.key, metrics: metrics(112) });
  document.querySelector("[data-above-composer-conversation-id]").setAttribute("data-above-composer-conversation-id", B);
  await new Promise(resolve => setTimeout(resolve, 0));
  const host = document.querySelector("[data-codex-inline-status]");
  assert.equal(host.shadowRoot.querySelector('[data-metric="speed"] > span').textContent, "— tok/s");
  assert.equal(api.apply({ key: previous.key, metrics: metrics(999) }), false);
  dom.window.close();
});

test("unknown, ChatGPT, inactive, hidden, and ambiguous composers receive no bindings", () => {
  const html = composer("unknown") + composer("chatgpt:" + A)
    + `<div aria-hidden="true">${composer(A)}</div>`
    + `<div inert>${composer(A)}</div>`
    + `<div data-app-shell-active-page="false">${composer(A)}</div>`
    + `<section><div data-thread-id="${A}"></div><div data-thread-id="${B}"></div><div data-testid="composer"><textarea></textarea><button>Send</button></div></section>`;
  const { dom, document, api } = setup(html);
  assert.equal(api.discover().length, 0);
  assert.equal(document.querySelectorAll("[data-codex-inline-status]").length, 0);
  assert.equal(api.apply({ key: "unknown", metrics: metrics(123) }), false);
  dom.window.close();
});

test("an unknown side composer cannot inherit a different sibling's UUID", () => {
  const { dom, api } = setup(`<section>${composer(A)}<div data-testid="composer"><textarea></textarea><button>Send</button></div></section>`);
  assert.equal(api.discover().length, 1);
  assert.equal(api.discover()[0].threadId, A);
  dom.window.close();
});

test("a shared ancestor UUID is not borrowed by unlabelled main or side composers", () => {
  const { dom, document, api } = setup(`<section data-thread-id="${A}"><div data-testid="composer"><textarea></textarea><button>Send</button></div><aside><div data-testid="composer"><textarea></textarea><button>Send</button></div></aside></section>`);
  assert.equal(api.discover().length, 0);
  assert.equal(document.querySelectorAll("[data-codex-inline-status]").length, 0);
  dom.window.close();
});

test("a nested side composer wins over outer chrome and retains its own thread", () => {
  const { dom, document, api } = setup(`<div class="composer-surface-chrome" data-thread-id="${A}"><div data-testid="composer-input"><textarea></textarea></div><button>Send</button><aside data-thread-id="${B}"><div data-testid="composer"><textarea></textarea><button>Send</button></div></aside></div>`);
  const bindings = api.discover();
  assert.equal(bindings.length, 2);
  assert.deepEqual(Array.from(bindings, binding => binding.threadId), [A, B]);
  api.apply({ key: bindings[0].key, metrics: metrics(112) });
  api.apply({ key: bindings[1].key, metrics: metrics(44) });
  const hosts = document.querySelectorAll("[data-codex-inline-status]");
  assert.equal(hosts.length, 2);
  assert.equal(document.querySelector('[data-testid="composer-input"]').querySelectorAll("[data-codex-inline-status]").length, 0);
  const sideComposer = document.querySelector('aside [data-testid="composer"]');
  assert.equal(sideComposer.nextElementSibling.dataset.codexInlineStatus, "1");
  assert.equal(sideComposer.contains(sideComposer.nextElementSibling), false);
  assert.equal(document.querySelector('.composer-surface-chrome').nextElementSibling.dataset.codexInlineStatus, "1");
  assert.deepEqual(Array.from(api.inspect().bindings, binding => binding.labels[0]), ["112 tok/s", "44 tok/s"]);
  dom.window.close();
});

test("partial 99.6 percent cache is not shown as full hit; invalid scope clears data", () => {
  const { dom, api } = setup(composer(A));
  const binding = api.discover()[0];
  api.apply({ key: binding.key, metrics: metrics(112, .996) });
  assert.equal(api.inspect().bindings[0].labels[1], "缓存命中 99.6%");
  assert.equal(api.apply({ key: binding.key, metrics: { ...metrics(9), scope: "live" } }), false);
  assert.equal(api.inspect().bindings[0].labels[0], "— tok/s");
  dom.window.close();
});

test("estimated speed states its source and cache uses one decimal without rounding a partial hit to full", () => {
  const { dom, document, api } = setup(composer(A));
  const binding = api.discover()[0];
  api.apply({ key: binding.key, metrics: metrics(112, .9826) });
  assert.deepEqual(Array.from(api.inspect().bindings[0].labels), ["112 tok/s", "缓存命中 98.3%"]);
  const title = document.querySelector("[data-codex-inline-status]").shadowRoot.querySelector('[data-metric="speed"]').title;
  assert.match(title, /整轮有效平均/);
  assert.match(title, /总整轮耗时，包含等待、推理和工具执行/);
  assert.match(title, /已采样完成轮次加权平均/);
  assert.match(title, /不是服务端实时测速/);
  api.apply({ key: binding.key, metrics: metrics(112, .9996) });
  assert.equal(api.inspect().bindings[0].labels[1], "缓存命中 99.96%");
  api.apply({ key: binding.key, metrics: metrics(112, 1) });
  assert.equal(api.inspect().bindings[0].labels[1], "缓存命中 100.0%");
  dom.window.close();
});

test("source failure is explicit but an excluded latest sample does not invalidate a reliable aggregate", () => {
  const { dom, api } = setup(composer(A));
  const binding = api.discover()[0];
  api.apply({ key: binding.key, metrics: { ...metrics(112), issue: "logs_unavailable" } });
  let state = api.inspect().bindings[0];
  assert.equal(state.issue, "logs_unavailable");
  assert.equal(state.dataUnavailable, true);
  assert.equal(state.hasMetrics, false);
  assert.deepEqual(Array.from(state.labels), ["— tok/s", "缓存命中 —"]);
  api.apply({ key: binding.key, metrics: { ...metrics(112), issue: "missing_stream_start" } });
  state = api.inspect().bindings[0];
  assert.equal(state.issue, "missing_stream_start");
  assert.equal(state.dataUnavailable, false);
  assert.equal(state.hasMetrics, true);
  assert.equal(state.labels[0], "112 tok/s");
  dom.window.close();
});

test("disabled stream speeds are rejected while independently valid cache metrics remain visible", t => {
  const { dom, document, api } = setup(composer(A));
  t.after(() => dom.window.close());
  const binding = api.discover()[0];
  api.apply({ key: binding.key, metrics: metrics(112) });
  api.apply({ key: binding.key, metrics: { ...metrics(12047), measurement_method: 'stream_decode' } });
  assert.deepEqual(Array.from(api.inspect().bindings[0].labels), ['— tok/s', '缓存命中 95.0%']);
  assert.equal(api.inspect().bindings[0].dataUnavailable, false);
  let title = document.querySelector('[data-codex-inline-status]').shadowRoot.querySelector('[data-metric="speed"]').title;
  assert.match(title, /整轮有效平均/);
  api.apply({ key: binding.key, metrics: { ...metrics(12047), measurement_method: undefined } });
  assert.equal(api.inspect().bindings[0].labels[0], '— tok/s');
  title = document.querySelector('[data-codex-inline-status]').shadowRoot.querySelector('[data-metric="speed"]').title;
  assert.match(title, /暂无可核实的测速数据/);
});

test("one-shot watchdog clears disconnected values, resets on apply, and is removed by destroy", () => {
  const { dom, api, timers } = setup(composer(A), true);
  const binding = api.discover()[0];
  api.apply({ key: binding.key, metrics: metrics(112) });
  const first = [...timers.keys()][0];
  assert.equal(timers.get(first).delay, 15000);
  api.apply({ key: binding.key, metrics: metrics(120) });
  assert.equal([...timers.values()].filter(timer => timer.delay === 15000).length, 1);
  assert.equal(timers.has(first), false);
  const [id, timer] = [...timers.entries()].find(([, timer]) => timer.delay === 15000);
  timers.delete(id); timer.callback();
  const state = api.inspect().bindings[0];
  assert.equal(state.issue, "monitor_disconnected");
  assert.equal(state.dataUnavailable, true);
  assert.equal(state.hasMetrics, false);
  assert.deepEqual(Array.from(state.labels), ["— tok/s", "缓存命中 —"]);
  for (const [id, animation] of [...timers]) if (animation.delay === 850) { timers.delete(id); animation.callback(); }
  assert.equal(timers.size, 0);
  api.apply({ key: binding.key, metrics: metrics(130) });
  assert.equal([...timers.values()].filter(timer => timer.delay === 15000).length, 1);
  assert.equal(api.inspect().bindings[0].dataUnavailable, false);
  api.destroy();
  assert.equal(timers.size, 0);
  dom.window.close();
});

test("route switching cancels the old binding watchdog and late old data cannot rearm it", async () => {
  const { dom, document, api, timers } = setup(composer(A), true);
  const previous = api.discover()[0];
  api.apply({ key: previous.key, metrics: metrics(112) });
  document.querySelector("[data-above-composer-conversation-id]").setAttribute("data-above-composer-conversation-id", B);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
  assert.equal(api.apply({ key: previous.key, metrics: metrics(900) }), false);
  assert.equal(timers.size, 0);
  assert.equal(api.inspect().bindings[0].labels[0], "— tok/s");
  api.destroy();dom.window.close();
});

test("context-only input is ignored and the UI contains exactly two adjacent readings", () => {
  const { dom, document, api } = setup(composer(A));
  const binding = api.discover()[0];
  assert.equal(api.version, "1.3.5");
  api.apply({ key: binding.key, metrics: { scope: "sampled_session", context_used: .25, context_window: 200000 } });
  const state = api.inspect().bindings[0];
  assert.equal(state.hasMetrics, false);
  assert.deepEqual(Array.from(state.labels), ["— tok/s", "缓存命中 —"]);
  const shadow = document.querySelector("[data-codex-inline-status]").shadowRoot;
  assert.equal(shadow.querySelectorAll(".metric").length, 2);
  assert.equal(shadow.querySelector('[data-metric="context"]'), null);
  assert.equal(shadow.querySelector(".track,.fill"), null);
  assert.equal(shadow.textContent.includes("上下文"), false);
  assert.equal(shadow.querySelector("style").textContent.includes("margin-left:auto"), false);
  dom.window.close();
});

test("destroy removes every host and reinjection remains idempotent", () => {
  const { dom, document, api } = setup(composer(A) + composer(B));
  const firstKey = api.discover()[0].key;
  api.apply({ key: firstKey, metrics: metrics(112) });
  dom.window.eval(source);
  assert.equal(document.querySelectorAll("[data-codex-inline-status]").length, 2);
  assert.equal(api.inspect().active, true);
  const current = dom.window.__CODEX_INLINE_STATUS__;
  assert.equal(current, api);
  assert.equal(current.discover()[0].key, firstKey);
  assert.equal(current.inspect().bindings[0].labels[0], "112 tok/s");
  assert.equal(current.destroy().removed, 2);
  assert.equal(document.querySelectorAll("[data-codex-inline-status]").length, 0);
  assert.equal(document.querySelectorAll("textarea,button").length, 4);
  assert.equal(current.discover().length, 0);
  assert.equal(dom.window.__CODEX_INLINE_STATUS__, undefined);
  dom.window.close();
});
