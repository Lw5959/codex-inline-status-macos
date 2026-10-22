// 临时安装完整源码，接入合成 CDP 页面并启动真实 Python 后台；不使用本机聊天数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { WebSocketServer } = require('ws');
const source = fileURLToPath(new URL('../', import.meta.url));

test('macOS installation, real worker, duplicate launch and owned cleanup', { skip: process.platform !== 'darwin', timeout: 45000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-status-flow-'));
  const root = path.join(temp, 'Installed Status');
  const launcher = path.join(temp, 'Launcher.app');
  const app = path.join(temp, 'Official.app');
  const codex = path.join(temp, 'synthetic-codex');
  await fs.mkdir(codex);
  await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await fs.writeFile(path.join(app, 'Contents/MacOS/Test'), '');
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleExecutable</key><string>Test</string></dict></plist>');
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const barSource = await fs.readFile(path.join(source, 'src/native_statusbar.js'), 'utf8');
  const streamSource = await fs.readFile(path.join(source, 'src/visible_stream_observer.js'), 'utf8');
  const injections = { bar: 0, stream: 0, checks: 0 };
  const dom = new JSDOM(`<section data-thread-id="${id}"><div data-testid="composer"><textarea></textarea><button>发送</button></div></section>`, { runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x:0,y:0,width:600,height:100,left:0,top:0,right:600,bottom:100 });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ id:'synthetic',type:'page',url:'app://-/index.html',webSocketDebuggerUrl:`ws://127.0.0.1:${server.address().port}/page` }]));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    try {
      if (message.method === 'Runtime.evaluate') {
        if (message.params.expression === barSource) injections.bar++;
        if (message.params.expression === streamSource) injections.stream++;
        if (message.params.expression.startsWith('({ stream:')) injections.checks++;
      }
      const value = message.method === 'Runtime.evaluate' ? dom.window.eval(message.params.expression) : undefined;
      socket.send(JSON.stringify({ id:message.id,result:message.method === 'Runtime.evaluate' ? {result:{value}} : {} }));
    } catch { socket.send(JSON.stringify({ id:message.id,error:{code:-1} })); }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = String(server.address().port);
  const env = { ...process.env, CODEX_HOME: codex };
  const cli = (action, extra=[]) => exec('python3', [path.join(root, 'macos/manage.py'), action, '--install-root', root, '--port', port, ...extra], {env,timeout:25000});
  try {
    await exec('python3', [path.join(source, 'macos/legacy/manage.py'), 'install', '--install-root', root, '--launcher', launcher, '--app', app, '--node', process.execPath], {env,timeout:25000});
    // 通过安装后的入口启动，验证源码位置和真实私有 Python 导入链。
    const first = await cli('launch', ['--attach-only']);
    assert.match(first.stdout, /已核实状态条显示/);
    const runtime1 = JSON.parse(await fs.readFile(path.join(root,'var/runtime.json')));
    const health = JSON.parse(await fs.readFile(path.join(root,'var/health.json')));
    assert.ok(health.backendPid > 0);
    assert.equal(health.backendRestarts, 0);
    assert.equal(health.bindingCount, 1);
    assert.equal(health.status, 'attached-partial-data');
    assert.deepEqual(Array.from(dom.window.__CODEX_INLINE_STATUS__.inspect().bindings[0].labels), ['— tok/s', '缓存命中 —']);
    await cli('launch', ['--attach-only']);
    const runtime2 = JSON.parse(await fs.readFile(path.join(root,'var/runtime.json')));
    assert.equal(runtime1.pid, runtime2.pid, '重复启动必须复用当前后台');
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail('监视器未在限定时间内恢复页面组件');
    };
    await waitFor(() => injections.checks >= 2);
    assert.equal(injections.bar, 1, '持续轮询不应重新发送完整状态条脚本');
    assert.equal(injections.stream, 1, '持续轮询不应重新发送完整观察器脚本');
    const observerId = dom.window.__CODEX_VISIBLE_STREAM__.snapshot(id).observerId;
    dom.window.__CODEX_INLINE_STATUS__.destroy();
    await waitFor(() => injections.bar === 2 && !!dom.window.__CODEX_INLINE_STATUS__);
    assert.equal(dom.window.__CODEX_VISIBLE_STREAM__.snapshot(id).observerId, observerId, '单独恢复状态条不能重置正文计时');
    // 同一个调试 target 重载后，两个组件都消失；下一轮必须自动恢复。
    dom.window.__CODEX_INLINE_STATUS__.destroy(); dom.window.__CODEX_VISIBLE_STREAM__.destroy();
    await waitFor(() => injections.bar === 3 && injections.stream === 2 && !!dom.window.__CODEX_INLINE_STATUS__);
    assert.equal(dom.window.document.querySelectorAll('[data-codex-inline-status]').length, 1);
    await cli('stop');
    assert.equal(dom.window.document.querySelectorAll('[data-codex-inline-status]').length, 0);
    const final = JSON.parse(await fs.readFile(path.join(root,'var/health.json')));
    assert.equal(final.running, false);
    assert.equal(final.cleanupUnconfirmed, 0);
    // 更新流程备份原代码，保留安装环境。
    await exec('python3', [path.join(source,'macos/legacy/manage.py'),'install','--install-root',root,'--launcher',launcher,'--app',app,'--node',process.execPath], {env,timeout:25000});
    assert.ok((await fs.readdir(path.join(root,'backups'))).length > 0);
  } finally {
    await cli('stop').catch(() => {});
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    dom.window.close();
    await fs.rm(temp,{recursive:true,force:true});
  }
});
