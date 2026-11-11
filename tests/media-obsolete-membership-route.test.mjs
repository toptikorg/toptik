import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {loadWrapped,dataUrl} from './helpers/owned-edit-harness.mjs';
const pure=path=>import(dataUrl(stripTypeScriptTypes(readFileSync(path,'utf8'))));
const authCore=await pure('src/lib/admin/authz-core.ts'),sessionPolicy=await pure('src/lib/admin/gallery-session-policy.ts');
const makeToken=await loadWrapped('src/lib/admin/admin-token.ts',['createHash','timingSafeEqual','NextResponse','supabaseEnv','process'],['requireAdminToken']);
const makeAuth=await loadWrapped('src/lib/admin/authz.ts',['NextResponse','redirect','getPanelUser','authorizePanelUser'],['requireAdminUser']);
const makeAccess=await loadWrapped('src/lib/admin/gallery-access.ts',['NextResponse','requireAdminToken','requireAdminUser','allowsGallerySessionRequest'],['authorizeGalleryAdmin']);
const makeParser=await loadWrapped('src/lib/shopify/media-obsolete-membership.ts',[],['parseObsoleteMembershipCommand']);
// The wrapped parser module's other functions are never invoked by these route tests.
const parser=makeParser({});
const makeRoute=await loadWrapped('src/app/api/admin/shopify/media/obsolete-membership/route.ts',
 ['NextResponse','authorizeGalleryAdmin','createSupabaseServiceRoleClient','handleObsoleteMembership','parseObsoleteMembershipCommand','scheduleMediaSyncWakeup','Buffer'],['POST']);
const NextResponse={json:(body,init={})=>({body,status:init.status??200,headers:init.headers})};
const itemId='a0000000-0000-4000-8000-000000000001',userId='a0000000-0000-4000-8000-000000000002';
const user=role=>({id:userId,email:'synthetic@example.test',email_confirmed_at:'2026-11-10T00:00:00Z',app_metadata:{role,provider:'email'},user_metadata:{}});
const command={action:'preview',itemId};
function fixture(principal=user('admin')){
 const calls=[],state={error:null,decisionRecorded:false};
 const auth=makeAuth({NextResponse,redirect:()=>{throw Error('unexpected redirect');},getPanelUser:async()=>principal,authorizePanelUser:authCore.authorizePanelUser});
 const token=makeToken({createHash,timingSafeEqual,NextResponse,supabaseEnv:{adminToken:'synthetic-token'},process:{env:{}}});
 const access=makeAccess({NextResponse,requireAdminToken:token.requireAdminToken,requireAdminUser:auth.requireAdminUser,allowsGallerySessionRequest:sessionPolicy.allowsGallerySessionRequest});
 const route=makeRoute({NextResponse,authorizeGalleryAdmin:access.authorizeGalleryAdmin,Buffer,parseObsoleteMembershipCommand:parser.parseObsoleteMembershipCommand,
  createSupabaseServiceRoleClient:()=>{calls.push(['client']);return {};},scheduleMediaSyncWakeup:()=>calls.push(['wake']),
  handleObsoleteMembership:async(_db,c,actor)=>{calls.push(['handle',c,actor]);if(state.error)throw state.error;return {decisionRecorded:state.decisionRecorded,syncVerified:false};}});
 return {calls,state,post:(body=command,headers={})=>route.POST({method:'POST',nextUrl:new URL('https://landing.toptik.co.il/api/admin/shopify/media/obsolete-membership'),
  headers:new Headers({'content-type':'application/json',origin:'https://landing.toptik.co.il','sec-fetch-site':'same-origin',...headers}),
  get body(){calls.push(['body']);return new Response(typeof body==='string'?body:JSON.stringify(body)).body;}})};
}
test('real auth rejects anonymous, non-admin, forged and unconfirmed sessions before body or DB',async()=>{
 for(const principal of [null,user('member'),{...user('admin'),app_metadata:{},user_metadata:{role:'owner'}},{...user('admin'),email_confirmed_at:null}]){
  const f=fixture(principal),r=await f.post();assert([401,403].includes(r.status));assert.deepEqual(f.calls,[]);
 }
});
test('real session CSRF gate rejects absent, null, foreign origin and cross-site requests before body',async()=>{
 for(const headers of [{origin:''},{origin:'null'},{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'}]){const f=fixture();assert.equal((await f.post(command,headers)).status,403);assert.deepEqual(f.calls,[]);}
});
test('admin and owner sessions bind actual UUID; token binds the fixed configured principal',async()=>{
 for(const principal of [user('owner'),user('admin'),null]){
  const f=fixture(principal),r=await f.post(command,principal?{}:{'x-admin-token':'synthetic-token'});assert.equal(r.status,200);assert.equal(r.headers['Cache-Control'],'no-store');
  assert.deepEqual(f.calls.find(c=>c[0]==='handle')[2],principal?{actorType:'supabase_user',actorId:userId}:{actorType:'admin_panel_token',actorId:'configured-admin-panel'});
  assert(!f.calls.some(c=>c[0]==='wake'));
 }
});
test('malformed, injected and oversized requests cannot construct a service client',async()=>{
 for(const [body,headers,status] of [['{',{},400],[null,{},400],[{...command,actorId:userId},{},400],[{...command,keys:['old']},{},400],
  [command,{'content-length':'1025'},413],[' '.repeat(1025),{},413],[command,{'content-type':'text/plain'},415]]){
  const f=fixture();assert.equal((await f.post(body,headers)).status,status);assert(!f.calls.some(c=>c[0]==='client'));
 }
});
test('only a recorded explicit confirmation wakes reconciliation; failures remain unverified and provider details stay private',async()=>{
 const f=fixture(),confirm={action:'confirm',itemId,proposalHash:'a'.repeat(64),approval:'RETIRE_MISSING_GALLERY_KEYS_WITHOUT_MEDIA_CHANGES'};
 f.state.decisionRecorded=true;assert.equal((await f.post(confirm)).body.syncVerified,false);assert.equal(f.calls.filter(c=>c[0]==='wake').length,1);
 const failed=fixture();failed.state.error=Error('password private');const r=await failed.post(confirm);assert.deepEqual(r.body,{error:'MEDIA_OBSOLETE_FAILED',syncVerified:false});assert.equal(r.status,409);assert(!failed.calls.some(c=>c[0]==='wake'));
});
