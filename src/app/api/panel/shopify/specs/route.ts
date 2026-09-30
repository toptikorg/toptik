import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminUser } from "@/lib/admin/authz";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { typedSpecSyncEnabled, specRpc, withTypedSpecLease, readTypedState, freshTypedShopify, typedSpecDefinitions,
  initializeTypedSpecs, editTypedSpecs } from "@/lib/shopify/typed-spec-worker";
import { scheduleTypedSpecSync } from "@/lib/shopify/schedule-typed-spec-sync";
export const runtime = "nodejs";
export const maxDuration = 60;
const product = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);
const init = z.object({ action: z.literal("initialize"), productId: product, requestId: z.string().uuid() }).strict();
const patch = z.object({ productId: product, requestId: z.string().uuid(), changes: z.record(z.string(), z.unknown()), versions: z.record(z.string(), z.number().int().positive()) }).strict();
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const code = (error: unknown) => error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_REQUEST_FAILED";
function originOk(request: NextRequest) { return request.headers.get("origin") === new URL(request.url).origin; }
async function body(request: NextRequest) { const raw = await request.text(); if (Buffer.byteLength(raw) > 500_000) throw new Error("SPEC_REQUEST_TOO_LARGE"); return JSON.parse(raw); }
export async function GET(request: NextRequest) {
  const gate = await requireAdminUser(); if (!gate.ok) return gate.response;
  if (!typedSpecSyncEnabled()) return reply({ error: "SPEC_DISABLED" }, 404);
  try {
    const db = createSupabaseServiceRoleClient(), productId = request.nextUrl.searchParams.get("productId");
    if (!productId) return reply({ enabled: true, products: await specRpc(db, "list_toptik_spec_products"), definitions: typedSpecDefinitions() });
    product.parse(productId);
    return await withTypedSpecLease(db, productId, async owner => {
      const state = await readTypedState(db, productId, owner), shop = await freshTypedShopify(state);
      return reply({ enabled: true, definitions: typedSpecDefinitions(), identity: state.identity, initialized: state.fields.length === 19,
        fields: Object.fromEntries(state.fields.map(field => [field.key, { gallery: field.currentGallery, shopify: shop.document.fields[field.key], galleryVersion: field.galleryVersion }])) });
    });
  } catch (error) { return reply({ error: code(error) }, 409); }
}
export async function POST(request: NextRequest) {
  const gate = await requireAdminUser(); if (!gate.ok) return gate.response;
  if (!typedSpecSyncEnabled()) return reply({ error: "SPEC_DISABLED" }, 404);
  if (!originOk(request)) return reply({ error: "SPEC_ORIGIN_REJECTED" }, 403);
  try { const input = init.parse(await body(request)); await initializeTypedSpecs(createSupabaseServiceRoleClient(), input.productId); return reply({ ok: true }); }
  catch (error) { return reply({ error: code(error) }, 409); }
}
export async function PATCH(request: NextRequest) {
  const gate = await requireAdminUser(); if (!gate.ok) return gate.response;
  if (!typedSpecSyncEnabled()) return reply({ error: "SPEC_DISABLED" }, 404);
  if (!originOk(request)) return reply({ error: "SPEC_ORIGIN_REJECTED" }, 403);
  try {
    const input = patch.parse(await body(request)), db = createSupabaseServiceRoleClient();
    const result = await editTypedSpecs(db, input.productId, input.requestId, input.changes, input.versions);
    scheduleTypedSpecSync();
    return reply({ ok: true, queued: true, result });
  } catch (error) { return reply({ error: code(error) }, 409); }
}
