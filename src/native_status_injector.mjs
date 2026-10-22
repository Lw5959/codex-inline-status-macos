import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { VisibleStreamMeter } from './visible_stream_meter.mjs';
import { encode, tokenByteLength } from './visible_tokenizer.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const port = Number(option('--port', 9335));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const once = args.includes('--once');
const remove = args.includes('--remove');
const reportPath = option('--report', null);
const runId = option('--run-id', `manual-${process.pid}`);
const screenshotPath = option('--screenshot', null);
// macOS 私有环境使用 bin/python3；Windows 保留原有路径，也允许启动器明确指定解释器。
const python = option('--python', path.join(root, 'TokenPulse', '.venv',
  ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3'])));
const script = await fs.readFile(path.join(root, 'native_statusbar.js'), 'utf8');
const streamScript = await fs.readFile(path.join(root, 'visible_stream_observer.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class Cdp {
  constructor(target) {
    this.target = target; this.pending = new Map(); this.serial = 0; this.closed = false;
    // Same conversation in separate windows has separate clocks and samples.
    this.visibleMeter = new VisibleStreamMeter({ encode, tokenByteLength });
  }
  async open() {
    const endpoint = new URL(this.target.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== port || endpoint.username || endpoint.password) throw new Error('CDP endpoint must remain local');
    this.socket = new WebSocket(endpoint.href);
    try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { this.socket.close(); } catch {} reject(new Error('CDP connection timed out')); }, 3000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    this.socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error('CDP command failed')); else waiter.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new Error('CDP closed')); }
      this.pending.clear();
    });
    await this.call('Runtime.enable');
    return this;
    } catch (error) {
      this.closed = true;
      try { this.socket.close(); } catch {}
      throw error;
    }
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); this.close(); reject(new Error('CDP command timed out')); }, 3500);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('CDP send failed')); }
    });
  }
  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error('Renderer evaluation failed');
    return response.result?.value;
  }
  close() { this.closed = true; try { this.socket?.close(); } catch {} }
}

class Metrics {
  constructor() {
    this.pending = new Map(); this.serial = 0; this.starts = 0;
    this.dead = true; this.closing = false; this.nextStart = 0;
    this.start();
  }
  start() {
    if (this.closing || this.starts >= 4 || Date.now() < this.nextStart) return;
    this.starts++; this.dead = false;
    const child = spawn(python, [path.join(root, 'native_status_backend.py')], {
      cwd: root, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      // 直接使用随包源码，不安装 TokenPulse GUI 或联网下载 Python 依赖。
      env: { ...process.env, PYTHONPATH: [path.join(root, 'TokenPulse', 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    });
    this.child = child;
    const failed = () => {
      if (this.child !== child || this.closing) return;
      this.dead = true; this.nextStart = Date.now() + 1000; this.fail();
    };
    child.on('error', failed);
    child.on('exit', failed);
    child.stdin.on('error', failed);
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id); clearTimeout(waiter.timer);
      waiter.resolve(message.metrics || { issue: message.error || 'metrics_unavailable' });
    });
  }
  fail() { for (const value of this.pending.values()) { clearTimeout(value.timer); value.resolve({ issue: 'metrics_unavailable' }); } this.pending.clear(); }
  get(thread) {
    if (this.dead) this.start();
    if (this.dead || this.closing) return Promise.resolve({ issue: 'metrics_unavailable' });
    return new Promise(resolve => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ issue: 'metrics_timeout' }); }, 5000);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(JSON.stringify({ id, thread_id: thread }) + '\n', error => { if (error) this.fail(); });
    });
  }
  close() { this.closing = true; this.child?.stdin.end(); this.child?.kill(); this.fail(); }
}

const sessions = new Map();
const metrics = remove ? null : new Metrics();
let stopping = false;
let cleanupUnconfirmed = 0;
async function destroySession(session) {
  try {
    if (session.closed) return false;
    await session.evaluate('window.__CODEX_VISIBLE_STREAM__?.destroy(); window.__CODEX_INLINE_STATUS__?.destroy()');
    return true;
  } catch { return false; }
}
async function destroyAll() {
  for (const session of sessions.values()) {
    if (!await destroySession(session)) cleanupUnconfirmed++;
    session.close();
  }
  sessions.clear(); metrics?.close();
}
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function isTarget(target) {
  // New primary/pop-out windows use initialRoute=/local/<thread>. The
  // renderer's exact composer UUID check decides whether a page has a target.
  try { const u = new URL(target.url); return target.type === 'page' && u.protocol === 'app:' && u.pathname === '/index.html'; } catch { return false; }
}

let lastSeen = Date.now();
let hadTarget = false;
let savedScreenshot = false;
let health = { runId, running: true, status: 'starting', rendererCount: 0 };
let healthWriteWarning = false;
async function writeHealth(value) {
  health = { ...value, runId, checkedAt: new Date().toISOString() };
  if (!reportPath) return true;
  // Reuse one temporary path per process, even across retries. Never unlink
  // the destination: readers must see either the old or the new complete JSON.
  const temporary = `${reportPath}.${process.pid}.tmp`;
  const retryable = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
  let failure = 'IO_ERROR';
  try {
    const encoded = JSON.stringify(health, null, 2);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.writeFile(temporary, encoded);
        await fs.rename(temporary, reportPath);
        if (healthWriteWarning) console.error('inline-status: health report writing recovered');
        healthWriteWarning = false;
        return true;
      } catch (error) {
        failure = retryable.has(error?.code) ? error.code : 'IO_ERROR';
        if (!retryable.has(error?.code) || attempt === 3) break;
        await sleep([25, 75, 150][attempt]);
      }
    }
  } catch {
    failure = 'IO_ERROR';
  } finally {
    // A failed report must not terminate monitoring or leave one temp per
    // attempt. Cleanup is best effort when Windows still holds a shared lock.
    try { await fs.unlink(temporary); } catch { }
  }
  if (!healthWriteWarning) {
    // Never log OS exception text: it can contain paths or serialized data.
    console.error(`inline-status: health report write failed (${failure}); monitoring continues`);
    healthWriteWarning = true;
  }
  return false;
}
try {
  while (!stopping) {
    let targets = [];
    let discoveryOk = false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      targets = (await response.json()).filter(isTarget);
      discoveryOk = true;
    } catch { }
    // A temporary failure of /json/list does not invalidate an open renderer
    // socket. Keep updating it and retain a way to remove our own DOM nodes.
    if (!discoveryOk) targets = [...sessions.values()].filter(session => !session.closed).map(session => session.target);
    if (targets.length) { lastSeen = Date.now(); hadTarget = true; }
    const live = new Set(targets.map(target => target.id));
    for (const [id, session] of sessions) {
      if ((discoveryOk && !live.has(id)) || session.closed) {
        if (!await destroySession(session)) cleanupUnconfirmed++;
        session.close(); sessions.delete(id);
      }
    }
    const verification = [];
    const cache = new Map();
    let removalFailures = 0;
    for (const target of targets) {
      try {
        let session = sessions.get(target.id);
        if (!session) { session = await new Cdp(target).open(); sessions.set(target.id, session); }
        if (remove) { await session.evaluate('window.__CODEX_VISIBLE_STREAM__?.destroy(); window.__CODEX_INLINE_STATUS__?.destroy()'); verification.push({ removed: true }); continue; }
        // 仅首次接入或页面重载后注入；持续发送整份脚本会重复解析并制造短期对象。
        // 每轮检查页面自身标识，避免同一 target 导航后漏装观察器或沿用旧计时。
        const runtime = await session.evaluate('({ stream: window.__CODEX_VISIBLE_STREAM__?.version === "1.2.0", bar: window.__CODEX_INLINE_STATUS__?.revision === "1.3.5-live.7" })');
        if (!runtime?.stream) await session.evaluate(streamScript);
        if (!runtime?.bar) await session.evaluate(script);
        const views = await session.evaluate('window.__CODEX_INLINE_STATUS__.discover()');
        for (const view of Array.isArray(views) ? views : []) {
          if (!uuid.test(view.threadId || '') || typeof view.key !== 'string') continue;
          if (!cache.has(view.threadId)) cache.set(view.threadId, await metrics.get(view.threadId));
          const snapshot = await session.evaluate(`window.__CODEX_VISIBLE_STREAM__.snapshot(${JSON.stringify(view.threadId)})`);
          const stream = session.visibleMeter.update(view.threadId, snapshot);
          const cached = cache.get(view.threadId);
          const combined = {
            ...cached, ...stream, issue: stream.issue || null, cache_issue: cached?.issue || null,
            scope: 'visible_text_client', measurement_method: 'visible_stream', observation_id: snapshot.observerId,
            measured_tokens: stream.tokens, measured_seconds: stream.seconds,
          };
          await session.evaluate(`window.__CODEX_INLINE_STATUS__.apply(${JSON.stringify({ key: view.key, metrics: combined })})`);
        }
        verification.push(await session.evaluate('window.__CODEX_INLINE_STATUS__.inspect({ refresh: false })'));
        if (screenshotPath && !savedScreenshot && views?.length) {
          const shot = await session.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          await fs.writeFile(screenshotPath, Buffer.from(shot.data, 'base64')); savedScreenshot = true;
        }
      } catch { if (remove) removalFailures++; verification.push({ issue: 'target_temporarily_unavailable' }); }
    }
    const count = verification.reduce((sum, view) => sum + (view?.count || 0), 0);
    const hasMetrics = verification.some(view => view?.bindings?.some(binding => binding.hasMetrics));
    const unavailable = verification.some(view => view?.issue || view?.bindings?.some(binding => binding.dataUnavailable));
    const status = !sessions.size ? 'waiting-for-app' : !count ? 'waiting-for-conversation' : metrics?.dead ? 'backend-unavailable' : unavailable ? 'attached-partial-data' : hasMetrics ? 'attached' : 'attached-no-data';
    const removalConfirmed = remove && discoveryOk && targets.length > 0 && removalFailures === 0;
    await writeHealth({ running: true, status: remove ? removalConfirmed ? 'removed' : 'removal-unconfirmed' : status, rendererCount: sessions.size, bindingCount: count, cleanupUnconfirmed, backendPid: metrics?.child?.pid || null, backendRestarts: Math.max(0, (metrics?.starts || 1) - 1), views: verification });
    if (once || remove) { if ((once && !remove && !count) || (remove && !removalConfirmed)) process.exitCode = 2; break; }
    // Exit with the app. This helper never reopens a deliberately closed app.
    if (Date.now() - lastSeen > (hadTarget ? 10000 : 180000)) break;
    await sleep(1000);
  }
} finally {
  if (once && !remove) { for (const session of sessions.values()) session.close(); metrics?.close(); }
  else await destroyAll();
  await writeHealth({ ...health, running: false, cleanupUnconfirmed, status: once || remove ? health.status : cleanupUnconfirmed ? 'stopped-cleanup-unconfirmed' : 'stopped' });
}
// 信号处理器接管了默认退出行为；清理与报告落盘后明确结束进程，避免调试
// 连接或 HTTP 保活句柄让已停止的后台长期驻留，并阻塞后续更新。
if (stopping) process.exit(process.exitCode || 0);
