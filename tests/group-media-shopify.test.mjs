import test from 'node:test';
import assert from 'node:assert/strict';
import {load,legacy,transport,snapshot,operationId} from './helpers/group-media-fixture.mjs';

const make=await load('src/lib/shopify/group-media-shopify.ts',[
 'configuredShopifyDomain','shopifyAdminGraphql','verifyOnboardingImage','parseTransportMedia','groupOwnedFilename','process',
],['sendGroupMediaMutation','readGroupMediaJob']);
const officialJob='gid://shopify/Job/6dfa599a-a426-4030-8f10-6564abc465f9';
const before=snapshot(),request=transport.buildGroupMediaPhase({operationId,phaseIndex:0,before,
 phase:{kind:'reorder',mediaIds:[before.media[1].mediaId,before.media[0].mediaId,...before.media.slice(2).map(m=>m.mediaId)],protectedMediaIds:[]}});
function setup(response){
 const calls=[];
 const api=make({...legacy,...transport,configuredShopifyDomain:()=> 'toptikcoil.myshopify.com',
  process:{env:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1',SHOPIFY_API_VERSION:'2026-07'}},
  shopifyAdminGraphql:async(query,variables)=>{calls.push({query,variables});return typeof response==='function'?response(query,variables):structuredClone(response);},
  verifyOnboardingImage:async()=>{throw new Error('UNEXPECTED_IMAGE_READ')},
 });
 return{...api,calls};
}

// Official pinned example, supplied by the independent documentation review:
// https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productReorderMedia
// Job.id is ID!, not an integer: https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Job
for(const id of[officialJob,'gid://shopify/Job/991'])test('reorder ACK and job poll preserve exact opaque Job ID '+id,async()=>{
 let done=false;
 const api=setup(query=>query.startsWith('mutation')?{productReorderMedia:{job:{id},mediaUserErrors:[]}}:{job:{id,done}});
 assert.deepEqual(await api.sendGroupMediaMutation(request,Date.now()+10000),{jobId:id});
 assert.equal(await api.readGroupMediaJob(id,Date.now()+10000),false);done=true;
 assert.equal(await api.readGroupMediaJob(id,Date.now()+10000),true);
 assert.equal(api.calls[1].variables.id,id);assert.equal(api.calls[2].variables.id,id);
});

test('foreign, empty, split or unbounded Job IDs are refused in both ACK and poll',async()=>{
 for(const id of['gid://shopify/Product/991','gid://other/Job/991','gid://shopify/Job/','gid://shopify/Job/a/b',
  'gid://shopify/Job/a?token=fixture','gid://shopify/Job/a#fragment','gid://shopify/Job/a\nb','gid://shopify/Job/a b',
  'gid://shopify/Job/a\u0000b','gid://shopify/Job/'+ 'a'.repeat(513)]){
  const api=setup({productReorderMedia:{job:{id},mediaUserErrors:[]}});
  await assert.rejects(api.sendGroupMediaMutation(request,Date.now()+10000),/GROUP_MEDIA_ACK_INVALID/);
  const reads=api.calls.length;await assert.rejects(api.readGroupMediaJob(id,Date.now()+10000),/GROUP_MEDIA_ACK_INVALID/);
  assert.equal(api.calls.length,reads,'invalid job ID must not reach Admin API');
 }
});

test('missing or null reorder job is still an error, never synchronous success',async()=>{
 for(const job of[null,undefined]){
  const api=setup({productReorderMedia:{job,mediaUserErrors:[]}});
  await assert.rejects(api.sendGroupMediaMutation(request,Date.now()+10000),/GROUP_MEDIA_RESPONSE_INVALID/);
 }
 for(const id of[null,7,{}]){
  const api=setup({productReorderMedia:{job:{id},mediaUserErrors:[]}});
  await assert.rejects(api.sendGroupMediaMutation(request,Date.now()+10000),/GROUP_MEDIA_ACK_INVALID/);
 }
 const api=setup({productReorderMedia:{job:{id:officialJob}}});
 await assert.rejects(api.sendGroupMediaMutation(request,Date.now()+10000),/GROUP_MEDIA_ACK_INVALID/);
});

test('job readback requires the requested opaque identity and a real completion boolean',async()=>{
 for(const response of[{job:{id:'gid://shopify/Job/other',done:true}},{job:{id:officialJob,done:'true'}}]){
  const api=setup(response);await assert.rejects(api.readGroupMediaJob(officialJob,Date.now()+10000),/GROUP_MEDIA_ACK_INVALID/);
 }
 await assert.rejects(setup({job:null}).readGroupMediaJob(officialJob,Date.now()+10000),/GROUP_MEDIA_RESPONSE_INVALID/);
});

test('provider errors retain bounded codes without accepting their job as success',async()=>{
 const api=setup({productReorderMedia:{job:{id:officialJob},mediaUserErrors:[{code:'MEDIA_DOES_NOT_EXIST',message:'private provider detail'},{code:'not a code',message:'other detail'}]}});
 await assert.rejects(api.sendGroupMediaMutation(request,Date.now()+10000),error=>{
  assert.equal(error.message,'GROUP_MEDIA_WRITE_REJECTED');assert.deepEqual(error.providerCodes,['MEDIA_DOES_NOT_EXIST']);
  assert.equal(JSON.stringify(error).includes('private provider detail'),false);return true;
 });
});
