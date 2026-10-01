import {fingerprint,nextDisposition,type MerchantIntent,type Plan,type State} from './commerce-finalization';
import type {FinalizationPorts,StoredFinalization} from './commerce-worker';

type Result={data:unknown;error:null|{message?:string}};
export interface CommercialRpcClient {
 rpc(name:string,args:Record<string,unknown>):{abortSignal(signal:AbortSignal):PromiseLike<Result>};
}
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const code=(error:null|{message?:string})=>error?.message&&/^(FINALIZE_|SYNC_CREATION_)[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'FINALIZE_DATABASE_UNCONFIRMED';
function record(value:unknown,id:string):StoredFinalization {
 if(!object(value)||value.id!==id||!object(value.plan)||!object(value.state)||!Object.hasOwn(value,'boundReceipt'))throw new Error('FINALIZE_DATABASE_INVALID');
 const parsed=value as StoredFinalization;nextDisposition(parsed.plan,parsed.state);return parsed;
}
/** Concrete Supabase RPC bridge. Only construct with an existing service-role
 * client inside authenticated server code; no browser-provided proof/state. */
export function commercialDatabase(client:CommercialRpcClient,now=Date.now){
 async function call(name:string,args:Record<string,unknown>,deadline:number){
  const remaining=deadline-now();if(!Number.isFinite(remaining)||remaining<=0)throw new Error('FINALIZE_TIME_BUDGET');
  const result=await client.rpc(name,args).abortSignal(AbortSignal.timeout(Math.max(1,Math.min(3000,Math.floor(remaining)))));
  if(result.error)throw new Error(code(result.error));
  // Even an accepted request can outlive its response budget. Do not treat that
  // uncertainty as authorization to dispatch a subsequent external mutation.
  if(now()>=deadline)throw new Error('FINALIZE_TIME_BUDGET');
  return result.data;
 }
 return {
  async saveMerchant(intent:MerchantIntent,expectedRevision:string|null,deadline:number){
   const value=await call('save_gallery_creation_commerce',{p_intent:intent,p_expected_revision:expectedRevision},deadline);
   // JSONB key order differs, so use the policy's canonical representation.
   if(fingerprint(value)!==fingerprint(intent))throw new Error('FINALIZE_DATABASE_INVALID');return intent;
  },
  async reserve(plan:Plan,state:State,owner:string,deadline:number){return record(await call('reserve_gallery_commercial_finalization',{p_plan:plan,p_state:state,p_owner:owner},deadline),plan.intent.galleryItemId);},
  async claim(id:string,owner:string,deadline:number){const value=await call('claim_gallery_commercial_finalization',{p_id:id,p_owner:owner,p_seconds:60},deadline);return value===null?null:record(value,id);},
  async save(previous:StoredFinalization,owner:string,next:State,deadline:number){return record(await call('save_gallery_commercial_finalization',{
   p_id:previous.id,p_owner:owner,p_expected_version:previous.state.version,p_state:next,p_observed_at:new Date(now()).toISOString()},deadline),previous.id);},
  async assertDispatch(previous:StoredFinalization,owner:string,deadline:number):Promise<true>{
   if(await call('dispatch_gallery_commercial_finalization',{p_id:previous.id,p_owner:owner,p_expected_version:previous.state.version},deadline)!==true)throw new Error('FINALIZE_DISPATCH_AUTHORIZATION_FAILED');return true;
  },
  async finalize(previous:StoredFinalization,owner:string,payload:Parameters<FinalizationPorts['finalize']>[2],deadline:number){
   const value=await call('finalize_gallery_shopify_public_creation',{p_request:payload.args,p_owner:owner},deadline);
   if(!object(value)||typeof value.receiptId!=='string'||value.productGid!==previous.plan.initial.identity.productGid||value.variantGid!==previous.plan.initial.identity.variantGid)throw new Error('FINALIZE_DATABASE_INVALID');
   return value as {receiptId:string;productGid:string;variantGid:string};
  },
  async release(id:string,owner:string,deadline:number){await call('release_gallery_shopify_draft',{p_id:id,p_owner:owner},deadline);},
 };
}
