import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { descriptionModuleUrl } from './helpers/description-module.mjs';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolveImageLimits(source))).toString('base64')}`;
const source = name => readFileSync(`src/lib/shopify/${name}.ts`, 'utf8');
const coreUrl = moduleUrl(source('media-sync-core'));
const readUrl = moduleUrl(source('media-transport-read').replaceAll('from "./media-sync-core";', `from "${coreUrl}";`));
const readyUrl = moduleUrl(source('media-read-adapter').replaceAll('from "./media-sync-core";', `from "${coreUrl}";`));
const requestsUrl = moduleUrl(source('media-transport-requests').replaceAll('from "./media-transport-read";', `from "${readUrl}";`));
const read = await import(readUrl), requests = await import(requestsUrl);
const body = stripTypeScriptTypes(resolveImageLimits(source('media-shopify-transport'))).replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const { makeAdapter } = await import(moduleUrl(`
  import {buildMediaReadRequest,parseMediaReadResponse,MEDIA_API_VERSION,MEDIA_PUBLICATION_ID} from '${readyUrl}';
  import {assertMediaTransportRead,parseMediaTransportResponse,parseTransportMedia,onlyForwardProductTimestampDrift,PRODUCT_TIMESTAMP_TOLERANT_PHASES} from '${readUrl}';
  import {buildOwnedMediaCreate,buildOwnedMediaAssociate,buildMediaVariantReassign,buildMediaReferenceDetach,
    buildMediaReorder,buildOwnedMediaRecoveryRead,buildOwnedMediaNodeRead,ownedMediaFilename,
    parseOwnedMediaRecovery,parseMediaTransportAcknowledgement} from '${requestsUrl}';
  export function makeAdapter(deps) {
    const {shopifyAdminGraphql,verifyOnboardingImage,process,Date}=deps;
    ${body}
    return {readReadyShopifyMedia,readShopifyMediaTransport,rebuildShopifyMediaMutation,executeShopifyMediaTransport,
      findOwnedShopifyMedia,readOwnedShopifyMediaNode,readDecodedOwnedShopifyMedia};
  }
`));
const env = { SHOPIFY_SHOP_DOMAIN:'toptikcoil.myshopify.com', SHOPIFY_ONLINE_STORE_PUBLICATION_ID:'gid://shopify/Publication/79538258170',
  SHOPIFY_API_VERSION:'2026-07', VERCEL_ENV:'production', SHOPIFY_MEDIA_SYNC:'enabled_v1' };
const identity = { productId:'gid://shopify/Product/7550812619002', variantId:'gid://shopify/ProductVariant/42465754808570',
  itemId:'6f887176-e70a-44ba-b252-238f994b66ad', exactGallerySku:'P10SZV24-05J-TU', exactShopifySku:'P10SZV2405J', productHandle:'logoduck-i-טרולי' };
const time='2026-09-30T17:00:00Z', now=Date.parse(time), connection=nodes=>({nodes,pageInfo:{hasNextPage:false}});
const image=n=>({id:`gid://shopify/MediaImage/${n}`,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',alt:'מזוודה',updatedAt:time,
  image:{id:`gid://shopify/ImageSource/${n}`,url:`https://cdn.shopify.com/s/files/1/0645/image-${n}.jpg?v=123`,width:40,height:60}});
function product(media=[image(1),image(2)]) { return {id:identity.productId,handle:identity.productHandle,status:'ACTIVE',publishedOnPublication:true,updatedAt:time,
  mediaCount:{count:media.length,precision:'EXACT'},media:connection(media),variants:connection([{id:identity.variantId,sku:identity.exactShopifySku,
    image:{id:'gid://shopify/ProductImage/999',url:image(1).image.url},media:connection([{id:image(1).id}])}])}; }
function fixture(phase='associate') {
  const raw=product(), before=read.parseMediaTransportResponse({data:{product:raw}},identity);
  const context={identity,operationId:'10000000-0000-4000-8000-000000000001',step:0,sourceFingerprint:'a'.repeat(64),targetRevision:before.revision};
  const staged={identity,contentSha256:'b'.repeat(64),mime:'image/jpeg',byteLength:1000,width:40,height:60,
    url:requests.stagedMediaUrl(identity,'b'.repeat(64),'image/jpeg'),receiptId:'private-upload'};
  const filename=requests.ownedMediaFilename(context,staged.contentSha256,staged.mime), created=image(3);
  created.image.url=`https://cdn.shopify.com/s/files/1/0645/${filename}?v=123`;
  const owned={identity,operationId:context.operationId,step:0,sourceFingerprint:context.sourceFingerprint,filename,sourceSha256:staged.contentSha256,
    mime:staged.mime,alt:'מזוודה',media:read.parseTransportMedia(created),decodedSha256:'c'.repeat(64),decodedByteLength:999,receiptId:'private-decoded'};
  let evidence={phase,before},request;
  if(phase==='create_owned'){evidence={...evidence,source:staged,alt:'מזוודה'};request=requests.buildOwnedMediaCreate(context,staged,evidence.alt);}
  if(phase==='associate'){evidence={...evidence,owned};request=requests.buildOwnedMediaAssociate(context,before,owned);}
  if(phase==='variant_reassign'){
    raw.media.nodes.push(created);raw.mediaCount.count++;
    evidence={...evidence,before:read.parseMediaTransportResponse({data:{product:raw}},identity),owned,oldMediaId:image(1).id};
    context.targetRevision=evidence.before.revision;request=requests.buildMediaVariantReassign(context,evidence.before,image(1).id,owned);
  }
  if(phase==='detach_old'||phase==='detach_reference'){evidence={...evidence,oldMediaId:image(2).id};request=requests.buildMediaReferenceDetach(context,before,image(2).id,phase);}
  if(phase==='reorder'){evidence={...evidence,desiredIds:[image(2).id,image(1).id]};request=requests.buildMediaReorder(context,before,evidence.desiredIds);}
  const calls=[],decodes=[];let clock=now;
  const localEnv={...env};
  const acknowledgement=()=>phase==='reorder'?{productReorderMedia:{job:{id:'gid://shopify/Job/123'},mediaUserErrors:[]}}:
    phase==='variant_reassign'?{productVariantsBulkUpdate:{productVariants:[{id:identity.variantId,image:created.image}],userErrors:[]}}:
    {[phase==='create_owned'?'fileCreate':'fileUpdate']:{files:[phase.startsWith('detach')?image(2):created],userErrors:[]}};
  const deps={Date:{now:()=>clock},process:{env:localEnv},
    shopifyAdminGraphql:async(query,variables,timeout,deadline)=>{calls.push({query,variables,timeout,deadline});
      if(query.startsWith('query TopTikMediaRead'))return {product:structuredClone(raw)};
      if(query.startsWith('query TopTikRecover'))return {files:connection([structuredClone(created)])};
      if(query.startsWith('query TopTikReadOwned'))return {node:structuredClone(created)};
      return acknowledgement();},
    verifyOnboardingImage:async(media,deadline)=>{decodes.push({media,deadline});return {mediaGid:media.id,url:media.image.url,
      width:media.image.width,height:media.image.height,mime:'image/jpeg',byteLength:999,sha256:'c'.repeat(64)};}};
  const adapter=()=>makeAdapter(deps), deadline=now+25000;
  return {raw,before,context,staged,owned,created,filename,evidence,request,calls,decodes,deps,localEnv,deadline,adapter,
    setClock:value=>{clock=value;},run:()=>adapter().executeShopifyMediaTransport(request,evidence,deadline)};
}

test('planning reader returns only complete READY fixed-product evidence',async()=>{
  const f=fixture(),out=await f.adapter().readReadyShopifyMedia(identity,f.deadline);
  assert.equal(out.identity.productId,identity.productId);assert.equal(out.images.length,2);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].variables.publicationId,env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID);
  assert.ok(f.calls[0].deadline<=f.deadline);
  f.raw.media.nodes[0].fileStatus='PROCESSING';await assert.rejects(f.adapter().readReadyShopifyMedia(identity,f.deadline),/ASSET_NOT_READY/);
});
for(const phase of ['create_owned','associate','variant_reassign','detach_old','detach_reference','reorder']) {
  test(`only the strict ${phase} builder can authorize one fixed-shop mutation`,async()=>{
    const f=fixture(phase);assert.deepEqual(f.adapter().rebuildShopifyMediaMutation(f.request,f.evidence),f.request);
    const out=await f.run();assert.ok(out.data);assert.equal(f.calls.length,2);
    assert.equal(f.calls[0].variables.publicationId,env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID);
    assert.equal(f.calls[1].query,f.request.query);assert.deepEqual(f.calls[1].variables,f.request.variables);
    assert.equal(f.calls[0].deadline,now+8000);assert.equal(f.calls[1].deadline,now+15000);
    assert.ok(!f.calls[1].query.includes('fileDelete'));
  });
}
test('arbitrary GraphQL with recomputed hash, extra variables and noncanonical API version are rejected before any read',async()=>{
  for(const edit of [r=>{r.query+=' mutation Bad { fileDelete }';},r=>{r.variables.extra='unsafe';},r=>{r.apiVersion='2026-04';}]) {
    const f=fixture();edit(f.request);const body={...f.request};delete body.mutationSha256;
    f.request.mutationSha256=createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await assert.rejects(f.run(),/NOT_CANONICAL/);assert.equal(f.calls.length,0);
  }
});
test('wrong private phase/identity or changed owned source cannot authorize writes',async()=>{
  for(const edit of [e=>{e.phase='create_owned';},e=>{e.before.identity.itemId='10000000-0000-4000-8000-000000000099';},
    e=>{e.owned.media.mediaId='gid://shopify/MediaImage/987';}]) {
    const f=fixture();edit(f.evidence);await assert.rejects(f.run());assert.equal(f.calls.length,0);
  }
});
test('writes require explicit production activation and exact shop/publication/API config',async()=>{
  for(const [key,value] of [['VERCEL_ENV','preview'],['SHOPIFY_MEDIA_SYNC',''],['SHOPIFY_SHOP_DOMAIN','other.myshopify.com'],
    ['SHOPIFY_ONLINE_STORE_PUBLICATION_ID','gid://shopify/Publication/1'],['SHOPIFY_API_VERSION','2026-04']]) {
    const f=fixture();f.localEnv[key]=value;await assert.rejects(f.run(),/DISABLED|CONFIG_MISMATCH/);assert.equal(f.calls.length,0);
  }
});
test('raw reads and recovery remain read-only when activation is off',async()=>{
  const f=fixture();delete f.localEnv.SHOPIFY_MEDIA_SYNC;f.localEnv.VERCEL_ENV='preview';
  const raw=await f.adapter().readShopifyMediaTransport(identity,f.deadline);assert.equal(raw.revision,f.before.revision);
  const found=await f.adapter().findOwnedShopifyMedia(f.context,f.staged.contentSha256,f.staged.mime,f.deadline);
  assert.equal(found.mediaId,f.created.id);assert.ok(f.calls.every(c=>c.query.startsWith('query ')));
});
test('late identity/media changes fail before mutation, including pending media and exact raw SKU',async()=>{
  for(const edit of [p=>{p.media.nodes[1].alt='changed';},p=>{p.variants.nodes[0].sku='P10SZV24-05J-TU';},
    p=>{p.variants.pageInfo.hasNextPage=true;},p=>{p.media.nodes[1].status='PROCESSING';p.media.nodes[1].image=null;}]) {
    const f=fixture();edit(f.raw);await assert.rejects(f.run(),/CHANGED|INCOMPLETE/);assert.equal(f.calls.length,1);
  }
});
test('mutation transport failures, malformed acknowledgement and provider errors are never retried',async()=>{
  for(const reply of [()=>{throw Error('network');},()=>({fileUpdate:{files:[],userErrors:[]}}),
    ()=>({fileUpdate:{files:[],userErrors:[{message:'rejected'}]}})]) {
    const f=fixture(),original=f.deps.shopifyAdminGraphql;f.deps.shopifyAdminGraphql=async(...args)=>{
      if(args[0].startsWith('mutation ')){f.calls.push({query:args[0]});return reply();}return original(...args);};
    await assert.rejects(f.run());assert.equal(f.calls.filter(c=>c.query.startsWith('mutation ')).length,1);
  }
});
test('expired or malformed deadlines dispatch nothing',async()=>{
  for(const deadline of [now,NaN,Infinity]) {const f=fixture();await assert.rejects(f.adapter().executeShopifyMediaTransport(f.request,f.evidence,deadline),/TIME_BUDGET/);assert.equal(f.calls.length,0);}
});
test('read completed after deadline prevents mutation dispatch',async()=>{
  const f=fixture(),original=f.deps.shopifyAdminGraphql;f.deps.shopifyAdminGraphql=async(...args)=>{const out=await original(...args);f.setClock(f.deadline+1);return out;};
  await assert.rejects(f.run(),/TIME_BUDGET/);assert.equal(f.calls.length,1);
});
test('owned filename absence is returned without retrying file creation',async()=>{
  const f=fixture();f.deps.shopifyAdminGraphql=async(query)=>{f.calls.push({query});return {files:connection([])};};
  assert.equal(await f.adapter().readDecodedOwnedShopifyMedia(f.context,f.staged.contentSha256,f.staged.mime,null,f.deadline),null);
  assert.equal(f.calls.length,1);assert.equal(f.decodes.length,0);
});
test('ambiguous filename, pending media and wrong node identity cannot become owned decode proof',async()=>{
  for(const reply of [{files:connection([image(3),image(4)])},{files:connection([{...image(3),status:'PROCESSING',fileStatus:'PROCESSING',image:null}])}]) {
    const f=fixture();f.deps.shopifyAdminGraphql=async()=>reply;
    await assert.rejects(f.adapter().readDecodedOwnedShopifyMedia(f.context,f.staged.contentSha256,f.staged.mime,null,f.deadline));assert.equal(f.decodes.length,0);
  }
  const f=fixture();await assert.rejects(f.adapter().readOwnedShopifyMediaNode(image(99).id,f.deadline),/ID_CHANGED/);
});
test('decode uses exact bytes URL, accepts Shopify recompression and rechecks the same file',async()=>{
  const f=fixture(),out=await f.adapter().readDecodedOwnedShopifyMedia(f.context,f.staged.contentSha256,f.staged.mime,null,f.deadline);
  assert.equal(out.filename,f.filename);assert.equal(out.decoded.sha256,'c'.repeat(64));assert.notEqual(out.decoded.sha256,f.staged.contentSha256);
  assert.equal(f.decodes[0].media.image.url,f.created.image.url);assert.equal(f.decodes[0].deadline,f.deadline);
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.query.startsWith('query ')));
});
test('decoded media drift, mismatched dimensions or GIF remains unverified',async()=>{
  for(const mode of ['changed','dimensions','gif']) {
    const f=fixture(),original=f.deps.verifyOnboardingImage;
    f.deps.verifyOnboardingImage=async(...args)=>{const value=await original(...args);
      if(mode==='changed')f.created.alt='edited during decode';if(mode==='dimensions')value.width++;if(mode==='gif')value.mime='image/gif';return value;};
    await assert.rejects(f.adapter().readDecodedOwnedShopifyMedia(f.context,f.staged.contentSha256,f.staged.mime,f.created.id,f.deadline),/CHANGED|EVIDENCE_INVALID/);
  }
});

const providerUrl=moduleUrl(source('client-credentials'));
const realApiUrl=moduleUrl(source('admin-api').replace(/^import "server-only";\s*/m,'')
  .replace('from "./client-credentials"',`from "${providerUrl}"`).replace('from "./description-document"',`from "${descriptionModuleUrl}"`));
const realApi=await import(realApiUrl);
function realEnvironment(t) {
  const values={...env,SHOPIFY_CLIENT_ID:'isolated-media-client',SHOPIFY_CLIENT_SECRET:'isolated-media-secret'};
  const prior=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
  t.after(()=>{for(const [k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
}
test('actual shared OAuth transport will not send the mutation if token refresh uses the remaining deadline',async t=>{
  realEnvironment(t);const f=fixture();let clock=now,exchanges=0,mutations=0;
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url).endsWith('/oauth/access_token')){exchanges++;if(exchanges===2)clock=f.deadline+1;
      return Response.json({access_token:'fixture-media-token',expires_in:86400,scope:'read_products,write_products,write_files'});}
    assert.equal(url,'https://toptikcoil.myshopify.com/admin/api/2026-07/graphql.json');assert.equal(init.redirect,'manual');
    const request=JSON.parse(init.body);
    if(request.query.startsWith('query ')){process.env.SHOPIFY_CLIENT_SECRET='isolated-force-token-refresh';return Response.json({data:{product:f.raw}});}
    mutations++;throw Error('must not dispatch');
  });
  const api=makeAdapter({...f.deps,Date,process,shopifyAdminGraphql:realApi.shopifyAdminGraphql});
  await assert.rejects(api.executeShopifyMediaTransport(f.request,f.evidence,f.deadline),/TIME_BUDGET/);
  assert.equal(exchanges,2);assert.equal(mutations,0);
});
test('actual shared transport rejects the whole malformed GraphQL envelope before any mutation',async t=>{
  realEnvironment(t);let packet={data:{product:null}},mutations=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url).endsWith('/oauth/access_token'))return Response.json({access_token:'fixture-envelope-token',expires_in:86400,scope:'write_products'});
    if(JSON.parse(init.body).query.startsWith('mutation '))mutations++;
    return Response.json(packet);
  });
  const f=fixture(),api=makeAdapter({...f.deps,Date,process,shopifyAdminGraphql:realApi.shopifyAdminGraphql});
  for(const value of [null,[],{data:[]},{data:{product:f.raw},errors:{}},{data:{product:f.raw},errors:[{message:'fail'}]}]){
    packet=value;await assert.rejects(api.readShopifyMediaTransport(identity,Date.now()+20000),/GRAPHQL_/);
  }
  assert.equal(mutations,0);
});

test('real unchanged sharp verifier decodes image bytes in recovery, with only DNS/network mocked',async()=>{
  const vendorUrl=moduleUrl(readFileSync('src/lib/catalog-source/vendor-detect.ts','utf8'));
  const rulesUrl=moduleUrl(source('sync-rules').replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendorUrl)));
  const policyUrl=moduleUrl(source('onboarding-policy').replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rulesUrl)));
  const guardsUrl=moduleUrl(readFileSync('src/lib/catalog-source/source-allowlist.ts','utf8'));
  const verifierBody=stripTypeScriptTypes(resolveImageLimits(source('onboarding-worker'))).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
  const {makeVerifier}=await import(moduleUrl(`import {createHash} from 'node:crypto';import sharp from '${import.meta.resolve('sharp')}';
    import {isPrivateAddress} from '${guardsUrl}';import {normalizeSyncSku} from '${rulesUrl}';
    import {approvedShopifyImageUrl,assertOnboardingShopifyUniqueness,MAX_ONBOARDING_IMAGE_BYTES,ONBOARDING_SHOP_DOMAIN,
      onboardingSnapshotFingerprint,PUBLIC_ONBOARDING_POLICY,publicOnboardingCandidate} from '${policyUrl}';
    export function makeVerifier(deps){const {lookup,fetch}=deps;${verifierBody};return verifyOnboardingImage;}`));
  const bytes=await sharp({create:{width:40,height:60,channels:3,background:'#ffcc00'}}).png().toBuffer();
  const f=fixture();let downloads=0;
  const verifier=makeVerifier({lookup:async()=>[{address:'8.8.8.8'}],fetch:async(url,init)=>{
    downloads++;assert.equal(url,f.created.image.url);assert.equal(init.redirect,'error');return new Response(bytes,{headers:{'content-type':'image/png'}});}});
  const api=makeAdapter({...f.deps,Date,verifyOnboardingImage:verifier});
  const result=await api.readDecodedOwnedShopifyMedia(f.context,f.staged.contentSha256,f.staged.mime,f.created.id,Date.now()+20000);
  assert.equal(result.decoded.mime,'image/png');assert.equal(result.decoded.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(downloads,1);
});
// Shopify bumps product.updatedAt asynchronously after an association. Mid-chain phases whose
// SQL readback ignores product updatedAt tolerate ONLY that forward bump at call time.
for(const phase of ['associate','variant_reassign','detach_old','detach_reference','reorder']) test(`${phase} sends despite a forward product updatedAt-only bump`,async()=>{
  const f=fixture(phase);f.raw.updatedAt='2026-09-30T17:00:09Z';
  await f.run();assert.equal(f.calls.filter(c=>!c.query.startsWith('query ')).length,1);
});
test('create_owned stays strict on a product updatedAt bump at call time',async()=>{
  const f=fixture('create_owned');f.raw.updatedAt='2026-09-30T17:00:09Z';
  await assert.rejects(f.run(),/MEDIA_TRANSPORT_CHANGED_BEFORE_CALL/);assert.equal(f.calls.filter(c=>!c.query.startsWith('query ')).length,0);
});
for(const [name,edit] of [
  ['backward product timestamp',raw=>{raw.updatedAt='2026-09-29T00:00:00Z';}],
  ['media alt with timestamp',raw=>{raw.updatedAt='2026-09-30T17:00:09Z';raw.media.nodes[1].alt='merchant edit';}],
  ['media updatedAt with timestamp',raw=>{raw.updatedAt='2026-09-30T17:00:09Z';raw.media.nodes[1].updatedAt='2026-09-30T17:00:08Z';}],
]) test(`associate never sends on ${name}`,async()=>{
  const f=fixture('associate');edit(f.raw);
  await assert.rejects(f.run(),/MEDIA_TRANSPORT_CHANGED_BEFORE_CALL/);assert.equal(f.calls.filter(c=>!c.query.startsWith('query ')).length,0);
});
