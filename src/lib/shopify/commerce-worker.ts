import {beginNextStep,acceptStepReadback,buildFinalizerRequest,nextDisposition,fingerprint,
 type Plan,type State,type Snapshot,type Context,type Request} from './commerce-finalization';

export type StoredFinalization={id:string;plan:Plan;state:State;boundReceipt:null|{receiptId:string;productGid:string;variantGid:string}};
export type WorkerResult={status:'disabled'|'busy'|'budget'|'pending'|'review'|'bound';mutationAttempted:boolean;code?:string};
/** Every database operation is service-only and bounded. SQL must check actual source,
 * exact stored intent/creation revisions and BOTH owned leases atomically. Browser input
 * never implements these ports. A rejected/uncertain save must not lead to dispatch. */
export interface FinalizationPorts {
 mode:'publish_verified_v1'|undefined;
 now():number;
 claim(id:string,owner:string,deadline:number):Promise<StoredFinalization|null>;
 read(record:StoredFinalization,owner:string,deadline:number):Promise<{snapshot:Snapshot;context:Context}>;
 save(record:StoredFinalization,owner:string,next:State,deadline:number):Promise<StoredFinalization>;
 assertDispatch(record:StoredFinalization,owner:string,deadline:number):Promise<true>;
 send(request:Request,deadline:number):Promise<void>;
 finalize(record:StoredFinalization,owner:string,payload:ReturnType<typeof buildFinalizerRequest>,deadline:number):Promise<{receiptId:string;productGid:string;variantGid:string}>;
 release(id:string,owner:string,deadline:number):Promise<void>;
}
function fail(code:string):never{throw new Error(`FINALIZE_${code}`);}
const code=(error:unknown)=>error instanceof Error&&/^FINALIZE_[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'FINALIZE_OPERATION_UNCERTAIN';
function assertRecord(record:StoredFinalization,id:string){
 if(!record||record.id!==id||record.plan.intent.galleryItemId!==id)fail('STORED_IDENTITY_INVALID');
 nextDisposition(record.plan,record.state);
 if(record.boundReceipt&&(!/^[0-9a-f-]{36}$/.test(record.boundReceipt.receiptId)||record.boundReceipt.productGid!==record.plan.initial.identity.productGid||record.boundReceipt.variantGid!==record.plan.initial.identity.variantGid))fail('BOUND_IDENTITY_INVALID');
}
function assertSaved(before:StoredFinalization,after:StoredFinalization,next:State){
 assertRecord(after,before.id);
 if(after.plan.hash!==before.plan.hash||fingerprint(after.state)!==fingerprint(next)||after.boundReceipt!==null)fail('STATE_SAVE_UNCONFIRMED');
}
/** One external mutation maximum per invocation. No built-in network retry.
 * Persisted pending means read-only recovery, including a crash before actual send.
 * Port deadlines are absolute and must include auth acquisition; no late mutation. */
export async function runCommercialFinalization(id:string,owner:string,ports:FinalizationPorts,outerDeadline=ports.now()+40000):Promise<WorkerResult>{
 if(ports.mode!=='publish_verified_v1')return {status:'disabled',mutationAttempted:false};
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner))return {status:'review',mutationAttempted:false,code:'FINALIZE_ID_INVALID'};
 const end=Math.min(outerDeadline,ports.now()+40000),workEnd=end-3000;
 const limit=(milliseconds:number)=>{if(ports.now()>=workEnd)fail('TIME_BUDGET');return Math.min(workEnd,ports.now()+milliseconds);};
 if(workEnd-ports.now()<12000)return {status:'budget',mutationAttempted:false};
 let claimed=false,mutationAttempted=false;
 try{
  let record=await ports.claim(id,owner,limit(3000));if(!record)return {status:'busy',mutationAttempted:false};claimed=true;assertRecord(record,id);
  if(record.boundReceipt)return {status:'bound',mutationAttempted:false};
  const disposition=nextDisposition(record.plan,record.state);if(disposition==='review')return {status:'review',mutationAttempted:false};
  const read=await ports.read(record,owner,limit(8000));
  if(disposition==='readback_only'){
   const next=acceptStepReadback(record.plan,record.state,read.snapshot,read.context),saved=await ports.save(record,owner,next,limit(3000));
   assertSaved(record,saved,next);return {status:next.review?'review':'pending',mutationAttempted:false};
  }
  if(disposition==='finalize_binding'){
   const payload=buildFinalizerRequest(record.plan,record.state,read.snapshot,read.context),receipt=await ports.finalize(record,owner,payload,limit(3000));
   assertRecord({...record,boundReceipt:receipt},id);return {status:'bound',mutationAttempted:false};
  }
  // save <=3s, dispatch guard <=2s, Shopify <=8s, readback <=8s, commit <=3s.
  if(workEnd-ports.now()<24000)return {status:'budget',mutationAttempted:false};
  const started=beginNextStep(record.plan,record.state,read.snapshot,read.context),saved=await ports.save(record,owner,started.state,limit(3000));
  assertSaved(record,saved,started.state);record=saved;
  if(workEnd-ports.now()<21000)fail('TIME_BUDGET');
  if(await ports.assertDispatch(record,owner,limit(2000))!==true)fail('DISPATCH_AUTHORIZATION_FAILED');
  if(workEnd-ports.now()<19000)fail('TIME_BUDGET');
  mutationAttempted=true;
  // Any transport failure is uncertain. Recovery reads the durable pending command;
  // even a known userError never becomes an automatic mutation retry.
  try{await ports.send(started.request,limit(8000));}catch{return {status:'pending',mutationAttempted:true,code:'FINALIZE_MUTATION_RESPONSE_UNCERTAIN'};}
  const observed=await ports.read(record,owner,limit(8000)),next=acceptStepReadback(record.plan,record.state,observed.snapshot,observed.context);
  const acknowledged=await ports.save(record,owner,next,limit(3000));assertSaved(record,acknowledged,next);
  return {status:next.review?'review':'pending',mutationAttempted};
 }catch(error){return {status:code(error)==='FINALIZE_TIME_BUDGET'?'budget':'pending',mutationAttempted,code:code(error)};}
 finally{if(claimed)try{await ports.release(id,owner,Math.min(end,ports.now()+3000));}catch{/* Durable expiry remains authoritative. No mutation retry. */}}
}
