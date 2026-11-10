import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GroupMediaBinding, GroupMediaSnapshot } from "./group-media-policy";
import type { OwnedMediaCommand, OwnedMediaManifest, OwnedMediaPlan } from "./owned-media-plan";
import { ownedMediaBinding } from "./owned-media-plan";
import type { OwnedCard } from "./owned-edit-plan";

export type OwnedMediaProjectionEntry = { itemId:string;catalogKey:string;variantGid:string;expectedVersion:string;expectedRevision:number;projection:OwnedCard };
export type OwnedMediaOperationStatus = "prepared"|"running"|"uncertain"|"review"|"verified"|"cancelled";
export type OwnedMediaPhaseStatus = "prepared"|"started"|"uncertain"|"verified"|"review";
export type OwnedMediaActor = { actorType:"session_admin"|"admin_token"|"system";actorId:string };
export type OwnedMediaRegistryCard = { itemId:string;catalogKey:string;expectedVersion:string;expectedRevision:number;isActive:boolean;projection:OwnedCard };
export type OwnedMediaOperation = { id:string;productGid:string;status:OwnedMediaOperationStatus;mapVersion:number;sourceFingerprint:string;
  command:OwnedMediaCommand;plan:OwnedMediaPlan;phases:Record<string,unknown>[];nextPhase:number;cursor:GroupMediaSnapshot;
  attempts:Record<string,unknown>[];artifacts:Record<string,unknown>[];expectedCards:OwnedMediaRegistryCard[] };
export type OwnedMediaRegistryContext = { registered:boolean;binding:GroupMediaBinding;mapVersion:number;sourceFingerprint:string|null;
  manifest:OwnedMediaManifest|null;snapshot:GroupMediaSnapshot|null;cards:OwnedMediaRegistryCard[];operation:OwnedMediaOperation|null;schemaAvailable?:boolean };
type Db=Pick<SupabaseClient,"rpc">;
async function call<T>(db:Db,name:string,args:Record<string,unknown>,deadline:number):Promise<T> {
  if(!Number.isFinite(deadline)||Date.now()>=deadline)throw new Error("OWNED_MEDIA_TIME_BUDGET");
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    let request=db.rpc(name,args);if(typeof request.abortSignal==="function")request=request.abortSignal(abort.signal);
    const result=await Promise.race([Promise.resolve(request),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error("OWNED_MEDIA_TIME_BUDGET"));},Math.min(8000,deadline-Date.now()));})]);
    if(result.error){
      const code=String(result.error.message??"");
      if(name==="read_toptik_owned_media_registry"&&["PGRST202","42883"].includes(String(result.error.code))&&code.includes(name))throw new Error("OWNED_MEDIA_SCHEMA_NOT_INSTALLED");
      throw new Error(/^(OWNED_MEDIA_|GROUP_MEDIA_|SYNC_)[A-Z0-9_]{1,90}$/.test(code)?code:"OWNED_MEDIA_RPC_FAILED");
    }
    if(result.data===null||typeof result.data!=="object"||Array.isArray(result.data))throw new Error("OWNED_MEDIA_RPC_INVALID");
    return result.data as T;
  }finally{if(timer)clearTimeout(timer);}
}
export async function readOwnedMediaRegistry(db:Db,productGid:string,deadline:number){
  try{return await call<OwnedMediaRegistryContext>(db,"read_toptik_owned_media_registry",{p_product_gid:productGid},deadline);}
  catch(error){
    const binding=ownedMediaBinding(productGid);
    if(!(error instanceof Error)||error.message!=="OWNED_MEDIA_SCHEMA_NOT_INSTALLED"||!binding)throw error;
    return {registered:false,schemaAvailable:false,binding,mapVersion:0,sourceFingerprint:null,manifest:null,snapshot:null,cards:[],operation:null};
  }
}
export function adoptOwnedMediaRegistry(db:Db,input:{productGid:string;owner:string;requestId:string;source:GroupMediaSnapshot;manifest:OwnedMediaManifest;
  entries:OwnedMediaProjectionEntry[];approval:Record<string,unknown>},deadline:number){
  return call<OwnedMediaRegistryContext>(db,"adopt_toptik_owned_media_registry",{p_product_gid:input.productGid,p_owner:input.owner,p_request_id:input.requestId,
    p_source:input.source,p_manifest:input.manifest,p_entries:input.entries,p_approval:input.approval},deadline);
}
export function prepareOwnedMediaOperation(db:Db,input:{productGid:string;owner:string;requestId:string;expectedMapVersion:number;expectedSourceFingerprint:string;
  source:GroupMediaSnapshot;command:OwnedMediaCommand;plan:OwnedMediaPlan;phases:Record<string,unknown>[];actor:OwnedMediaActor;
  observedManifest?:OwnedMediaManifest;observedEntries?:OwnedMediaProjectionEntry[]},deadline:number){
  return call<OwnedMediaOperation>(db,"prepare_toptik_owned_media_operation",{p_product_gid:input.productGid,p_owner:input.owner,p_request_id:input.requestId,
    p_expected_map_version:input.expectedMapVersion,p_expected_source_fingerprint:input.expectedSourceFingerprint,p_source:input.source,p_command:input.command,p_plan:input.plan,p_phases:input.phases,p_actor:input.actor,
    p_observed_manifest:input.observedManifest??null,p_observed_entries:input.observedEntries??null},deadline);
}
/** Receipt lookup precedes upload staging and includes terminal operations for lost-response replay. */
export function readOwnedMediaReceipt(db:Db,input:{productGid:string;requestId:string},deadline:number){
  return call<{binding:GroupMediaBinding;operation:OwnedMediaOperation|null}>(db,"read_toptik_owned_media_receipt",{p_product_gid:input.productGid,p_request_id:input.requestId},deadline);
}
export function readOwnedMediaOperation(db:Db,input:{productGid:string;operationId:string;phaseIndex:number;owner:string},deadline:number){
  return call<Record<string,unknown>>(db,"read_toptik_owned_media_operation",{p_product_gid:input.productGid,p_owner:input.owner,p_operation_id:input.operationId,p_phase_index:input.phaseIndex},deadline);
}
export function recordOwnedMediaPhase(db:Db,input:{productGid:string;owner:string;operationId:string;phaseIndex:number;attemptId:string;
  action:"begin"|"ack"|"uncertain"|"recovered"|"review";requestHash:string;requestJson:Record<string,unknown>;observedGraph?:GroupMediaSnapshot;artifact?:Record<string,unknown>},deadline:number){
  return call<{status:OwnedMediaPhaseStatus;mayExecute:boolean;leaseExpiresAt:string}>(db,"record_toptik_owned_media_phase",{p_product_gid:input.productGid,p_owner:input.owner,p_operation_id:input.operationId,
    p_phase_index:input.phaseIndex,p_attempt_id:input.attemptId,p_action:input.action,p_request_hash:input.requestHash,p_request_json:input.requestJson,p_observed_graph:input.observedGraph??null,p_artifact:input.artifact??null},deadline);
}
export function commitOwnedMediaOperation(db:Db,input:{productGid:string;owner:string;operationId:string;source:GroupMediaSnapshot;manifest:OwnedMediaManifest;entries:OwnedMediaProjectionEntry[]},deadline:number){
  return call<OwnedMediaRegistryContext>(db,"commit_toptik_owned_media_operation",{p_product_gid:input.productGid,p_owner:input.owner,p_operation_id:input.operationId,p_source:input.source,p_manifest:input.manifest,p_entries:input.entries},deadline);
}
/** Native observation only. No external mutation. New unassigned images are rejected by the manifest validator. */
export function applyOwnedMediaSourceProjection(db:Db,input:{productGid:string;owner:string;requestId:string;expectedMapVersion:number;source:GroupMediaSnapshot;manifest:OwnedMediaManifest;entries:OwnedMediaProjectionEntry[]},deadline:number){
  return call<OwnedMediaRegistryContext>(db,"apply_toptik_owned_media_source_projection",{p_product_gid:input.productGid,p_owner:input.owner,p_request_id:input.requestId,p_expected_map_version:input.expectedMapVersion,
    p_source:input.source,p_manifest:input.manifest,p_entries:input.entries},deadline);
}
export function cancelOwnedMediaOperation(db:Db,input:{productGid:string;owner:string;operationId:string;source:GroupMediaSnapshot},deadline:number){
  return call<OwnedMediaOperation>(db,"cancel_toptik_owned_media_operation",{p_product_gid:input.productGid,p_owner:input.owner,p_operation_id:input.operationId,p_source:input.source},deadline);
}
