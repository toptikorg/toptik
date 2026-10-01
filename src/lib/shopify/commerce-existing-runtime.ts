import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyAdminGraphql } from "./admin-api";
import { fingerprint } from "./commerce-finalization";
import { commercialPublicationMode } from "./commerce-mode";
import { commerceCode } from "./commerce-runtime";
import { boundCommerceEditSchema, boundCommerceIdentitySchema, planBoundCommerceEdit, type BoundCommerceIdentity } from "./commerce-existing";
import { readBoundCommerce } from "./commerce-existing-read";

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function signal(deadline: number) { const left = deadline - Date.now(); if (left <= 0) throw new Error("FINALIZE_TIME_BUDGET"); return AbortSignal.timeout(Math.min(3000, Math.floor(left))); }
async function rpc(db: SupabaseClient, name: string, args: Record<string, unknown>, deadline: number) {
  const { data, error } = await db.rpc(name, args).abortSignal(signal(deadline));
  if (error) throw new Error(commerceCode(new Error(error.message))); return data;
}
async function identity(db: SupabaseClient, itemId: string, deadline: number): Promise<BoundCommerceIdentity> {
  return boundCommerceIdentitySchema.parse(await rpc(db, "read_bound_commerce_identity", { p_item_id: itemId }, deadline));
}
export async function readExistingCommerce(db: SupabaseClient, itemId: string, deadline = Date.now() + 12000) {
  const approved = await identity(db, itemId, deadline), snapshot = await readBoundCommerce(approved, Math.min(deadline, Date.now() + 6000));
  const { data: pending, error } = await db.from("shopify_gallery_commerce_commands").select("id,expected_hash,patch").eq("item_id", itemId).eq("state", "pending").abortSignal(signal(deadline)).maybeSingle();
  if (error) throw new Error("FINALIZE_DATABASE_UNCONFIRMED");
  return { enabled: Boolean(commercialPublicationMode(process.env)), snapshot, expectedHash: fingerprint(snapshot),
    pending: pending ? { id: pending.id, itemId, expectedHash: pending.expected_hash, patch: pending.patch } : null };
}
/** Same command ID is readback-only on recovery. Native Shopify mutations do not
 * offer a remote version precondition: residual simultaneous admin edits are detected
 * afterward, and are never compensated by sending an entire older product snapshot. */
export async function editExistingCommerce(db: SupabaseClient, raw: unknown, actorId: string, deadline = Date.now() + 40000) {
  if (!commercialPublicationMode(process.env)) throw new Error("FINALIZE_NOT_ENABLED");
  const edit = boundCommerceEditSchema.parse(raw), owner = randomUUID(), end = Math.min(deadline, Date.now() + 40000);
  const approved = await identity(db, edit.itemId, end), releaseAt = end, workEnd = end - 3000;
  let acquired = false;
  try {
    if (workEnd - Date.now() < 27000) throw new Error("FINALIZE_TIME_BUDGET");
    if (await rpc(db, "acquire_shopify_reconciliation_lease", { p_product_gid: approved.productGid, p_owner: owner }, workEnd) !== true) throw new Error("FINALIZE_EDIT_BUSY");
    acquired = true;
    const { data: prior, error } = await db.from("shopify_gallery_commerce_commands").select("*").eq("id", edit.id).abortSignal(signal(workEnd)).maybeSingle();
    if (error) throw new Error("FINALIZE_DATABASE_UNCONFIRMED");
    if (prior && (prior.item_id !== edit.itemId || prior.expected_hash !== edit.expectedHash || fingerprint(prior.patch) !== fingerprint(edit.patch))) throw new Error("FINALIZE_EDIT_REQUEST_REUSED");
    if (prior?.state === "confirmed" || prior?.state === "review") return { id: edit.id, status: prior.state, snapshot: prior.readback };
    if (prior) {
      const observed = await readBoundCommerce(approved, Math.min(workEnd - 3000, Date.now() + 6000));
      const ack = await rpc(db, "ack_bound_commerce_edit", { p_id: edit.id, p_owner: owner, p_readback: observed, p_observed_at: new Date().toISOString() }, workEnd);
      return { id: edit.id, status: ack.state, snapshot: observed }; // Absolutely no redispatch.
    }
    const current = await readBoundCommerce(approved, Math.min(workEnd - 18000, Date.now() + 6000));
    if (fingerprint(current) !== edit.expectedHash) throw new Error("FINALIZE_EDIT_STALE");
    const plan = planBoundCommerceEdit(current, edit.patch);
    if (fingerprint(plan.patch) !== fingerprint(edit.patch)) throw new Error("FINALIZE_EDIT_UNCHANGED_FIELDS");
    if (workEnd - Date.now() < 18000) throw new Error("FINALIZE_TIME_BUDGET");
    const staged = await rpc(db, "stage_bound_commerce_edit", { p_id: edit.id, p_item_id: edit.itemId, p_actor: actorId, p_owner: owner,
      p_expected_hash: edit.expectedHash, p_baseline: current, p_patch: plan.patch, p_observed_at: new Date().toISOString() }, workEnd - 15000);
    if (!staged || fingerprint(staged.request) !== fingerprint(plan.request)) throw new Error("FINALIZE_EDIT_COMMAND_INVALID");
    const request = await rpc(db, "dispatch_bound_commerce_edit", { p_id: edit.id, p_owner: owner }, workEnd - 12000);
    if (fingerprint(request) !== fingerprint(plan.request)) throw new Error("FINALIZE_EDIT_COMMAND_INVALID");
    // The dispatch is durable. Every exception below stays pending until explicit readback.
    try {
      const result = await shopifyAdminGraphql<Record<string, unknown>>(request.query, request.variables, 6000, Math.min(workEnd - 9000, Date.now() + 6000));
      const payload = result[request.payload];
      if (!object(payload) || !Array.isArray(payload.userErrors) || payload.userErrors.length) throw new Error("FINALIZE_EDIT_RESPONSE_UNCERTAIN");
      const observed = await readBoundCommerce(approved, Math.min(workEnd - 3000, Date.now() + 6000));
      const ack = await rpc(db, "ack_bound_commerce_edit", { p_id: edit.id, p_owner: owner, p_readback: observed, p_observed_at: new Date().toISOString() }, workEnd);
      return { id: edit.id, status: ack.state, snapshot: observed };
    } catch { return { id: edit.id, status: "pending", code: "FINALIZE_EDIT_READBACK_REQUIRED" }; }
  } finally { if (acquired) try { await rpc(db, "release_shopify_reconciliation_lease", { p_product_gid: approved.productGid, p_owner: owner }, releaseAt); } catch { /* owned lease expires */ } }
}
