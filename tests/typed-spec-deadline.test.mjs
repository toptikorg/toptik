import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUrl,source} from './helpers/typed-spec-modules.mjs';
import {descriptionModuleUrl} from './helpers/description-module.mjs';
async function loader(getToken){
 const id=`typedToken_${Math.random().toString(36).slice(2)}`;globalThis[id]=getToken;
 const provider=moduleUrl(`export const createShopifyClientCredentialsProvider=()=>()=>globalThis[${JSON.stringify(id)}]();`);
 const raw=source('admin-api').replace('import "server-only";','').replace('"./client-credentials"',JSON.stringify(provider)).replace('"./description-document"',JSON.stringify(descriptionModuleUrl))+'\nexport { graphql as boundedGraphql };';
 return import(moduleUrl(raw));
}
function env(t){const values={SHOPIFY_SHOP_DOMAIN:'fake.myshopify.com',SHOPIFY_CLIENT_ID:'test-id',SHOPIFY_CLIENT_SECRET:'test-secret',SHOPIFY_ONLINE_STORE_PUBLICATION_ID:'gid://shopify/Publication/79538258170'};const old={};for(const[k,v]of Object.entries(values)){old[k]=process.env[k];process.env[k]=v;}t.after(()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});}
test('absolute typed deadline rechecks time after token refresh before any product request',async t=>{
 env(t);let now=1000,calls=0;t.mock.method(Date,'now',()=>now);t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Must not fetch');});
 const {boundedGraphql}=await loader(async()=>{now=3000;return 'test-token';});
 await assert.rejects(boundedGraphql('mutation guarded',{},8000,2000),/SPEC_TIME_BUDGET/);assert.equal(calls,0);
});
test('slow token acquisition times out without sending a late mutation',async t=>{
 env(t);let resolveToken,calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Must not fetch');});
 const {boundedGraphql}=await loader(()=>new Promise(resolve=>{resolveToken=resolve;}));
 await assert.rejects(boundedGraphql('mutation guarded',{},8000,Date.now()+15),/SPEC_TIME_BUDGET/);resolveToken('test-token');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});
test('GraphQL network allowance is recomputed after authentication consumed time',async t=>{
 env(t);let now=1000,allowance; t.mock.method(Date,'now',()=>now);const original=AbortSignal.timeout;t.mock.method(AbortSignal,'timeout',ms=>{allowance=ms;return original(ms);});
 t.mock.method(globalThis,'fetch',async()=>Response.json({data:{ok:true}}));
 const {boundedGraphql}=await loader(async()=>{now=5000;return 'test-token';});assert.deepEqual(await boundedGraphql('query read',{},8000,7000),{ok:true});assert.equal(allowance,2000);
});
