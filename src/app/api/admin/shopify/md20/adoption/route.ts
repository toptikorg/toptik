import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { md20SourceProjection, readMd20Snapshot, sameMd20Source } from "@/lib/shopify/variant-source-worker";
import { MD20_PRODUCT_GID, MD20_VARIANTS, exactVariantMedia } from "@/lib/shopify/variant-source-policy";
import { verifyOnboardingImage } from "@/lib/shopify/onboarding-worker";

export const runtime = "nodejs";
export const maxDuration = 60;
const text = z.string().max(250000);
const angle = z.object({angle_key:z.string().max(16),angle_order:z.number().int().min(1).max(20),image_path:text,image_alt:text.nullable()}).strict();
const projection = z.object({title:text,description:text.nullable(),description_html:text.nullable(),seo_title:text.nullable(),seo_description:text.nullable(),
  cover_image_path:text,cover_image_alt:text.nullable(),angles:z.array(angle).min(1).max(20)}).strict();
const outbox = z.object({id:z.string().uuid(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.string().datetime({offset:true}),
  status:z.enum(["pending","processing","review","failed"]),payload:z.record(z.string(),z.unknown()),decision:z.literal("discarded")}).strict();
const entry = z.object({itemId:z.string().uuid(),catalogKey:z.string(),variantGid:z.string(),expectedVersion:z.string().datetime({offset:true}),
  expectedRevision:z.number().int().positive(),before:projection,projection,outbox:z.array(outbox).max(1000)}).strict();
const manifestSchema = z.object({productGid:z.literal(MD20_PRODUCT_GID),action:z.literal("adopt_shopify_source"),entries:z.array(entry).min(1).max(3)}).strict();
const approvalEvidence = z.object({approvedBy:z.literal("Tal"),approvedAt:z.string().datetime({offset:true}),reviewReference:z.string().min(1).max(500)}).strict();
const requestSchema = z.discriminatedUnion("action",[
  z.object({action:z.literal("prepare"),itemIds:z.array(z.string().uuid()).min(1).max(3),discardOutboxIds:z.array(z.string().uuid()).max(1000).default([])}).strict(),
  z.object({action:z.literal("adopt"),approvalId:z.string().uuid(),approvalEvidence,manifestHash:z.string().regex(/^[a-f0-9]{64}$/),manifest:manifestSchema}).strict(),
]);
const reply = (body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
const stable = (value:unknown):string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ?
  `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}` : JSON.stringify(value) ?? "undefined";
async function rpc(db:SupabaseClient,name:string,args:Record<string,unknown>) {
  const {data,error}=await db.rpc(name,args);
  if(error)throw new Error(/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:"SYNC_MD20_ADOPTION_FAILED");
  return data;
}
async function lease<T>(db:SupabaseClient,action:(owner:string)=>Promise<T>):Promise<T> {
  const owner=randomUUID();
  if(await rpc(db,"acquire_shopify_reconciliation_lease",{p_product_gid:MD20_PRODUCT_GID,p_owner:owner})!==true)throw new Error("SYNC_RECONCILIATION_BUSY");
  try{return await action(owner);}finally{try{await rpc(db,"release_shopify_reconciliation_lease",{p_product_gid:MD20_PRODUCT_GID,p_owner:owner});}catch{console.error("MD20 adoption lease release failed");}}
}

/** Admin-only review and explicit adoption; ordinary sync never invokes this. */
export async function POST(request:NextRequest) {
  const denied=requireAdminToken(request);if(denied)return denied;
  try {
    const raw=await request.text();if(Buffer.byteLength(raw)>1500000)return reply({error:"SYNC_MD20_REQUEST_TOO_LARGE"},413);
    const parsed=requestSchema.safeParse(JSON.parse(raw));if(!parsed.success)return reply({error:"SYNC_MD20_REQUEST_INVALID"},400);
    const input=parsed.data,db=createSupabaseServiceRoleClient(),deadline=Date.now()+55000;
    if(input.action==="adopt") {
      const actualHash=await rpc(db,"fingerprint_md20_adoption_manifest",{p_manifest:input.manifest});
      if(actualHash!==input.manifestHash)throw new Error("SYNC_MD20_MANIFEST_MISMATCH");
      const prior=await rpc(db,"read_md20_adoption_receipt",{p_approval_id:input.approvalId,p_manifest_hash:input.manifestHash,p_approval_evidence:input.approvalEvidence});
      if(prior)return reply({receipt:prior,replayed:true});
      return await lease(db,async owner=>{
        const source=await readMd20Snapshot(deadline);
        if(!source||source.status!=="ACTIVE"||!source.publishedOnPublication)throw new Error("SYNC_MD20_SOURCE_UNPUBLISHED");
        for(const e of input.manifest.entries) {
          const v=MD20_VARIANTS.find(row=>row.itemId===e.itemId&&row.sku===e.catalogKey&&`gid://shopify/ProductVariant/${row.variantId}`===e.variantGid);
          if(!v||stable(md20SourceProjection(source,v))!==stable(e.projection))throw new Error("SYNC_MD20_SOURCE_CHANGED");
          for(const image of exactVariantMedia(source.media,v.sku))await verifyOnboardingImage(image,deadline);
        }
        if(!sameMd20Source(source,await readMd20Snapshot(deadline)))throw new Error("SYNC_MD20_SOURCE_CHANGED");
        const receipt=await rpc(db,"resolve_md20_source_adoption",{p_product_gid:MD20_PRODUCT_GID,p_owner:owner,p_approval_id:input.approvalId,
          p_manifest:input.manifest,p_expected_hash:input.manifestHash,p_approval_evidence:input.approvalEvidence});
        if(!sameMd20Source(source,await readMd20Snapshot(deadline)))return reply({error:"SYNC_MD20_SOURCE_CHANGED_AFTER_COMMIT",receipt},409);
        return reply({receipt,replayed:false});
      });
    }
    if(new Set(input.itemIds).size!==input.itemIds.length||new Set(input.discardOutboxIds).size!==input.discardOutboxIds.length ||
      input.itemIds.some(id=>!MD20_VARIANTS.some(v=>v.itemId===id)))throw new Error("SYNC_MD20_IDENTITY_INVALID");
    return await lease(db,async()=>{
      const source=await readMd20Snapshot(deadline);
      if(!source||source.status!=="ACTIVE"||!source.publishedOnPublication)throw new Error("SYNC_MD20_SOURCE_UNPUBLISHED");
      const [items,angles,bindings]=await Promise.all([
        db.from("carousel_items").select("*").in("id",input.itemIds),db.from("carousel_item_angles").select("*").in("item_id",input.itemIds),
        db.from("shopify_gallery_bindings").select("catalog_key,carousel_item_id,product_gid,variant_gid,is_published").in("carousel_item_id",input.itemIds),
      ]);
      if(items.error||angles.error||bindings.error||!items.data||!angles.data||!bindings.data)throw new Error("SYNC_VARIANT_GALLERY_READ_FAILED");
      const entries=[];const availableIds=new Set<string>();
      for(const id of input.itemIds){
        const v=MD20_VARIANTS.find(row=>row.itemId===id)!,item=items.data.find(row=>row.id===id);
        const matches=bindings.data.filter(b=>b.carousel_item_id===id);
        if(!item||item.is_active!==true||item.catalog_number!==v.sku||matches.length!==1||matches[0].catalog_key!==v.sku||
          matches[0].product_gid!==MD20_PRODUCT_GID||matches[0].variant_gid!==`gid://shopify/ProductVariant/${v.variantId}`||!matches[0].is_published)
          throw new Error("SYNC_VARIANT_PUBLICATION_BINDING_REQUIRED");
        const before={title:item.title,description:item.description,description_html:item.description_html,seo_title:item.seo_title,seo_description:item.seo_description,
          cover_image_path:item.cover_image_path,cover_image_alt:item.cover_image_alt,angles:angles.data.filter(a=>a.item_id===id)
            .sort((a,b)=>a.angle_order-b.angle_order||a.angle_key.localeCompare(b.angle_key)||a.image_path.localeCompare(b.image_path))
            .map(a=>({angle_key:a.angle_key,angle_order:a.angle_order,image_path:a.image_path,image_alt:a.image_alt}))};
        const pending=await rpc(db,"read_md20_unresolved_outbox",{p_item_id:id});if(!Array.isArray(pending))throw new Error("SYNC_MD20_OUTBOX_INVALID");
        const outbox=pending.map(o=>{availableIds.add(o.id);return {...o,decision:input.discardOutboxIds.includes(o.id)?"discarded":null};});
        entries.push({itemId:id,catalogKey:v.sku,variantGid:`gid://shopify/ProductVariant/${v.variantId}`,
          expectedVersion:item.copy_updated_at,expectedRevision:item.editor_revision,before,projection:md20SourceProjection(source,v),outbox});
      }
      if(input.discardOutboxIds.some(id=>!availableIds.has(id)))throw new Error("SYNC_MD20_OUTBOX_CHANGED");
      if(!sameMd20Source(source,await readMd20Snapshot(deadline)))throw new Error("SYNC_MD20_SOURCE_CHANGED");
      const manifest={productGid:MD20_PRODUCT_GID,action:"adopt_shopify_source",entries};
      const manifestHash=await rpc(db,"fingerprint_md20_adoption_manifest",{p_manifest:manifest});
      return reply({manifest,manifestHash,ready:entries.every(e=>e.outbox.every((o:{decision:string|null})=>o.decision==="discarded")),approved:false});
    });
  }catch(error){const code=error instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:"SYNC_MD20_ADOPTION_FAILED";return reply({error:code},409);}
}
