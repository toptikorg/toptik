import { MAX_EXISTING_MEDIA_PIXELS } from "./existing-media-limits";
import "server-only";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPrivateAddress } from "@/lib/catalog-source/source-allowlist";
import { configuredShopifyDomain, fetchAllOnboardingVariantIdentities, fetchPublicOnboardingProductSnapshot, type ShopifyOnboardingSnapshot } from "./admin-api";
import { normalizeSyncSku } from "./sync-rules";
import { approvedShopifyImageUrl, assertOnboardingShopifyUniqueness, MAX_ONBOARDING_IMAGE_BYTES, ONBOARDING_SHOP_DOMAIN,
  onboardingSnapshotFingerprint, PUBLIC_ONBOARDING_POLICY, publicOnboardingCandidate, type OnboardingImageEvidence } from "./onboarding-policy";

function readTimeout(deadline: number): number {
  const remaining = deadline - Date.now() - 3_000;
  if (remaining <= 0) throw new Error("SYNC_ONBOARDING_TIME_BUDGET");
  return Math.min(5_000, remaining);
}

async function publicDns(hostname: string, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("SYNC_ONBOARDING_TIME_BUDGET")), readTimeout(deadline)); })]);
    if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) throw new Error("SYNC_ONBOARDING_IMAGE_HOST_UNSAFE");
  } finally { if (timer) clearTimeout(timer); }
}

/** Decode exact Shopify bytes; no redirects, transformed URL, guessed source or storage write. */
export async function verifyOnboardingImage(media: ShopifyOnboardingSnapshot["media"][number], deadline: number): Promise<OnboardingImageEvidence> {
  const image = media.image;
  const url = image && approvedShopifyImageUrl(image.url);
  if (!image || !url) throw new Error("SYNC_ONBOARDING_MEDIA_IDENTITY_INVALID");
  await publicDns(url.hostname, deadline);
  const response = await fetch(image.url, { redirect: "error", cache: "no-store", headers: { accept: "image/*" }, signal: AbortSignal.timeout(readTimeout(deadline)) });
  if (!response.ok) throw new Error("SYNC_ONBOARDING_IMAGE_UNAVAILABLE");
  if (Number(response.headers.get("content-length") ?? 0) > MAX_ONBOARDING_IMAGE_BYTES) {
    await response.body?.cancel(); throw new Error("SYNC_ONBOARDING_IMAGE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SYNC_ONBOARDING_IMAGE_UNAVAILABLE");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      readTimeout(deadline);
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_ONBOARDING_IMAGE_BYTES) throw new Error("SYNC_ONBOARDING_IMAGE_TOO_LARGE");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (!byteLength) throw new Error("SYNC_ONBOARDING_IMAGE_UNAVAILABLE");
  const bytes = Buffer.concat(chunks);
  let width: number, height: number, mime: string;
  try {
    const decoder = sharp(bytes, { failOn: "error", limitInputPixels: MAX_EXISTING_MEDIA_PIXELS }).timeout({ seconds: Math.max(1, Math.ceil(readTimeout(deadline) / 1000)) });
    const metadata = await decoder.metadata();
    const mimeByFormat: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    mime = metadata.format === "heif" && metadata.compression === "av1" ? "image/avif" : mimeByFormat[metadata.format ?? ""];
    if (!mime || !metadata.width || !metadata.height) throw new Error("Invalid image format");
    width = metadata.width; height = metadata.height;
    await decoder.resize({ width: 64, height: 64, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch { throw new Error("SYNC_ONBOARDING_IMAGE_DECODE_FAILED"); }
  if (width !== image.width || height !== image.height) throw new Error("SYNC_ONBOARDING_IMAGE_DIMENSIONS_CHANGED");
  return { mediaGid: media.id, url: image.url, width, height, mime, byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function galleryIdentityRows(supabase: SupabaseClient, deadline: number) {
  const rows: Array<{ id: string; catalog_number: string | null }> = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const { data, error } = await supabase.from("carousel_items").select("id,catalog_number")
      .order("id").range(offset, offset + 999).abortSignal(AbortSignal.timeout(readTimeout(deadline)));
    if (error) throw new Error("SYNC_ONBOARDING_GALLERY_READ_FAILED");
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) return rows;
  }
  throw new Error("SYNC_ONBOARDING_CATALOG_LIMIT");
}

/** Called only inside the existing product lease; never mutates Shopify. */
export async function ensurePublicShopifyOnboarding(supabase: SupabaseClient,
  input: { eventId: string; productGid: string; leaseOwner: string; deadline?: number }): Promise<boolean> {
  if (process.env.SHOPIFY_SYNC_AUTOCREATE !== "published_shopify") throw new Error("SYNC_ONBOARDING_NOT_ENABLED");
  if (configuredShopifyDomain() !== ONBOARDING_SHOP_DOMAIN) throw new Error("SYNC_ONBOARDING_SHOP_MISMATCH");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(input.eventId) || !uuid.test(input.leaseOwner)) throw new Error("SYNC_ONBOARDING_EVENT_ID_INVALID");
  const deadline = Math.min(input.deadline ?? Infinity, Date.now() + 40_000);
  const product = await fetchPublicOnboardingProductSnapshot(input.productGid, deadline);
  if (!product) throw new Error("SYNC_ONBOARDING_PRODUCT_MISSING");
  if (product.id !== input.productGid) throw new Error("SYNC_ONBOARDING_IDENTITY_INVALID");
  const candidate = publicOnboardingCandidate(product);
  if (!candidate) return false;
  const [variants, gallery] = await Promise.all([fetchAllOnboardingVariantIdentities(deadline), galleryIdentityRows(supabase, deadline)]);
  assertOnboardingShopifyUniqueness(product, variants);
  const galleryMatches = gallery.filter(item => normalizeSyncSku(item.catalog_number) === candidate.catalogKey);
  if (galleryMatches.length) {
    const { data: receipt, error } = await supabase.from("shopify_gallery_product_onboarding_receipts")
      .select("product_gid,variant_gid,catalog_key,carousel_item_id,exact_sku").eq("product_gid", product.id).maybeSingle();
    if (error) throw new Error("SYNC_ONBOARDING_RECEIPT_READ_FAILED");
    if (galleryMatches.length !== 1 || !receipt || receipt.variant_gid !== candidate.variantGid || receipt.catalog_key !== candidate.catalogKey ||
        receipt.carousel_item_id !== galleryMatches[0].id || receipt.exact_sku !== candidate.exactSku || galleryMatches[0].catalog_number !== candidate.exactSku) {
      throw new Error("SYNC_ONBOARDING_GALLERY_SKU_COLLISION");
    }
  }
  const media: OnboardingImageEvidence[] = [];
  // Four bounded read/decode operations at a time; preserve source media order.
  for (let offset = 0; offset < candidate.media.length; offset += 4) {
    readTimeout(deadline);
    media.push(...await Promise.all(candidate.media.slice(offset, offset + 4).map(entry => verifyOnboardingImage(entry, deadline))));
  }
  const [fresh, finalVariants] = await Promise.all([fetchPublicOnboardingProductSnapshot(product.id, deadline), fetchAllOnboardingVariantIdentities(deadline)]);
  if (!fresh || onboardingSnapshotFingerprint(fresh) !== onboardingSnapshotFingerprint(product)) throw new Error("SYNC_ONBOARDING_SOURCE_CHANGED");
  assertOnboardingShopifyUniqueness(fresh, finalVariants);
  readTimeout(deadline);
  const evidence = { policyVersion: PUBLIC_ONBOARDING_POLICY, eventId: input.eventId, productGid: product.id,
    variantGid: candidate.variantGid, exactSku: candidate.exactSku, catalogKey: candidate.catalogKey, handle: product.handle,
    sourceUpdatedAt: product.updatedAt, brandLabel: candidate.brandLabel, category: candidate.category, copy: candidate.copy,
    media, verifiedAt: new Date().toISOString(), shopifyCollisionCount: 1, status: "ACTIVE", publishedOnPublication: true,
    variantCount: 1, shopDomain: ONBOARDING_SHOP_DOMAIN };
  const { data, error } = await supabase.rpc("onboard_public_shopify_product", { p_evidence: evidence, p_lease_owner: input.leaseOwner });
  if (error) throw new Error(/^SYNC_ONBOARDING_[A-Z0-9_]{1,70}$/.test(error.message) ? error.message : "SYNC_ONBOARDING_TRANSACTION_FAILED");
  if (!data || typeof data.itemId !== "string" || data.catalogKey !== candidate.catalogKey || typeof data.approvalId !== "string") {
    throw new Error("SYNC_ONBOARDING_TRANSACTION_RESULT_INVALID");
  }
  return true;
}
