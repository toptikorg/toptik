import { resolveImageLimits } from './existing-media-limits.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import sharp from 'sharp';
// REAL media-storage-worker + REAL media-storage-transport (upload, readback, preflight)
// + REAL diagnostics. Only DNS, fetch, Supabase env and the SQL RPC port are fixtures.
export async function loadStorageNotSent(root=new URL('../../',import.meta.url)){
const url=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(resolveImageLimits(s))).toString('base64');
const read=n=>readFileSync(new URL(`src/lib/shopify/${n}.ts`,root),'utf8');
const core=url(read('media-sync-core')),coreApi=await import(core);
const raw=url(read('media-transport-read').replaceAll('"./media-sync-core"',JSON.stringify(core)));
const requests=url(read('media-transport-requests').replaceAll('"./media-transport-read"',JSON.stringify(raw))),req=await import(requests);
const allow=url(readFileSync(new URL('src/lib/catalog-source/source-allowlist.ts',root),'utf8'));
const dns=url('export const lookup=async()=>{const s=globalThis.__storage;s.dnsCalls++;if(s.dnsFails&&s.dnsFails())throw Error("getaddrinfo ENOTFOUND");return s.addresses;}');
const env=url('export const supabaseEnv={publicUrl:"https://ekgpaoavsavrtbhlbwdg.supabase.co",serviceRoleKey:"test-only-key"}; export const hasSupabaseAdminEnv=()=>true;');
const diagnostics=url(read('media-storage-diagnostics'));
const transport=url(read('media-storage-transport').replace('import "server-only";','').replace('"sharp"',JSON.stringify(import.meta.resolve('sharp')))
 .replace('"node:dns/promises"',JSON.stringify(dns)).replace('"@/lib/catalog-source/source-allowlist"',JSON.stringify(allow))
 .replace('"@/lib/supabase/env"',JSON.stringify(env)).replaceAll('"./media-transport-requests"',JSON.stringify(requests))
 .replace('"./media-storage-diagnostics"',JSON.stringify(diagnostics)));
const sourceBody=stripTypeScriptTypes(resolveImageLimits(read('media-source-bytes'))).replace(/^import[\s\S]*?;\r?\n/gm,'');
const proof=url(`import {mediaSnapshotFingerprint} from '${core}';${sourceBody}`);
const stub=url('export function discoverMediaTransportOperation(){throw Error("fixture");} export function createMediaTransportRpc(){throw Error("fixture");}');
const worker=await import(url(read('media-storage-worker').replace('import "server-only";','')
 .replaceAll('from "./media-sync-core";',`from "${core}";`).replaceAll('from "./media-transport-read";',`from "${raw}";`)
 .replaceAll('from "./media-transport-requests";',`from "${requests}";`).replaceAll('from "./media-transport-rpc";',`from "${stub}";`)
 .replaceAll('from "./media-storage-transport";',`from "${transport}";`).replaceAll('from "./media-storage-diagnostics";',`from "${diagnostics}";`)
 .replaceAll('from "./media-source-bytes";',`from "${proof}";`)));
process.env.VERCEL_ENV='production';process.env.SHOPIFY_MEDIA_SYNC='enabled_v1';

const id={productId:'gid://shopify/Product/123',variantId:'gid://shopify/ProductVariant/456',itemId:'a0000000-0000-4000-8000-000000000001',exactGallerySku:'ABC',exactShopifySku:'ABC',productHandle:'abc'};
const owner='20000000-0000-4000-8000-000000000001',ref={operationId:'10000000-0000-4000-8000-000000000001',step:7,phaseIndex:0};
const bytes=await sharp({create:{width:16,height:24,channels:3,background:'#654321'}}).png().toBuffer();
const other=await sharp({create:{width:16,height:24,channels:3,background:'#123456'}}).png().toBuffer();
const sha=createHash('sha256').update(bytes).digest('hex'),content='b'.repeat(64);
const stagedUrl=req.stagedMediaUrl(id,sha,'image/png');

function fixture({existing=null,post=null,observeFailsAfterBegin=false,dnsFailsAfterBegin=false,addresses=[{address:'8.8.8.8',family:4}],readSource=null,repairApproved=false}={}){
 const calls=[];
 const s=globalThis.__storage={dnsCalls:0,addresses,began:false,object:existing,posts:0,gets:0};
 s.dnsFails=()=>dnsFailsAfterBegin&&s.began;
 const gallery={identity:id,side:'gallery',complete:true,revision:'g1',assets:[{key:'a',contentId:content,alt:'bag',evidenceId:'proof-a'}]};
 const pair={gallery,shopify:{...structuredClone(gallery),side:'shopify',revision:'s1'}};
 const guard=()=>({sourceFingerprint:coreApi.mediaSnapshotFingerprint(pair.shopify),target:gallery,observedAt:new Date().toISOString()});
 const g0=guard();
 const discovery={identity:id,enabled:true,operation:{id:ref.operationId,product_gid:id.productId,status:'running',observed_pair:pair},
  step:{operation_id:ref.operationId,step_index:7,status:'started',body:{kind:'replace_reference',target:'gallery',key:'a'},expected_pair:pair},
  transport:{chain:{operation_id:ref.operationId,step_index:7,status:'running',next_phase:0,phases:['gallery_upload','gallery_cas'],current_guard:g0},attempts:[],artifacts:[]},
  provenance:[{evidence_id:'proof-a',product_gid:id.productId,asset_key:'a',side:'shopify',content_id:content,
   proof:{url:'https://cdn.shopify.com/s/files/1/a.png',decodedSha256:sha,mime:'image/png',width:16,height:24,byteLength:bytes.length,ownership:'reference_only'}}]};
 const rpc={acquire:async()=>({owner,expiresAt:Date.now()+120000}),release:async()=>{calls.push('release');},
  begin:async(r,o,a,intent,fresh)=>{calls.push('begin');let p=discovery.transport.attempts[0];
   if(p)return {mayExecute:false,replayed:true,status:p.status,requestHash:p.request_hash};
   s.began=true;p={operation_id:r.operationId,step_index:r.step,phase_index:0,phase:'gallery_upload',status:'started',attempt_id:a,request_hash:'c'.repeat(64),request:intent,before_guard:fresh};
   discovery.transport.attempts.push(p);return {mayExecute:true,replayed:false,phase:'gallery_upload',attemptId:a,requestHash:p.request_hash,request:intent};},
  uncertain:async(r,o,receipt)=>{calls.push(['uncertain',receipt.outcome]);discovery.transport.attempts[0].status='uncertain';discovery.transport.chain.status='uncertain';},
  // Mirrors hold_toptik_media_transport: only an exact started, never-sent attempt.
  conflict:async(r,o,code)=>{calls.push(['hold',code]);const a=discovery.transport.attempts[0];if(!a||a.status!=='started')throw Error('MEDIA_TRANSPORT_HOLD_NOT_ALLOWED');
   a.status='conflict';a.receipt={notSent:true,code};discovery.transport.chain.status='conflict';return {status:'conflict',mayExecute:false};},
  read:async()=>structuredClone(discovery.transport),
  readStorageRepair:async()=>{calls.push('repair-read');return repairApproved?{approved:true,mayExecute:false,expired:false,objectPresent:false,claim:null,outcome:null,approval:{}}:{approved:false,mayExecute:false};},
  accept:async(r,o,q,h,after,artifact)=>{calls.push(['accept',artifact]);discovery.transport.attempts[0].status='verified';return {status:'verified',mayExecute:false};}};
 const deps={environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},discover:async()=>structuredClone(discovery),createRpc:()=>rpc,
  readSource:readSource??(async()=>new Uint8Array(bytes)),reportDiagnostic:v=>calls.push(['diagnostic',v.code,v.stage])};
 const fetchBefore=globalThis.fetch;
 globalThis.fetch=async(target,init={})=>{const u=String(target);
  if(init.method==='POST'){s.posts++;calls.push(['POST',init.headers['x-upsert']]);return post?post(s):(s.object=new Uint8Array(init.body),new Response('{}',{status:200}));}
  s.gets++;if(u!==stagedUrl)return new Response('',{status:404});return s.object?new Response(s.object,{status:200}):new Response('',{status:404});};
 const observe=async()=>{if(observeFailsAfterBegin&&s.began)throw Error('MEDIA_RUNTIME_SOURCE_CHANGED_DURING_READ');return guard();};
 return {calls,s,discovery,run:()=>worker.runPersistedStorageMediaPhase(ref,Date.now()+60000,observe,deps),restore:()=>{globalThis.fetch=fetchBefore;}};
}
return {fixture,id,sha,stagedUrl,bytes,other};
}
