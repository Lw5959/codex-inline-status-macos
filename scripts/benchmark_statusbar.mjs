// 开发期可复现负载；统计页面扫描、布局读取和快照字节，不能替代真实应用帧率。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const turn = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dom = new JSDOM(`<main>${'<p>历史消息正文</p>'.repeat(1000)}<section data-thread-id="${A}"><div data-testid="composer"><textarea></textarea><button>发送</button></div></section></main>`, { runScripts: 'outside-only' });
const { window } = dom;
let scans = 0, geometry = 0, styles = 0, clock = 0;
const query = window.document.querySelectorAll.bind(window.document);
window.document.querySelectorAll = selector => { scans++; return query(selector); };
window.HTMLElement.prototype.getBoundingClientRect = () => { geometry++; return { x: 0, y: 0, width: 600, height: 100, left: 0, top: 0, right: 600, bottom: 100 }; };
const computed = window.getComputedStyle.bind(window);
window.getComputedStyle = node => { styles++; return computed(node); };
Object.defineProperty(window.performance, 'now', { value: () => clock });
for (const name of ['native_statusbar.js', 'visible_stream_observer.js']) window.eval(fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'));
const bar = window.__CODEX_INLINE_STATUS__, observer = window.__CODEX_VISIBLE_STREAM__;
const emit = (method, params) => { clock += 10; window.dispatchEvent(new window.MessageEvent('message', { source: null, data: { type: 'mcp-notification', hostId: 'local', method, params: { threadId: A, turnId: turn, ...params } } })); };
for (let i = 0; i < 32; i++) {
  const id = 'item-' + i, first = '正文 ', rest = '可复现的性能负载 example. '.repeat(100);
  emit('item/started', { startedAtMs: Date.now() + 10, item: { id, type: 'agentMessage', text: '' } });
  emit('item/agentMessage/delta', { itemId: id, delta: first });
  emit('item/agentMessage/delta', { itemId: id, delta: rest });
  emit('item/completed', { item: { id, type: 'agentMessage', text: first + rest } });
}
let cursor, bytes = 0;
scans = 0; geometry = 0; styles = 0;
const started = performance.now();
for (let i = 0; i < 100; i++) {
  const views = bar.bindings ? bar.bindings() : bar.discover();
  const snapshot = observer.snapshot(A, cursor);
  bytes += Buffer.byteLength(JSON.stringify(snapshot));
  cursor = { observerId: snapshot.observerId, revision: snapshot.revision };
  for (const view of views) bar.apply({ key: view.key, metrics: { scope: 'visible_text_client', measurement_method: 'visible_stream', tps: 100, cache_hit: .95 } });
  bar.inspect({ refresh: false, geometry: false });
}
console.log(JSON.stringify({ workload: '100 unchanged refreshes, 32 completed items, 1000 history nodes', documentScans: scans, layoutReads: geometry, computedStyleReads: styles, snapshotBytes: bytes, elapsedMs: Math.round(performance.now() - started) }, null, 2));
bar.destroy(); observer.destroy(); window.close();
