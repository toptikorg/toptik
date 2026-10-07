// Deterministic mounted component hook/effect harness. The real client component
// and real loader/state/view-model run; no browser, production or real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire,stripTypeScriptTypes} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const libUrl=url(stripTypeScriptTypes(read('src/lib/shopify/media-sync-monitor.ts'))),lib=await import(libUrl);
const hookUrl=url('export const useState=(...a)=>globalThis.__clockHarness.useState(...a);export const useRef=(...a)=>globalThis.__clockHarness.useRef(...a);export const useEffect=(...a)=>globalThis.__clockHarness.useEffect(...a);export const useCallback=(...a)=>globalThis.__clockHarness.useCallback(...a);');
const source=ts.transpileModule(read('src/components/admin/MediaSyncMonitor.tsx'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
 .replace('"react/jsx-runtime"',JSON.stringify(import.meta.resolve('react/jsx-runtime'))).replace('"react"',JSON.stringify(hookUrl))
 .replace('"./MediaSyncMonitorView"',JSON.stringify(url('export default function View(){}'))).replace('"@/lib/shopify/media-sync-monitor"',JSON.stringify(libUrl));
const Component=(await import(url(source))).default;
const START=Date.parse('2026-10-07T14:00:00Z'),iso=t=>new Date(t).toISOString();
function payload(at=START){return lib.buildMonitorPayload({fetchedAt:iso(at),runtime:{copy:true,media:true},combinedValid:true,
 combined:{observedAt:iso(at),queues:[{lane:'media',status:'done',count:3}],coverage:{approvedProducts:3,missingMediaBaseline:0,missingMediaQueue:0}},
 status:{observedAt:iso(at),queue:[]},items:{observedAt:iso(at),limit:50,openTotal:0,items:[]}});}
const response=p=>new Response(JSON.stringify(p),{headers:{'content-type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function target(){const listeners=new Map();return{visibilityState:'visible',listeners,
 addEventListener(k,f){if(!listeners.has(k))listeners.set(k,new Set());listeners.get(k).add(f);},
 removeEventListener(k,f){listeners.get(k)?.delete(f);},dispatch(k){for(const f of [...listeners.get(k)??[]])f();},
 count(){return [...listeners.values()].reduce((n,s)=>n+s.size,0);}};}
function mount(fetchImpl=async()=>response(payload())){
 const original={now:Date.now,fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,document:globalThis.document,window:globalThis.window};
 let clock=START,cursor=0,active=true,queued=false,nextTimer=1,rendered,fetches=0;
 const slots=[],effects=[],timers=new Map(),doc=target(),win=target();
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const queue=()=>{if(!queued&&active){queued=true;queueMicrotask(()=>{queued=false;if(active)render();});}};
 const hooks={
  useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};return[slots[i].value,v=>{const n=typeof v==='function'?v(slots[i].value):v;if(!Object.is(n,slots[i].value)){slots[i].value=n;queue();}}];},
  useRef(value){const i=cursor++;if(!slots[i])slots[i]={current:value};return slots[i];},
  useCallback(callback,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={value:callback,deps};return slots[i].value;},
  useEffect(effect,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const old=slots[i];slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});}},
 };
 const render=()=>{cursor=0;rendered=Component();while(effects.length)effects.shift()();};
 globalThis.__clockHarness=hooks;Date.now=()=>clock;
 globalThis.fetch=async(...args)=>{fetches++;return fetchImpl(...args);};
 globalThis.setTimeout=(fn,ms)=>{const id=nextTimer++;timers.set(id,{fn,at:clock+ms});return id;};
 globalThis.clearTimeout=id=>timers.delete(id);globalThis.document=doc;globalThis.window=win;
 render();
 const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
 return{doc,win,timers,flush,get props(){return rendered.props;},get fetches(){return fetches;},
  async advance(ms){const end=clock+ms;while(true){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;clock=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}clock=end;await flush();},
  jump(ms){clock+=ms;},unmount(){active=false;for(const s of slots)s?.cleanup?.();},
  restore(){active=false;for(const s of slots)s?.cleanup?.();Date.now=original.now;globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;globalThis.clearTimeout=original.clearTimeout;
   if(original.document===undefined)delete globalThis.document;else globalThis.document=original.document;if(original.window===undefined)delete globalThis.window;else globalThis.window=original.window;delete globalThis.__clockHarness;},
 };
}
const verdict=h=>lib.mediaVerdict(h.props.payload,h.props.failure,h.props.now);
test('mounted completed monitor becomes stale at expiry without any refresh or network polling',async()=>{
 const h=mount();try{await h.flush();assert.equal(verdict(h).kind,'queue_complete');assert.equal(h.fetches,1);
  await h.advance(lib.MEDIA_MONITOR_STALE_MS);assert.equal(verdict(h).kind,'queue_complete');
  await h.advance(1);assert.deepEqual(verdict(h),{kind:'unknown',reason:'stale'});assert.equal(h.fetches,1);assert.equal(h.timers.size,0);
 }finally{h.restore();}
});
test('visibility return and pageshow expire suspended timestamps immediately without a GET',async()=>{
 for(const event of ['visibilitychange','pageshow']){const h=mount();try{await h.flush();h.doc.visibilityState='hidden';h.jump(lib.MEDIA_MONITOR_STALE_MS+1000);
  if(event==='visibilitychange'){h.doc.dispatch(event);await h.flush();assert.equal(verdict(h).kind,'queue_complete');h.doc.visibilityState='visible';h.doc.dispatch(event);}else h.win.dispatch(event);
  await h.flush();assert.equal(verdict(h).reason,'stale');assert.equal(h.fetches,1);
 }finally{h.restore();}}
});
test('unmount removes local timers and visibility/page listeners',async()=>{
 const h=mount();try{await h.flush();assert.equal(h.timers.size,1);assert.equal(h.doc.count(),1);assert.equal(h.win.count(),1);
  h.unmount();assert.equal(h.timers.size,0);assert.equal(h.doc.count(),0);assert.equal(h.win.count(),0);
 }finally{h.restore();}
});
test('new accepted data replaces the expiry timer and stale response cannot overwrite it',async()=>{
 const first=deferred(),second=deferred();let n=0;const h=mount(async()=>++n===1?first.promise:second.promise);
 try{await h.flush();h.props.onRefresh();await h.flush();second.resolve(response(payload(START+1000)));await h.flush();
  assert.equal(h.props.payload.fetchedAt,iso(START+1000));first.resolve(response(payload(START)));await h.flush();
  assert.equal(h.props.payload.fetchedAt,iso(START+1000));assert.equal(h.fetches,2);
  await h.advance(lib.MEDIA_MONITOR_STALE_MS+1);assert.equal(verdict(h).kind,'queue_complete');
  await h.advance(1000);assert.equal(verdict(h).reason,'stale');assert.equal(h.fetches,2);
 }finally{h.restore();}
});
