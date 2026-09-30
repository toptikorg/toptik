import "server-only";
import type { CarouselItem } from "@/lib/carousel/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { overlayTypedSpecs, type PublicTypedSpecs } from "./typed-spec-display";
export async function applyPublicTypedSpecs(items: CarouselItem[]): Promise<CarouselItem[]> {
  if (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_TYPED_SPEC_SYNC !== "enabled_v1") return items;
  const { data, error } = await createSupabaseServerClient().rpc("public_toptik_typed_specs");
  if (error || !Array.isArray(data)) { console.warn("SPEC_PUBLIC_PROJECTION_UNAVAILABLE"); return items; }
  const rows = data as PublicTypedSpecs[];
  const byId = new Map(rows.map(row => [row.itemId, row]));
  if (byId.size !== rows.length) throw new Error("SPEC_PUBLIC_IDENTITY_AMBIGUOUS");
  return items.map(item => { const projection = byId.get(item.id); return projection ? overlayTypedSpecs(item, projection) : item; });
}
