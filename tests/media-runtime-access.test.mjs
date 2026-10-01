import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
Error.stackTraceLimit=0;
const body=stripTypeScriptTypes(readFileSync(new URL('../src/lib/shopify/media-runtime-access.ts',import.meta.url),'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const source=`export function make(deps){const {shopifyAdminGraphql,configuredShopifyDomain,MEDIA_API_VERSION,MEDIA_PUBLICATION_ID,process,Date}=deps;${body};return readMediaRuntimeScopes;}`;
const {make}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const publication='gid://shopify/Publication/79538258170';
function fixture(){
  const calls=[],now=Date.parse('2026-09-30T17:00:00Z');let clock=now;
  const data={shop:{myshopifyDomain:'toptikcoil.myshopify.com'},publication:{id:publication},currentAppInstallation:{accessScopes:[{handle:'write_products'},{handle:'read_products'}]}};
  const deps={MEDIA_API_VERSION:'2026-07',MEDIA_PUBLICATION_ID:publication,configuredShopifyDomain:()=> 'toptikcoil.myshopify.com',
    process:{env:{SHOPIFY_API_VERSION:'2026-07',SHOPIFY_ONLINE_STORE_PUBLICATION_ID:publication}},
    Date:class extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}},
    shopifyAdminGraphql:async(...args)=>{calls.push(args);return data;}};
  return {data,deps,calls,now,run:()=>make(deps)(now+20000),tick:ms=>clock+=ms};
}
test('fresh read returns actual installed scopes and fixed shop, with bounded token deadline',async()=>{
  const f=fixture(),out=await f.run();assert.deepEqual(out.scopes,['read_products','write_products']);assert.equal(out.shopDomain,'toptikcoil.myshopify.com');
  assert.equal(out.observedAt,new Date(f.now).toISOString());assert.match(f.calls[0][0],/^query /);assert.equal(f.calls[0][2],5000);assert.equal(f.calls[0][3],f.now+5000);
});
for(const [name,edit] of [
  ['wrong configured shop',f=>f.deps.configuredShopifyDomain=()=> 'foreign.myshopify.com'],
  ['wrong version',f=>f.deps.process.env.SHOPIFY_API_VERSION='2025-01'],
  ['missing publication',f=>delete f.deps.process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID],
])test(`rejects ${name} before network`,async()=>{const f=fixture();edit(f);await assert.rejects(f.run(),/CONFIG_MISMATCH/);assert.equal(f.calls.length,0);});
for(const [name,edit] of [
  ['wrong returned shop',f=>f.data.shop.myshopifyDomain='foreign.myshopify.com'],
  ['wrong returned publication',f=>f.data.publication.id='gid://shopify/Publication/2'],
  ['missing installation',f=>f.data.currentAppInstallation=null],
  ['duplicated scopes',f=>f.data.currentAppInstallation.accessScopes.push({handle:'read_products'})],
  ['malformed scope',f=>f.data.currentAppInstallation.accessScopes.push({handle:'*'})],
])test(`rejects ${name}`,async()=>{const f=fixture();edit(f);await assert.rejects(f.run(),/MEDIA_RUNTIME_/);});
test('does not invent missing write access',async()=>{const f=fixture();f.data.currentAppInstallation.accessScopes=[];assert.deepEqual((await f.run()).scopes,[]);});
test('expired deadline does not fetch',async()=>{const f=fixture();await assert.rejects(make(f.deps)(f.now),/TIME_BUDGET/);assert.equal(f.calls.length,0);});
test('late token/API response cannot count as fresh scope proof',async()=>{const f=fixture();f.deps.shopifyAdminGraphql=async()=>{f.tick(5001);return f.data;};await assert.rejects(f.run(),/TIME_BUDGET/);});
