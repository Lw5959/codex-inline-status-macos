import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(process.env.STATUSBAR_SOURCE||new URL('../src/native_statusbar.js',import.meta.url),'utf8');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rect=(left,top,width,height)=>({x:left,y:top,left,top,width,height,right:left+width,bottom:top+height});
const composer=()=>`<div class="ComposerLayoutRoot" data-testid="composer"><div class="ComposerLayoutBody" style="position:relative;z-index:10"><div class="ComposerLayoutFooter"><div class="AdaptiveFooterInput"><textarea data-codex-thread-reference-drop-target></textarea></div><div data-side="left"><button>+</button><button>完全访问</button></div><div data-side="right"><button>GPT-6.1 Sol Ultra</button><button>麦克风</button><button>语音</button></div></div></div></div>`;
function setup(t,threadId='') {
  const dom=new JSDOM(`<div data-codex-composer-root data-composer-placement="home"><div data-above-composer-portal data-above-composer-conversation-id="${threadId}"></div><div data-home-wrapper style="position:relative">${composer()}</div></div>`,{runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.getBoundingClientRect=function(){
    if(this.matches('[data-home-wrapper],[data-codex-composer-root]'))return rect(100,100,736,110);
    if(this.matches('[data-codex-inline-status]'))return rect(100+(parseFloat(this.style.left)||0),100+(parseFloat(this.style.top)||0),parseFloat(this.style.width)||250,26);
    if(this.matches('[data-testid="composer"],.ComposerLayoutBody'))return rect(100,100,736,110);
    if(this.matches('.ComposerLayoutFooter'))return rect(108,112,720,90);
    if(this.matches('.AdaptiveFooterInput'))return rect(108,112,720,48);
    if(this.matches('[data-side="left"]'))return rect(108,170,120,28);
    if(this.matches('[data-side="right"]'))return rect(238,170,590,28);
    if(this.tagName==='BUTTON'){
      const group=this.closest('[data-side]');
      const index=[...group.children].indexOf(this);
      if(group.dataset.side==='left')return rect(108+index*35,170,index?85:28,28);
      return [rect(614,170,140,28),rect(762,170,28,28),rect(800,170,28,28)][index];
    }
    return rect(108,112,300,48);
  };
  dom.window.eval(source);
  t.after(()=>{dom.window.__CODEX_INLINE_STATUS__?.destroy();dom.window.close();});
  return {dom,doc:dom.window.document,api:dom.window.__CODEX_INLINE_STATUS__};
}
test('new-chat draft stays inside its native card with the same 16px optical correction',t=>{
  const {doc,api}=setup(t);
  const host=doc.querySelector('[data-codex-inline-status]');
  assert.equal(api.discover()[0].threadId,null);
  assert.equal(host.parentElement,doc.querySelector('[data-home-wrapper]'));
  assert.equal(host.style.position,'absolute');
  assert.equal(doc.querySelector('[data-testid="composer"]').contains(host),false);
  const box=host.getBoundingClientRect();
  assert.equal((box.left+box.right)/2,100+736/2-16);
  assert.equal((box.top+box.bottom)/2,184);
  assert.ok(box.top>160&&box.bottom<=210);
  assert.ok(box.left>=236&&box.right<=606);
  assert.ok(Number(host.style.zIndex)>10);
  assert.equal(doc.querySelector('[data-side="right"] button').textContent,'GPT-6.1 Sol Ultra');
});
test('draft-to-real-thread transition preserves the same home host and measures only the bound conversation',t=>{
  const {doc,api}=setup(t);
  const host=doc.querySelector('[data-codex-inline-status]');
  doc.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id',A);
  const view=api.discover()[0];
  assert.equal(view.threadId,A);
  api.apply({key:view.key,metrics:{scope:'visible_text_client',measurement_method:'visible_stream',tps:123,cache_hit:.95}});
  assert.equal(doc.querySelector('[data-codex-inline-status]'),host);
  assert.equal(api.inspect().bindings[0].labels[0],'123 tok/s');
});
test('rebuilding a home composer retains its outside-React host and cleanup restores row styles',t=>{
  const {doc,api}=setup(t,A);
  const host=doc.querySelector('[data-codex-inline-status]');
  doc.querySelector('[data-testid="composer"]').outerHTML=composer();
  api.discover();
  assert.equal(doc.querySelector('[data-codex-inline-status]'),host);
  assert.equal(host.parentElement,doc.querySelector('[data-home-wrapper]'));
  api.destroy();
  assert.equal(doc.querySelectorAll('[data-codex-inline-footer-layout],[data-codex-inline-status]').length,0);
});
