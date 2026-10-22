// Node 仅运行开发期对照测试；发布 App 不包含、不调用 Node。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {encode,tokenByteLength} from '../src/visible_tokenizer.mjs';
import {countVisibleTokens,VisibleStreamMeter} from '../src/visible_stream_meter.mjs';
const exec=promisify(execFile);
const base=fileURLToPath(new URL('../',import.meta.url));
const app=path.join(base,'release/GPT Launcher.app');
const binary=path.join(app,'Contents/MacOS/GPTLauncher');
const engine=path.join(app,'Contents/Resources/engine');
await fs.access(binary); // 构建必须先完成；缺少产物时立即失败，避免残留测试服务器。
const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
const {WebSocketServer}=require('ws');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',TURN='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function request(value){
 const child=spawn(binary,['--native-test','--engine',engine],{stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{try{resolve({code,...JSON.parse(stdout)})}catch{reject(Error(stderr+stdout))}})});
 child.stdin.end(JSON.stringify(value));return result;
}
async function service(action,root,extra=[]){
 // 干净的 CI runner 没有官方 App；准备过程使用独立、可执行但绝不启动的应用夹具。
 // 不再让发布回归隐式依赖开发机恰好安装了 ChatGPT。
 if(action==='prepare'){
  const fixtureApp=path.join(root,'OfficialFixture.app'),contents=path.join(fixtureApp,'Contents');
  await fs.mkdir(path.join(contents,'MacOS'),{recursive:true});
  await fs.writeFile(path.join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>');
  await fs.writeFile(path.join(contents,'MacOS/Fixture'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  await fs.writeFile(path.join(root,'macos-config.json'),JSON.stringify({app:fixtureApp}),{flag:'wx'});
 }
 const result=await exec(binary,['--service',action,'--root',root,...extra],{timeout:65000}).catch(e=>e);
 assert.ok(result.stdout,'native service returned no JSON');return JSON.parse(result.stdout);
}
async function waitFor(predicate){for(let n=0;n<150;n++){try{if(await predicate())return}catch{}await new Promise(r=>setTimeout(r,100))}throw Error('native fixture timed out')}
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-stats-'));
 await fs.mkdir(path.join(root,'sessions'));
 const records=id=>[{type:'session_meta',payload:{id}},{type:'event_msg',timestamp:'2026-10-19T01:00:00.000Z',payload:{type:'token_count',info:{last_token_usage:{input_tokens:1,cached_input_tokens:0},total_token_usage:{input_tokens:1000,cached_input_tokens:id===A?950:400}}}}];
 for(const id of [A,B])await fs.writeFile(path.join(root,'sessions',id+'.jsonl'),records(id).map(x=>JSON.stringify(x)).join('\n')+'\n');
 const sql="CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT);"+[A,B].map(id=>`INSERT INTO threads VALUES('${id}','${path.join(root,'sessions',id+'.jsonl').replaceAll("'","''")}');`).join('');
 await exec('/usr/bin/sqlite3',[path.join(root,'state_5.sqlite'),sql]);return root;
}

test('JavaScriptCore tokenizer and UTF-8 boundaries match the original implementation',async()=>{
 for(const text of ['Hello world','中文与 emoji 👋🚲 test','café\nΔ 日本語','']){
  const result=await request({action:'encode',text});assert.equal(result.ok,true);assert.deepEqual(result.value,encode(text));
 }
 for(const [text,firstText] of [['Hello world','Hello '],['你好👋 world','你好\ud83d'],['👋🚲世界','👋'],['a','a']]){
  const raw=JSON.stringify({action:'count',text,firstText});
  const result=await request({action:'raw',requestJSON:raw});assert.equal(result.ok,true);assert.equal(result.value,countVisibleTokens(text,firstText,{encode,tokenByteLength}));
 }
});

test('native meter preserves observer and same-thread window isolation',async()=>{
 const snapshot=(observerId,text,durationMs,revision=1)=>({observerId,revision,items:[{turnId:TURN,itemId:'item',text,firstText:'Hello ',deltaCount:2,durationMs,state:'completed',revision}]});
 const events=[{session:'one',thread:A,snapshot:snapshot('obs1','Hello first window',1000)},{session:'two',thread:A,snapshot:snapshot('obs2','Hello second window',4000)},{session:'one',thread:A,snapshot:snapshot('obs1','Hello first window',1000)},{session:'one',thread:A,snapshot:{observerId:'obs-new',revision:0,items:[]}}];
 const meters=new Map();const expected=events.map(x=>{if(!meters.has(x.session))meters.set(x.session,new VisibleStreamMeter({encode,tokenByteLength}));return meters.get(x.session).update(x.thread,x.snapshot)});
 const native=await request({action:'sequence',events});assert.equal(native.ok,true);
 native.value.forEach((x,i)=>{for(const key of ['tps','tokens','seconds','state','measured_samples'])assert.deepEqual(x[key],expected[i][key],key)});
});

test('native conversation history survives reopen, isolates UUIDs, avoids unchanged writes and revokes invalid samples',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-history-'));
 const key=JSON.stringify([TURN,'item']);
 const completed={nativeObserverId:'verified-observer',state:'completed',tps:12,tokens:24,seconds:2,confirmed_key:key,
  confirmed:{tps:12,tokens:24,seconds:2,measured_samples:1},invalidated_keys:[]};
 const empty={nativeObserverId:'new-observer',state:'noData',tps:null,confirmed:{tps:null,measured_samples:0},invalidated_keys:[]};
 const history=(events,location=root)=>request({action:'history',root:location,events});
 const event=(stream=empty,cache={issue:'catching_up',cache_hit:null},thread=A)=>({thread,stream,cache});
 try{
  const first=(await history([event(completed,{issue:null,cache_hit:.95})])).value[0];assert.equal(first.tps,12);assert.equal(first.speed_persisted,undefined);
  const file=path.join(root,'var/conversations',A+'.json'),saved=JSON.parse(await fs.readFile(file));
  assert.equal(saved.threadID,A);assert.equal(saved.speed.tps,12);assert.equal(saved.cache.ratio,.95);
  assert.doesNotMatch(JSON.stringify(saved),/firstText|textHash|textLength|nativeObserverId|auth|Bearer/);
  assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
  const modified=(await fs.stat(file)).mtimeMs;
  await history([event(completed,{issue:null,cache_hit:.95})]);assert.equal((await fs.stat(file)).mtimeMs,modified,'未变化的数据不能每次轮询都写盘');
  const [restored,foreign]=(await history([event(),event(empty,{issue:'catching_up',cache_hit:null},B)])).value;
  assert.equal(restored.tps,12);assert.equal(restored.speed_persisted,true);assert.equal(restored.cache_hit,.95);assert.equal(restored.cache_persisted,true);assert.equal(restored.state,'saved');
  assert.equal(foreign.tps,null);assert.equal(foreign.cache_hit,null);
  await history([event({...empty,state:'provisional',tps:999,tokens:999,seconds:1},{issue:null,cache_hit:.96})]);
  assert.equal(JSON.parse(await fs.readFile(file)).speed.tps,12,'未完成正文不能覆盖已确认速度');
  const revoked=(await history([event({...empty,nativeObserverId:'verified-observer',invalidated_keys:[key]}),{...event(),reopen:true}])).value;
  assert.equal(revoked[0].tps,null);assert.equal(revoked[1].tps,null);assert.equal(JSON.parse(await fs.readFile(file)).speed,undefined);
  await fs.writeFile(file,JSON.stringify({...saved,threadID:B}));assert.equal((await history([event()])).value[0].tps,null,'文件名相同也不能读取另一会话的数据');
  await fs.writeFile(file,'{broken');assert.equal((await history([event()])).value[0].persistence_issue,'history_unavailable');
  const blocked=path.join(root,'blocked');await fs.mkdir(blocked);await fs.writeFile(path.join(blocked,'var'),'blocking file');
  const failed=(await history([event(completed,{issue:null,cache_hit:.95})],blocked)).value[0];assert.equal(failed.tps,12);assert.equal(failed.persistence_issue,'history_write_failed');
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('US policy rejects Canada, Mexico, non-US timezones, unknown country and cached flags',async()=>{
 for(const timezone of ['America/New_York','America/Los_Angeles','America/Anchorage','Pacific/Honolulu'])assert.equal((await request({action:'gate',country_code:'US',timezone})).ok,true);
 for(const value of [{country_code:'CA',timezone:'America/Toronto'},{country_code:'MX',timezone:'America/Mexico_City'},{country_code:'US',timezone:'Asia/Tokyo'},{country_code:'JP',timezone:'America/New_York'},{country_code:'',timezone:'America/New_York'},{allowed:true,timezone:'America/New_York'}]){
  const result=await request({action:'gate',...value});assert.equal(result.ok,false);assert.match(result.message,/禁止/);
 }
});

test('native SQLite reads cumulative cache counters and rejects inherited or foreign paths',async()=>{
 const root=await fixture();
 try{
  assert.equal((await request({action:'metrics',codexRoot:root,thread:A})).value.cache_hit,.95);
  assert.equal((await request({action:'metrics',codexRoot:root,thread:B})).value.cache_hit,.4);
  const file=path.join(root,'sessions',A+'.jsonl');
  await fs.appendFile(file,JSON.stringify({type:'session_meta',payload:{id:B}})+'\n');
  const inherited=(await request({action:'metrics',codexRoot:root,thread:A})).value;
  assert.equal(inherited.cache_hit,null);assert.equal(inherited.issue,'inherited_history');
  await exec('/usr/bin/sqlite3',[path.join(root,'state_5.sqlite'),`UPDATE threads SET rollout_path='/tmp/outside.jsonl' WHERE id='${B}'`]);
  assert.equal((await request({action:'metrics',codexRoot:root,thread:B})).value.issue,'source_unavailable');
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('native broker forwards opaque bytes, authenticates control and blocks local destinations',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-broker-'));
 const upstream=net.createServer(socket=>{let header=Buffer.alloc(0);let connected=false;socket.on('data',data=>{if(connected){socket.write(data);return}header=Buffer.concat([header,data]);const end=header.indexOf('\r\n\r\n');if(end<0)return;assert.match(header.toString(),/^CONNECT chatgpt.com:443/);connected=true;socket.write('HTTP/1.1 200 Connection established\r\n\r\n');if(header.length>end+4)socket.write(header.subarray(end+4))})});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const state=path.join(root,'broker.json');await fs.writeFile(state,JSON.stringify({runId:'test',token:'secret',upstream:`http://127.0.0.1:${upstream.address().port}`}));
 const child=spawn(binary,['--broker','--state',state,'--run-id','test'],{stdio:'ignore'});
 const exited=new Promise(r=>child.once('exit',r));let record;
 try{
  await waitFor(async()=>{record=JSON.parse(await fs.readFile(state));return record.port>0});
  const client=net.connect(record.port,'127.0.0.1');const payload=Buffer.from([22,3,3,0,8,1,2,3,4,5,6,7,8]);
  let data=Buffer.alloc(0);client.on('data',chunk=>data=Buffer.concat([data,chunk]));
  client.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n');
  await waitFor(()=>data.includes(Buffer.from('\r\n\r\n')));data=Buffer.alloc(0);client.write(payload);await waitFor(()=>data.length>=payload.length);assert.deepEqual(data,payload);client.destroy();
  const denied=await fetch(`http://127.0.0.1:${record.port}/health`,{method:'POST'});assert.equal(denied.status,403);
  assert.equal((await request({action:'allowed',host:'127.0.0.1',port:443})).value,false);
  const stopped=await fetch(`http://127.0.0.1:${record.port}/shutdown`,{method:'POST',headers:{Authorization:'Bearer secret'}});assert.equal(stopped.status,200);await exited;
 }finally{child.kill('SIGTERM');await exited;await new Promise(r=>upstream.close(r));await fs.rm(root,{recursive:true,force:true})}
});

test('US-only save rejects manual override and new native root has no runtime dependency',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-service-'));
 try{
  assert.equal((await service('prepare',root)).ok,true);
  const config=JSON.parse(await fs.readFile(path.join(root,'macos-config.json')));assert.equal(config.node,undefined);assert.equal(config.python,undefined);
  await assert.rejects(fs.stat(path.join(root,'runtime')));
  const bad=await service('save',root,['--settings-json',JSON.stringify({mode:'manual',timezone:'America/Toronto',upstream:'system',port:9335})]);assert.equal(bad.ok,false);assert.match(bad.message,/仅允许美国/);
  const good=await service('save',root,['--settings-json',JSON.stringify({mode:'manual',timezone:'Pacific/Honolulu',upstream:'system',port:9335})]);assert.equal(good.ok,true);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('upgrades reuse an owned live channel and verify actual renderer timezone without restarting the app',{timeout:30000},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-upgrade-'));
 const children=[];let traces=0,shutdowns=0,timezoneReads=0,actualZone='America/New_York';
 let region={country_code:'US',timezone:'America/New_York',allowed:true};
 const broker=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');
  if(req.url==='/health')res.end(JSON.stringify({running:true,activeConnections:4}));
  else if(req.url==='/trace'){traces++;res.end(JSON.stringify({...region,checkedAt:Date.now()/1000}))}
  else{shutdowns++;res.end('{}')}
 });
 const cdp=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{id:'timezone',type:'page',url:'app://-/index.html',webSocketDebuggerUrl:`ws://127.0.0.1:${cdp.address().port}/timezone`}]))});
 const sockets=new WebSocketServer({server:cdp});
 sockets.on('connection',socket=>socket.on('message',raw=>{const m=JSON.parse(String(raw));
  assert.equal(m.method,'Runtime.evaluate');assert.equal(m.params.expression,'Intl.DateTimeFormat().resolvedOptions().timeZone');timezoneReads++;
  socket.send(JSON.stringify({id:m.id,result:{result:{value:actualZone}}}));
 }));
 await new Promise(r=>broker.listen(0,'127.0.0.1',r));await new Promise(r=>cdp.listen(0,'127.0.0.1',r));
 const start=(file,args=[])=>{const child=spawn(file,args,{stdio:'ignore'});children.push(child);return child};
 try{
  assert.equal((await service('prepare',root)).ok,true);
  // 原生休眠进程只提供可复核的 PID/命令；HTTP/CDP 由夹具提供，绝不接触真实 ChatGPT。
  const fixtureSource=path.join(root,'sleep.c');await fs.writeFile(fixtureSource,'#include <unistd.h>\nint main(){for(;;)pause();}\n');
  const sleeping=path.join(root,'sleep');await exec('/usr/bin/clang',[fixtureSource,'-o',sleeping]);
  const helper=path.join(root,'native/GPTLauncher');await fs.copyFile(sleeping,helper);
  const fake=path.join(root,'Test.app/Contents');await fs.mkdir(path.join(fake,'MacOS'),{recursive:true});
  await fs.writeFile(path.join(fake,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleExecutable</key><string>Test</string></dict></plist>');
  const appBinary=path.join(fake,'MacOS/Test');await fs.copyFile(sleeping,appBinary);
  const config=JSON.parse(await fs.readFile(path.join(root,'macos-config.json')));config.app=path.dirname(fake);await fs.writeFile(path.join(root,'macos-config.json'),JSON.stringify(config));
  await service('save',root,['--settings-json',JSON.stringify({mode:'automatic',timezone:'America/New_York',upstream:'direct',port:cdp.address().port})]);
  const state=path.join(root,'var/broker.json');const channel=start(helper,['--broker','--state',state,'--run-id','legacy-broker']);
  const appChild=start(appBinary,[`--proxy-server=http://127.0.0.1:${broker.address().port}`,`--remote-debugging-port=${cdp.address().port}`]);
  await fs.writeFile(state,JSON.stringify({pid:channel.pid,runId:'legacy-broker',port:broker.address().port,token:'fixture',upstream:'',codeHash:'legacy-native-executable'}));
  const launchFile=path.join(root,'var/desktop-launch.json');const launch={appPid:appChild.pid,brokerPort:broker.address().port,timezone:'America/New_York',nativeVersion:'2.1.0'};
  await fs.writeFile(launchFile,JSON.stringify(launch));
  const args=[helper,'--monitor','--root',root,'--port',String(cdp.address().port),'--report',path.join(root,'var/health.json'),'--codex-root',root,'--run-id','existing-monitor'];
  const monitor=start(helper,args.slice(1));
  const digest=createHash('sha256');digest.update(createHash('sha256').update(await fs.readFile(helper)).digest('hex'));
  for(const name of ['native_statusbar.js','visible_stream_observer.js','native_meter.js'])digest.update(await fs.readFile(path.join(root,name)));
  await fs.writeFile(path.join(root,'var/runtime.json'),JSON.stringify({pid:monitor.pid,port:cdp.address().port,runId:'existing-monitor',command:args,fingerprint:digest.digest('hex')}));
  await fs.writeFile(path.join(root,'var/health.json'),JSON.stringify({runId:'existing-monitor',checkedAt:new Date().toISOString(),running:true,bindingCount:1,status:'attached'}));
  const first=await service('attach',root);assert.equal(first.ok,true,first.message);assert.match(first.message,/已连接/);
  const second=await service('attach',root);assert.equal(second.ok,true,second.message);
  assert.equal(traces,2,'升级和重复接入仍需各自重新检测');assert.equal(timezoneReads,2);assert.equal(shutdowns,0);
  assert.equal(appChild.exitCode,null);assert.equal(channel.exitCode,null);assert.equal(monitor.exitCode,null);
  assert.equal(JSON.parse(await fs.readFile(launchFile)).nativeVersion,'2.1.0','不伪造原始启动版本来绕过校验');
  actualZone='Asia/Tokyo';const wrongZone=await service('attach',root);assert.equal(wrongZone.ok,false);assert.match(wrongZone.message,/运行时区/);
  actualZone='America/New_York';region={country_code:'CA',timezone:'America/Toronto',allowed:false};
  const nonUS=await service('attach',root);assert.equal(nonUS.ok,false);assert.match(nonUS.message,/非美国.*禁止/);
  assert.equal(appChild.exitCode,null);assert.equal(shutdowns,0);
  await fs.writeFile(launchFile,JSON.stringify({...launch,appPid:process.pid}));
  const foreign=await service('attach',root);assert.equal(foreign.ok,false);assert.match(foreign.message,/未使用可核实/);
 }finally{
  for(const child of children){child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r))}
  for(const socket of sockets.clients)socket.terminate();await new Promise(r=>sockets.close(r));
  await new Promise(r=>broker.close(r));await new Promise(r=>cdp.close(r));await fs.rm(root,{recursive:true,force:true});
 }
});

test('service blocks non-US detection, manual-zone bypass, cached-US bypass and unknown results',{timeout:15000},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-region-gate-'));
 let response={ip:'1.1.1.1',country_code:'CA',timezone:'America/Toronto',allowed:false,checkedAt:Date.now()/1000};let traces=0;
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/health')res.end(JSON.stringify({running:true,activeConnections:0}));else if(req.url==='/trace'){traces++;res.end(JSON.stringify(response))}else res.end('{}')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  assert.equal((await service('prepare',root)).ok,true);
  const fake=path.join(root,'Test.app/Contents');await fs.mkdir(path.join(fake,'MacOS'),{recursive:true});
  await fs.writeFile(path.join(fake,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleExecutable</key><string>Test</string></dict></plist>');
  const marker=path.join(root,'unexpected-launch');await fs.writeFile(path.join(fake,'MacOS/Test'),`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});
  const config=JSON.parse(await fs.readFile(path.join(root,'macos-config.json')));config.app=path.dirname(fake);await fs.writeFile(path.join(root,'macos-config.json'),JSON.stringify(config));
  await service('save',root,['--settings-json',JSON.stringify({mode:'manual',timezone:'America/New_York',upstream:'direct',port:9335})]);
  const codeHash=createHash('sha256').update(await fs.readFile(path.join(root,'native/GPTLauncher'))).digest('hex');
  await fs.writeFile(path.join(root,'var/broker.json'),JSON.stringify({port:server.address().port,token:'fixture',upstream:'',codeHash}));
  const detected=await service('detect',root);assert.equal(detected.ok,false);assert.match(detected.message,/非美国.*禁止/);assert.equal(detected.status.detection.allowed,false);
  const manual=await service('launch',root);assert.equal(manual.ok,false);assert.match(manual.message,/非美国/);
  await fs.writeFile(path.join(root,'var/last-detection.json'),JSON.stringify({ip:'8.8.8.8',country_code:'US',timezone:'America/New_York',allowed:true,checkedAt:Date.now()/1000}));
  const cached=await service('launch-cached',root);assert.equal(cached.ok,false);assert.match(cached.message,/非美国/);assert.ok(traces>=3,'必须重新取证，不能复用旧美国结论');
  response={error:'无法核实 GPT 出口，禁止启动。'};
  const unknown=await service('launch',root);assert.equal(unknown.ok,false);assert.equal(unknown.status.detection.allowed,false);
  await assert.rejects(fs.stat(marker),'禁止条件下不能调用应用启动入口');
  response={ip:'8.8.8.8',country_code:'US',timezone:'America/New_York',allowed:true,checkedAt:Date.now()/1000};
  assert.equal((await service('detect',root)).ok,true,'恢复到美国出口后可以重新核实');
 }finally{await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true})}
});

test('native CDP coordinator displays live speed, cache, new windows and removes its DOM on stop',{timeout:90000},async t=>{
 const root=await fixture();const ids=[A,B,A],clocks=[0,0,0];let count=1,discoveryWorks=true,evaluations=0,notifications=0;
 const doms=ids.map((id,index)=>{const dom=new JSDOM(`<section data-thread-id="${id}"><div data-testid="composer"><textarea></textarea><button>发送</button></div></section>`,{runScripts:'outside-only'});dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:600,height:100,left:0,top:0,right:600,bottom:100});Object.defineProperty(dom.window.performance,'now',{value:()=>clocks[index]});return dom});
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(discoveryWorks?JSON.stringify(doms.slice(0,count).map((_,i)=>({id:String(i),type:'page',url:'app://-/index.html',webSocketDebuggerUrl:`ws://127.0.0.1:${server.address().port}/${i}`}))):'{bad')});
 const sockets=new WebSocketServer({server});sockets.on('connection',(socket,req)=>socket.on('message',raw=>{const m=JSON.parse(String(raw)),window=doms[Number(req.url.slice(1))].window;try{
  if(m.method==='Runtime.addBinding')window[m.params.name]=payload=>{if(socket.readyState===1){notifications++;socket.send(JSON.stringify({method:'Runtime.bindingCalled',params:{name:m.params.name,payload}}))}};
  if(m.method==='Runtime.evaluate')evaluations++;
  const value=m.method==='Runtime.evaluate'?window.eval(m.params.expression):undefined;socket.send(JSON.stringify({id:m.id,result:m.method==='Runtime.evaluate'?{result:{value}}:{}}))}catch{socket.send(JSON.stringify({id:m.id,error:{code:-1}}))}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 // 每个原生监控夹具使用独立可写安装目录，不能把会话文件写进发布 App 的 engine。
 const installed=path.join(root,'engine');await fs.cp(engine,installed,{recursive:true});
 const report=path.join(root,'health.json');let child,exited,error='';
 const start=()=>{child=spawn(binary,['--monitor','--root',installed,'--port',String(server.address().port),'--report',report,'--codex-root',root,'--run-id','fixture'],{stdio:['ignore','pipe','pipe']});child.stderr.on('data',x=>error+=x);exited=new Promise(r=>child.once('exit',r))};start();
 const label=i=>doms[i].window.__CODEX_INLINE_STATUS__?.inspect({refresh:false,geometry:false}).bindings[0]?.labels[0];
 function sample(i,text,duration){const first='Hello ';const emit=(method,params,t)=>{clocks[i]=t;doms[i].window.dispatchEvent(new doms[i].window.MessageEvent('message',{source:null,data:{type:'mcp-notification',hostId:'local',method,params}}))};const common={threadId:ids[i],turnId:TURN};emit('item/started',{...common,startedAtMs:Date.now()+2,item:{id:'message',type:'agentMessage',text:''}},0);emit('item/agentMessage/delta',{...common,itemId:'message',delta:first},10);emit('item/agentMessage/delta',{...common,itemId:'message',delta:text.slice(first.length)},10+duration);emit('item/completed',{...common,completedAtMs:Date.now()+3,item:{id:'message',type:'agentMessage',text}},20+duration);emit('turn/completed',{threadId:ids[i],turn:{id:TURN}},21+duration);return `${Math.round(countVisibleTokens(text,first,{encode,tokenByteLength})/(duration/1000)).toLocaleString('en-US')} tok/s`}
 try{
  await waitFor(()=>label(0)==='— tok/s');
  // 挂载占位符早于首次完整刷新；先确认后台完成首轮，避免把首次取数误判成突破 5 秒间隔。
  await waitFor(async()=>JSON.parse(await fs.readFile(report)).bindingCount===1);
  const started=performance.now();const expected=sample(0,'Hello visible text from the native coordinator.',1000);
  await new Promise(r=>setTimeout(r,1000));assert.equal(label(0),'— tok/s','通知不能绕过 5 秒更新间隔');await waitFor(()=>label(0)===expected);
  const completedLatency=performance.now()-started;assert.ok(completedLatency>=4000&&completedLatency<6500,'完成通知也应遵循约 5 秒刷新');assert.ok(notifications>0,'必须实际走 CDP binding 事件');
  const idleEvaluations=evaluations;await new Promise(r=>setTimeout(r,1000));const idleRequests=evaluations-idleEvaluations;assert.ok(idleRequests<=2,'空闲时禁止持续扫描页面');
  doms[0].window.__CODEX_VISIBLE_STREAM__.destroy();doms[0].window.__CODEX_INLINE_STATUS__.destroy();
  for(const socket of sockets.clients)socket.send(JSON.stringify({method:'Runtime.executionContextsCleared',params:{}}));
  await waitFor(()=>doms[0].window.__CODEX_INLINE_STATUS__?.inspect({refresh:false,geometry:false}).bindings[0]?.speedPersisted===true);
  assert.equal(label(0),expected,'renderer 重载恢复已确认的本会话读数');sample(0,'Hello visible text from the native coordinator.',1000);await waitFor(()=>doms[0].window.__CODEX_INLINE_STATUS__.inspect({refresh:false,geometry:false}).bindings[0].speedPersisted===false);
  assert.equal(doms[0].window.__CODEX_INLINE_STATUS__.inspect().bindings[0].labels[1],'缓存命中 95.0%');
  count=3;await waitFor(()=>label(1)==='— tok/s'&&doms[2].window.__CODEX_INLINE_STATUS__?.inspect({refresh:false,geometry:false}).bindings[0]?.speedPersisted===true);
  assert.equal(label(2),expected,'新窗口只恢复明确标注的本会话历史');
  const expected2=sample(2,'Hello separate window on the same native thread.',4000);await waitFor(()=>label(2)===expected2);assert.equal(label(0),expected,'共享的历史不能替换另一窗口已有的独立测速');
  assert.equal(doms[1].window.__CODEX_INLINE_STATUS__.inspect().bindings[0].labels[1],'缓存命中 40.0%');
  const emitLive=(method,params,at)=>{clocks[1]=at;doms[1].window.dispatchEvent(new doms[1].window.MessageEvent('message',{source:null,data:{type:'mcp-notification',hostId:'local',method,params:{threadId:B,turnId:TURN,...params}}}))};
  const text='Hello live output before completion.',first='Hello ';
  emitLive('item/started',{startedAtMs:Date.now()+2,item:{id:'live',type:'agentMessage',text:''}},0);
  emitLive('item/agentMessage/delta',{itemId:'live',delta:first},10);
  const liveStarted=performance.now();emitLive('item/agentMessage/delta',{itemId:'live',delta:text.slice(first.length)},1010);
  const expectedLive=`${countVisibleTokens(text,first,{encode,tokenByteLength})} tok/s`;
  await waitFor(()=>label(1)===expectedLive);const liveLatency=performance.now()-liveStarted;assert.ok(liveLatency<6500,'未完成消息在下一个 5 秒采样周期显示');
  const marker=doms[1].window.document.querySelector('[data-thread-id]');
  marker.setAttribute('data-thread-id',A);doms[1].window.__CODEX_INLINE_STATUS__.bindings();
  marker.setAttribute('data-thread-id',B);doms[1].window.__CODEX_INLINE_STATUS__.bindings();
  assert.equal(label(1),expectedLive,'切回立即恢复上次显示速度，不能等待下次 CDP 采样');
  assert.equal(doms[1].window.__CODEX_INLINE_STATUS__.inspect({refresh:false,geometry:false}).bindings[0].labels[1],'缓存命中 40.0%');
  clocks[1]=3510;await waitFor(()=>doms[1].window.__CODEX_INLINE_STATUS__.inspect({refresh:false,geometry:false}).bindings[0].updatedAtMs===3510);assert.equal(label(1),expectedLive,'暂停采样不能归零');
  emitLive('item/completed',{completedAtMs:Date.now()+3,item:{id:'live',type:'agentMessage',text}},3520);
  emitLive('turn/completed',{turn:{id:TURN}},3521);
  await waitFor(()=>label(1)===expectedLive);
  const waitingStarted=performance.now();
  emitLive('turn/started',{turnId:undefined,turn:{id:A}},3600);
  await waitFor(()=>doms[1].window.__CODEX_INLINE_STATUS__.inspect({refresh:false,geometry:false}).bindings[0].phase==='waiting');assert.equal(label(1),expectedLive,'新一轮无正文时保留本对话最近有效速度');
  assert.equal(doms[1].window.__CODEX_INLINE_STATUS__.inspect({refresh:false,geometry:false}).bindings[0].labels[1],'缓存命中 40.0%');
  assert.ok(performance.now()-waitingStarted<6500,'新一轮必须在下一次采样清除旧速度');
  t.diagnostic(JSON.stringify({completedLatencyMs:Math.round(completedLatency),liveLatencyMs:Math.round(liveLatency),idleEvaluateRequestsIn1Second:idleRequests}));
  discoveryWorks=false;await new Promise(r=>setTimeout(r,1300));assert.equal(label(0),expected);discoveryWorks=true;
  child.kill('SIGTERM');await exited;assert.equal(error,'');for(const dom of doms)assert.equal(dom.window.document.querySelectorAll('[data-codex-inline-status]').length,0);
  const health=JSON.parse(await fs.readFile(report));assert.equal(health.running,false);assert.equal(health.cleanupUnconfirmed,0);assert.equal(health.backend,'swift-sqlite-javascriptcore');
  const stored=JSON.parse(await fs.readFile(path.join(installed,'var/conversations',A+'.json')));assert.ok(stored.speed.tps>0);
  start();await waitFor(()=>doms[0].window.__CODEX_INLINE_STATUS__?.inspect({refresh:false,geometry:false}).bindings[0]?.speedPersisted===true);
  assert.equal(label(0),expected2,'后台进程完整重启后从磁盘恢复最新确认的本会话历史');
  assert.equal(doms[0].window.__CODEX_INLINE_STATUS__.inspect({refresh:false,geometry:false}).bindings[0].state,'saved');
  child.kill('SIGTERM');await exited;
 }finally{child.kill('SIGTERM');for(const socket of sockets.clients)socket.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>server.close(r));for(const dom of doms)dom.window.close();await fs.rm(root,{recursive:true,force:true})}
});
