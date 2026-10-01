import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const data=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
const mode=data(readFileSync(new URL('../src/lib/shopify/commerce-mode.ts',import.meta.url),'utf8'));
globalThis.__commerceSchedule={};
const source=readFileSync(new URL('../src/lib/shopify/commerce-schedule.ts',import.meta.url),'utf8')
 .replace('import "server-only";','').replace('import { after } from "next/server";','const after=fn=>globalThis.__commerceSchedule.work.push(fn);')
 .replace('import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";','const createSupabaseServiceRoleClient=()=>({});')
 .replace('from "./commerce-mode"',`from ${JSON.stringify(mode)}`)
 .replace('import { runPersistedCommerce } from "./commerce-runtime";','const runPersistedCommerce=(...args)=>globalThis.__commerceSchedule.run(...args);');
const m=await import(data(source)),id='00000000-0000-4000-8000-000000000002';
async function withEnv(fn){const env={...process.env},fetch=globalThis.fetch;process.env.VERCEL_ENV='production';process.env.SHOPIFY_GALLERY_PUBLISH_MODE='publish_verified_v1';process.env.ADMIN_PANEL_TOKEN='local-test-only';
 const state={work:[],calls:[],run:async()=>({continuationNeeded:true})};globalThis.__commerceSchedule=state;globalThis.fetch=async(url,options)=>{state.calls.push({url,options});return{status:202,body:{cancel:async()=>{}}}};
 try{await fn(state)}finally{globalThis.fetch=fetch;for(const key of ['VERCEL_ENV','SHOPIFY_GALLERY_PUBLISH_MODE','ADMIN_PANEL_TOKEN'])if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
test('creation dispatch acknowledges only and never runs a second worker in original request',()=>withEnv(async s=>{
 assert.equal(await m.dispatchCommercialPublication(id),true);assert.equal(s.work.length,0);assert.equal(s.calls.length,1);
 const {url,options}=s.calls[0];assert.equal(url,'https://landing.toptik.co.il/api/admin/shopify/commerce?continue=1');assert.equal(options.redirect,'error');assert.equal(options.headers['x-admin-token'],'local-test-only');assert.deepEqual(JSON.parse(options.body),{itemId:id});
}));
test('scheduled confirmed progress continues once with bounded hop; uncertainty does not chain',()=>withEnv(async s=>{
 m.scheduleCommercialPublication(id,2);await s.work.shift()();assert.equal(s.calls.length,1);assert.match(s.calls[0].url,/continue=3$/);
 s.run=async()=>({continuationNeeded:false,status:'pending',code:'FINALIZE_MUTATION_RESPONSE_UNCERTAIN'});m.scheduleCommercialPublication(id);await s.work.shift()();assert.equal(s.calls.length,1);
}));
test('preview, disabled, missing credential, hop cap and expired deadline never dispatch',()=>withEnv(async s=>{
 process.env.VERCEL_ENV='preview';assert.equal(await m.dispatchCommercialPublication(id),false);m.scheduleCommercialPublication(id);assert.equal(s.work.length,0);process.env.VERCEL_ENV='production';
 for(const hop of [-1,20,99,1.5])assert.equal(await m.dispatchCommercialPublication(id,hop),false);
 assert.equal(await m.dispatchCommercialPublication(id,0,Date.now()-1),false);delete process.env.ADMIN_PANEL_TOKEN;assert.equal(await m.dispatchCommercialPublication(id),false);assert.equal(s.calls.length,0);
}));
