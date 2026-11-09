import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { applyOwnedGalleryEdit, ownedFamilyForItem } from "@/lib/shopify/owned-edit-service";

export const runtime = "nodejs";
export const maxDuration = 60;

// Gallery edits of the Shopify-owned color families (FZT73, QMMM1). The edit is delivered to Shopify
// first and the color cards are rebuilt from Shopify; see owned-edit-service.ts for the contract.
const patchSchema = z.object({
  title: z.string().min(1).max(250).optional(),
  description: z.string().max(50000).optional(),
  descriptionHtml: z.string().max(200000).optional(),
  seoTitle: z.string().min(1).max(512).optional(),
  seoDescription: z.string().min(1).max(5000).optional(),
  coverImageAlt: z.string().min(1).max(512).optional(),
  angles: z.array(z.object({ id: z.string().uuid(), imageAlt: z.string().min(1).max(512) }).strict()).max(20).optional(),
}).strict().refine(patch => Object.keys(patch).length > 0);
const requestSchema = z.object({
  itemId: z.string().uuid(),
  expectedVersion: z.string().datetime({ offset: true }),
  expectedRevision: z.number().int().positive(),
  patch: patchSchema,
}).strict();

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function rpc(db: SupabaseClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(/^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_OWNED_EDIT_FAILED");
  return data;
}

export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request);
  if (denied) return denied;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 600_000) return reply({ error: "SYNC_OWNED_REQUEST_TOO_LARGE" }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return reply({ error: "SYNC_OWNED_REQUEST_INVALID" }, 400); }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return reply({ error: "SYNC_OWNED_REQUEST_INVALID" }, 400);
    const input = parsed.data;
    const family = ownedFamilyForItem(input.itemId);
    if (!family) return reply({ error: "SYNC_OWNED_ITEM_UNKNOWN" }, 404);
    const db = createSupabaseServiceRoleClient();
    const owner = randomUUID();
    // The same product lease the webhook worker holds, so an edit and a rebuild never interleave.
    if (await rpc(db, "acquire_shopify_reconciliation_lease", { p_product_gid: family.productGid, p_owner: owner }) !== true) {
      return reply({ error: "SYNC_RECONCILIATION_BUSY" }, 409);
    }
    try {
      return reply(await applyOwnedGalleryEdit(db, input, owner, Date.now() + 55_000));
    } finally {
      try {
        await rpc(db, "release_shopify_reconciliation_lease", { p_product_gid: family.productGid, p_owner: owner });
      } catch {
        console.error("Owned gallery edit lease release failed");
      }
    }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_OWNED_EDIT_FAILED";
    return reply({ error: code }, 409);
  }
}
