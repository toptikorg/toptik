import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
const code=readFileSync('src/lib/shopify/creation-finalization-read.ts','utf8')
 .replace('import "server-only";','').replace('import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";',
  'const createSupabaseServiceRoleClient=()=>{throw new Error("unexpected default client")};');
const {finalizedCreationIds}=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code)).toString('base64')}`);
function client(reply){const calls=[];return {calls,rpc(name,args){calls.push({name,args});return {abortSignal(signal){assert.ok(signal instanceof AbortSignal);return Promise.resolve(reply(args,calls.length));}};}};}
test('bounded batches return only SQL-joined finalized IDs; private drafts remain outside result',async()=>{
 const ids=Array.from({length:1001},()=>randomUUID()),db=client(args=>({data:{finalizedItemIds:args.p_item_ids.slice(0,1)},error:null}));
 assert.deepEqual([...await finalizedCreationIds(ids,db)],[ids[0],ids[1000]]);
 assert.deepEqual(db.calls.map(c=>c.args.p_item_ids.length),[1000,1]);
 assert.ok(db.calls.every(c=>c.name==='read_finalized_gallery_creation_items'));
});
test('empty input avoids SQL entirely; expired/invalid/duplicate input never dispatches',async()=>{
 const db=client(()=>{throw new Error('unexpected RPC')});assert.equal((await finalizedCreationIds([],db)).size,0);
 const id=randomUUID();for(const ids of [[id,id],['invalid'],[id.toUpperCase()],Array(6001).fill(id)]){
  await assert.rejects(finalizedCreationIds(ids,db),/INPUT_INVALID/);
 }
 await assert.rejects(finalizedCreationIds([id],db,Date.now()-1),/TIME_BUDGET/);assert.equal(db.calls.length,0);
});
test('only positively identified absent additive RPC leaves all drafts private',async()=>{
 for(const code of ['PGRST202','42883']){
  const db=client(()=>({data:null,error:{code,message:'function public.read_finalized_gallery_creation_items was not found'}}));
  assert.equal((await finalizedCreationIds([randomUUID()],db)).size,0);
 }
 const ids=Array.from({length:1001},()=>randomUUID()),db=client((args,n)=>n===1?{data:{finalizedItemIds:[ids[0]]},error:null}
  :{data:null,error:{code:'PGRST202',message:'read_finalized_gallery_creation_items missing'}});
 assert.equal((await finalizedCreationIds(ids,db)).size,0,'mixed deployment never releases partial IDs');
});
test('permissions, generic missing errors, timeout and SQL errors fail closed and mask details',async()=>{
 for(const error of [{code:'42501',message:'secret permission'}, {code:'PGRST202',message:'different_function missing'},
  {code:'42P01',message:'read_finalized_gallery_creation_items'}, {code:'57014',message:'secret timeout'}]){
  await assert.rejects(finalizedCreationIds([randomUUID()],client(()=>({data:null,error}))),error=>error.message==='SYNC_CREATION_FINALIZATION_READ_FAILED');
 }
});
test('malformed/foreign/duplicate SQL results cannot release a reserved row',async()=>{
 const id=randomUUID();for(const data of [null,[],{}, {finalizedItemIds:[randomUUID()]}, {finalizedItemIds:[id,id]},
  {finalizedItemIds:[id],extra:true},{finalizedItemIds:'true'},{finalizedItemIds:[null]}]){
  await assert.rejects(finalizedCreationIds([id],client(()=>({data,error:null}))),/RESULT_INVALID/);
 }
});
