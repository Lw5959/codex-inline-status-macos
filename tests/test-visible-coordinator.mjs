import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encode, tokenByteLength } from '../src/visible_tokenizer.mjs';
import { countVisibleTokens } from '../src/visible_stream_meter.mjs';
const require = createRequire(new URL('./native-statusbar-deps/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const { WebSocketServer } = require('ws');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const turn = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ids = [A, B, A];
const clocks = [0, 0, 0];
const doms = ids.map((id, index) => {
  const dom = new JSDOM(`<section data-thread-id="${id}"><div data-testid="composer"><textarea></textarea><button>Send</button></div></section>`, { runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x:0,y:0,width:600,height:100,left:0,top:0,right:600,bottom:100 });
  Object.defineProperty(dom.window.performance, 'now', { value: () => clocks[index] });
  return dom;
});
let count = 1;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(doms.slice(0, count).map((_, i) => ({ id:String(i),type:'page',url:`app://-/index.html?initialRoute=${encodeURIComponent('/local/' + ids[i])}`,webSocketDebuggerUrl:`ws://127.0.0.1:${server.address().port}/${i}` }))));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (socket, req) => socket.on('message', raw => {
  const m = JSON.parse(String(raw));
  try {
    const value = m.method === 'Runtime.evaluate' ? doms[Number(req.url.slice(1))].window.eval(m.params.expression) : undefined;
    socket.send(JSON.stringify({ id:m.id,result:m.method === 'Runtime.evaluate' ? { result:{ value } } : {} }));
  } catch { socket.send(JSON.stringify({ id:m.id,error:{ code:-1,message:'fixture error' } })); }
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const report = fileURLToPath(new URL('./visible-coordinator-health.json', import.meta.url));
const child = spawn(process.execPath, ['--import', new URL('./fixture-native-metrics.mjs', import.meta.url).href,
  process.env.COORDINATOR_SOURCE || fileURLToPath(new URL('../src/native_status_injector.mjs', import.meta.url)), '--port', String(server.address().port), '--report', report], { stdio:['ignore','ignore','pipe'],windowsHide:true });
let stderr = '';
child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
const exited = new Promise(resolve => child.once('exit', resolve));
const waitFor = async predicate => {
  for (let i=0;i<100;i++) { try { if (predicate()) return; } catch {} await new Promise(resolve => setTimeout(resolve,100)); }
  throw Error('Coordinator fixture did not reach expected state: ' + stderr);
};
const label = i => doms[i].window.__CODEX_INLINE_STATUS__?.inspect().bindings[0]?.labels[0];
function emit(i, method, params, at) {
  clocks[i] = at;
  doms[i].window.dispatchEvent(new doms[i].window.MessageEvent('message', { source:null, data:{ type:'mcp-notification',hostId:'local',method,params } }));
}
function sample(i, text, durationMs, itemId='sample') {
  const threadId = ids[i], firstText = 'Hello ';
  emit(i, 'item/started', { threadId,turnId:turn,startedAtMs:Date.now()+1,item:{ id:itemId,type:'agentMessage',text:'' } }, 0);
  emit(i, 'item/agentMessage/delta', { threadId,turnId:turn,itemId,delta:firstText }, 10);
  emit(i, 'item/agentMessage/delta', { threadId,turnId:turn,itemId,delta:text.slice(firstText.length) }, 10+durationMs);
  emit(i, 'item/completed', { threadId,turnId:turn,completedAtMs:Date.now()+2,item:{ id:itemId,type:'agentMessage',text } }, 5000+durationMs);
  const tokens = countVisibleTokens(text,firstText,{encode,tokenByteLength});
  return `≈${Math.round(tokens/(durationMs/1000)).toLocaleString('en-US')} tok/s`;
}
try {
  await waitFor(() => label(0) === '— tok/s');
  const expectedA = sample(0,'Hello world, this is the first observed text.',1000);
  await waitFor(() => label(0) === expectedA);
  assert.notEqual(label(0),'≈112 tok/s','legacy backend turn speed must never leak into visible speed');
  count = 3;
  await waitFor(() => label(1) === '— tok/s' && label(2) === '— tok/s');
  const expectedB = sample(1,'Hello this is a much longer second text with independently observed timing.',2000);
  const expectedSameThread = sample(2,'Hello separate window on the same conversation.',4000);
  await waitFor(() => label(1) === expectedB && label(2) === expectedSameThread);
  assert.equal(label(0),expectedA,'same-thread popout must not overwrite the first window');
  assert.notEqual(expectedA,expectedSameThread);
  for(let i=0;i<3;i++) {
    assert.equal(doms[i].window.__CODEX_INLINE_STATUS__.inspect().bindings[0].labels[1],'缓存命中 95.0%');
    const tooltip=doms[i].window.document.querySelector('[data-codex-inline-status]').shadowRoot.querySelector('[data-metric="speed"]').title;
    assert.match(tooltip,/可见文本流式速度/);
  }
  // Broadcast from a different conversation must not become a local sample.
  emit(0,'item/started',{threadId:B,turnId:turn,startedAtMs:Date.now()+1,item:{id:'foreign',type:'agentMessage',text:''}},20000);
  assert.equal(doms[0].window.__CODEX_VISIBLE_STREAM__.snapshot(B).items.length,0);
  // Route back to an already measured conversation: show its own saved result
  // synchronously, before the coordinator's next one-second polling cycle.
  ids[0]=B;
  doms[0].window.document.querySelector('[data-thread-id]').setAttribute('data-thread-id',B);
  doms[0].window.__CODEX_INLINE_STATUS__.discover();
  const bInFirst=sample(0,'Hello a fresh second conversation in this same window.',3000,'route-b');
  await waitFor(()=>label(0)===bInFirst);
  ids[0]=A;
  doms[0].window.document.querySelector('[data-thread-id]').setAttribute('data-thread-id',A);
  doms[0].window.__CODEX_INLINE_STATUS__.discover();
  assert.equal(label(0),expectedA,'cached A appears immediately, without waiting for a new poll');
  assert.equal(doms[0].window.__CODEX_INLINE_STATUS__.inspect().bindings[0].cached,true);
  assert.equal(label(1),expectedB);
  assert.equal(label(2),expectedSameThread);
  count = 0;
  const timer=setTimeout(()=>child.kill(),16000);
  assert.equal(await exited,0,stderr); clearTimeout(timer);
  for(const dom of doms) {
    assert.equal(dom.window.__CODEX_VISIBLE_STREAM__,undefined);
    assert.equal(dom.window.document.querySelectorAll('[data-codex-inline-status]').length,0);
  }
  console.log('PASS: existing/new windows, same-thread window independence, tokenizer, background refresh, immediate cached switch, cleanup.');
} finally {
  if(child.exitCode === null) child.kill();
  for(const socket of wss.clients) socket.terminate();
  wss.close(); server.close(); for(const dom of doms) dom.window.close();
}
