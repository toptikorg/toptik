import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { typedSpecSyncEnabled, withTypedSpecLease, specRpc, initializeTypedSpecsUnderLease, readTypedState } from "@/lib/shopify/typed-spec-worker";
export const runtime = "nodejs";
export const maxDuration = 60;
const schema = z.object({
  productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
  variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  itemId: z.string().uuid(), exactGallerySku: z.string().min(2).max(64), exactShopifySku: z.string().min(2).max(64),
  productHandle: z.string().min(1).max(255), approvalId: z.string().min(1).max(128), evidenceId: z.string().min(1).max(256),
}).strict();
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
/** Explicit private activation; never admits new catalog products or copies legacy measurements. */
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request); if (denied) return denied;
  if (!typedSpecSyncEnabled()) return reply({ error: "SPEC_DISABLED" }, 404);
  try {
    const raw = await request.text(); if (Buffer.byteLength(raw) > 10_000) return reply({ error: "SPEC_REQUEST_TOO_LARGE" }, 413);
    const parsed = schema.safeParse(JSON.parse(raw)); if (!parsed.success) return reply({ error: "SPEC_ACTIVATION_INVALID" }, 400);
    const input = parsed.data, db = createSupabaseServiceRoleClient();
    return await withTypedSpecLease(db, input.productId, async owner => {
      await specRpc(db, "activate_toptik_spec_product", { p_product_gid: input.productId, p_lease_owner: owner,
        p_expected: { itemId: input.itemId, variantId: input.variantId, exactGallerySku: input.exactGallerySku,
          exactShopifySku: input.exactShopifySku, productHandle: input.productHandle },
        p_approval_id: input.approvalId, p_evidence: { evidenceId: input.evidenceId, method: "authenticated_exact_copy_identity" } });
      await initializeTypedSpecsUnderLease(db, input.productId, owner);
      const state = await readTypedState(db, input.productId, owner);
      return reply({ ok: true, initialized: state.fields.length === 19, productId: input.productId, fields: state.fields.length, initialCrossWrites: 0 });
    });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_ACTIVATION_FAILED";
    return reply({ error: code }, 409);
  }
}
