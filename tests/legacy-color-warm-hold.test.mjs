import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const source=readFileSync(new URL('../src/app/api/admin/warm-colors/route.ts',import.meta.url),'utf8').replace(/^import[^\n]*;\r?\n/gm,'');
const harness=`
export const effects=[];
const NextResponse={json:(body,options)=>Response.json(body,options)};
const requireAdminToken=req=>req.headers.get('authorization')==='Bearer test-cron' ? null : Response.json({error:'Unauthorized'},{status:401});
const hasSupabaseAdminEnv=()=>true;
const row={id:'legacy',catalog_number:'P10QMT58651',source_url:'https://manufacturer.example/model',cover_image_path:'https://existing.example/cover.jpg',title:'legacy',colors:null};
const createSupabaseServiceRoleClient=()=>{effects.push('database');const q={select(){return q},eq(){return q},order(){return q},update(){effects.push('write');return q},then(resolve){resolve({data:[row],error:null})}};return {from:()=>q}};
const enumerateColorVariants=async()=>{effects.push('manufacturer');return [{handle:'model',imageUrls:['https://source.example/new.jpg']}]};
const enumerateBricsColorVariants=enumerateColorVariants;
const uploadVariantGalleries=async()=>{effects.push('upload');return new Map([['model',['https://storage.example/new-uuid.jpg']]])};
const toCarouselColors=()=>[{catalogNumber:'P10QMT58651',imagePath:'https://storage.example/new-uuid.jpg'}];
const toBricsCarouselColors=toCarouselColors;
const ensureOwnColor=colors=>colors;
const dominantHexFromUrl=async()=>{effects.push('image-download');return '#000000'};
const assertReviewedColorAssignments=()=>{throw Error('MEDIA_REVIEW_REQUIRED')};
`;
const api=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(harness+source)).toString('base64'));
const request=(query='',authorized=true)=>({headers:new Headers(authorized?{authorization:'Bearer test-cron'}:{}),nextUrl:new URL('https://example.test/api/admin/warm-colors'+query)});

for(const method of ['GET','POST'])for(const query of ['', '?force=1','?reset=1','?recolor=1','?thin=1&limit=28']){
 test(`legacy color warmer ${method}${query} holds before storage or catalog side effects`,async()=>{
  api.effects.length=0;
  const response=await api[method](request(query));
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,'MEDIA_REVIEW_REQUIRED');
  assert.deepEqual(api.effects,[],'a held request must not scrape, upload, reset or write');
 });
}
test('legacy color hold preserves authentication before revealing operational state',async()=>{
 api.effects.length=0;
 const response=await api.GET(request('',false));
 assert.equal(response.status,401);
 assert.deepEqual(api.effects,[]);
});
test('held legacy warming is unscheduled while order processing remains scheduled',()=>{
 const {crons}=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
 assert.equal(crons.some(c=>c.path.startsWith('/api/admin/warm-colors')),false);
 for(const path of ['/api/admin/orders/automation','/api/admin/orders/health'])assert.ok(crons.some(c=>c.path===path));
});
