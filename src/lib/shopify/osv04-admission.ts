import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { fetchAllOnboardingVariantIdentities, fetchPublicOnboardingProductSnapshot, shopifyAdminGraphql } from "./admin-api";
import { onboardingSnapshotFingerprint } from "./onboarding-policy";
import { verifyOnboardingImage } from "./onboarding-worker";
import { OSV04_ADMISSION, validateOsv04AdmissionSource } from "./osv04-admission-policy";
import { createMediaTransportRpc } from "./media-transport-rpc";

const COMMERCE_QUERY = `query TopTikApprovedOsv04Commerce {
  shop { myshopifyDomain currencyCode }
  product(id:"gid://shopify/Product/15401872654586") { id variants(first:2) {
    nodes { id sku price inventoryItem { tracked } } pageInfo { hasNextPage }
  } }
}`;
type Dependencies = { client?: Pick<SupabaseClient, "rpc">; product?: typeof fetchPublicOnboardingProductSnapshot;
  variants?: typeof fetchAllOnboardingVariantIdentities; commerce?: (deadline: number) => Promise<unknown>;
  image?: typeof verifyOnboardingImage; transport?: typeof createMediaTransportRpc; now?: () => number };

/** Token-only one-time operator route. No Shopify mutations or Gallery writes.
 * Fresh evidence may only initialize the exact approved existing association. */
export async function admitExistingOsv04(deadline: number, dependencies: Dependencies = {}) {
  if (process.env.VERCEL_ENV !== "production") throw new Error("SYNC_OSV04_PRODUCTION_REQUIRED");
  const now = dependencies.now ?? Date.now, stop = Math.min(deadline, now() + 40000), work = stop - 3000;
  const check = () => { if (!Number.isFinite(deadline) || now() >= work) throw new Error("SYNC_OSV04_TIME_BUDGET"); }; check();
  const db = dependencies.client ?? createSupabaseServiceRoleClient(), rpc = (dependencies.transport ?? createMediaTransportRpc)(OSV04_ADMISSION.productId, { client: db });
  const lease = await rpc.acquire(work); if (!lease) throw new Error("SYNC_OSV04_BUSY");
  async function call(name: string, args: Record<string, unknown>) {
    check(); const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([Promise.resolve(db.rpc(name, args).abortSignal(abort.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error("SYNC_OSV04_TIME_BUDGET")); }, Math.min(5000, work - now()));
      })]); check(); if (!response || response.error) throw response?.error ?? new Error("SYNC_OSV04_RPC_FAILED"); return response.data;
    } catch (e) { const m = e && typeof e === "object" && "message" in e ? String(e.message) : "";
      throw new Error(/^SYNC_OSV04_[A-Z0-9_]{1,80}$/.test(m) ? m : "SYNC_OSV04_RPC_FAILED");
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    if (lease.expiresAt < stop + 5000) throw new Error("SYNC_OSV04_LEASE_TOO_SHORT");
    const initial = await call("read_existing_osv04_admission", { p_lease_owner: lease.owner });
    if (initial?.admitted === true) {
      if (typeof initial.enabled !== "boolean" || initial.itemId !== OSV04_ADMISSION.itemId) throw new Error("SYNC_OSV04_CONTEXT_INVALID");
      return { admitted: true, replayed: true, enabled: initial.enabled, itemId: OSV04_ADMISSION.itemId };
    }
    if (!initial || initial.admitted !== false || !/^[a-f0-9]{64}$/.test(initial.galleryRevision)) throw new Error("SYNC_OSV04_CONTEXT_INVALID");
    const product = dependencies.product ?? fetchPublicOnboardingProductSnapshot, variants = dependencies.variants ?? fetchAllOnboardingVariantIdentities;
    const commerce = dependencies.commerce ?? (d => shopifyAdminGraphql(COMMERCE_QUERY, {}, Math.min(5000, d - now()), d));
    const [p, all, commercial] = await Promise.all([product(OSV04_ADMISSION.productId, work), variants(work), commerce(work)]); check();
    if (!p) throw new Error("SYNC_OSV04_PRODUCT_MISSING"); const copy = validateOsv04AdmissionSource(p, all, commercial);
    const media = [];
    for (let offset = 0; offset < p.media.length; offset += 4) {
      media.push(...await Promise.all(p.media.slice(offset, offset + 4).map(m => (dependencies.image ?? verifyOnboardingImage)(m, work)))); check();
    }
    const [fresh, finalAll, finalCommerce] = await Promise.all([product(OSV04_ADMISSION.productId, work), variants(work), commerce(work)]); check();
    if (!fresh || onboardingSnapshotFingerprint(fresh) !== onboardingSnapshotFingerprint(p) || JSON.stringify(finalCommerce) !== JSON.stringify(commercial)) throw new Error("SYNC_OSV04_SOURCE_CHANGED");
    validateOsv04AdmissionSource(fresh, finalAll, finalCommerce);
    const result = await call("admit_existing_osv04", { p_lease_owner: lease.owner, p_evidence: {
      ...OSV04_ADMISSION, galleryRevision: initial.galleryRevision, sourceUpdatedAt: p.updatedAt, verifiedAt: new Date(now()).toISOString(),
      status: "ACTIVE", publishedOnPublication: true, variantCount: 1, shopifyCollisionCount: 1, inventoryTracked: false,
      vendor: p.vendor, copy, media,
    } });
    if (result?.admitted !== true || result.itemId !== OSV04_ADMISSION.itemId || typeof result.enabled !== "boolean" ||
        typeof result.replayed !== "boolean") throw new Error("SYNC_OSV04_CONTEXT_INVALID");
    return result;
  } finally { try { await rpc.release(lease.owner, Math.min(stop, now() + 2000)); } catch { /* owned lease expiry */ } }
}
