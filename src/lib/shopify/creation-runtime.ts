import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPrivateAddress } from "@/lib/catalog-source/source-allowlist";
import { approvedCreationImageUrl, CREATION_SHOP, parseGalleryCreationDraft, readyGalleryCreationDraft,
  type DecodedCreationImage, type DraftMediaReadback, type GalleryCreationDraft, type GalleryCreationReceipt,
  type OwnedDraftSnapshot, type ReadyGalleryDraft } from "./creation-policy";
import { configureGalleryDraftVariant, createGalleryShopifyDraft, fetchCreationVariantIdentities, lookupCreatedGalleryDraft, readCreationShopConfiguration } from "./creation-admin-api";
import { runGalleryDraftCreation, type CreationWorkerPorts, type GalleryCreationRecord } from "./creation-worker";

/** A Preview must never create drafts against the shared live store. */
export function galleryDraftCreationMode(): "draft_only" | undefined {
  return process.env.VERCEL_ENV === "production" && process.env.SHOPIFY_GALLERY_CREATE_MODE === "draft_only" ? "draft_only" : undefined;
}
function timeLeft(deadline: number): number {
  const value = deadline - Date.now() - 2500;
  if (value <= 0) throw new Error("SYNC_CREATION_TIME_BUDGET");
  return Math.min(5000, value);
}
function safeCode(error: { message: string } | null, fallback: string) {
  return error && /^SYNC_CREATION_[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : fallback;
}

/** Bounded decode of allowlisted image bytes. No redirects, storage writes or thumbnails. */
export async function decodeCreationImage(url: string, deadline: number) {
  if (!approvedCreationImageUrl(url)) throw new Error("SYNC_CREATION_MEDIA_INVALID");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([lookup(new URL(url).hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("SYNC_CREATION_TIME_BUDGET")), timeLeft(deadline)); })]);
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error("SYNC_CREATION_IMAGE_HOST_UNSAFE");
  } finally { if (timer) clearTimeout(timer); }
  const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeLeft(deadline)), headers: { accept: "image/*" } });
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 8388608) {
    await response.body?.cancel(); throw new Error("SYNC_CREATION_IMAGE_UNAVAILABLE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SYNC_CREATION_IMAGE_UNAVAILABLE");
  const chunks: Uint8Array[] = []; let byteLength = 0;
  try {
    while (true) {
      timeLeft(deadline); const { done, value } = await reader.read(); if (done) break;
      byteLength += value.byteLength; if (byteLength > 8388608) throw new Error("SYNC_CREATION_IMAGE_TOO_LARGE"); chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (!byteLength) throw new Error("SYNC_CREATION_IMAGE_UNAVAILABLE");
  const bytes = Buffer.concat(chunks);
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: 16000000 }).timeout({ seconds: Math.max(1, Math.ceil(timeLeft(deadline) / 1000)) });
    const meta = await image.metadata();
    const formats: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    const mime = meta.format === "heif" && meta.compression === "av1" ? "image/avif" : formats[meta.format ?? ""];
    if (!mime || !meta.width || !meta.height || meta.width > 16000 || meta.height > 16000 || meta.width * meta.height > 16000000) throw new Error("SYNC_CREATION_IMAGE_DECODE_FAILED");
    await image.raw().toBuffer();
    return { url, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength, width: meta.width, height: meta.height, mime, verifiedAt: new Date().toISOString() };
  } catch { throw new Error("SYNC_CREATION_IMAGE_DECODE_FAILED"); }
}
async function galleryCatalog(supabase: SupabaseClient, deadline: number) {
  const rows: Array<{ id: string; catalogNumber: string | null; isActive: boolean }> = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const { data, error } = await supabase.from("carousel_items").select("id,catalog_number,is_active").order("id").range(offset, offset + 999)
      .abortSignal(AbortSignal.timeout(timeLeft(deadline)));
    if (error) throw new Error("SYNC_CREATION_GALLERY_READ_FAILED");
    rows.push(...(data ?? []).map(row => ({ id: row.id, catalogNumber: row.catalog_number, isActive: row.is_active })));
    if ((data?.length ?? 0) < 1000) return rows;
  }
  throw new Error("SYNC_CREATION_CATALOG_LIMIT");
}
async function imageProof(source: GalleryCreationDraft, deadline: number): Promise<DecodedCreationImage[]> {
  const images: DecodedCreationImage[] = [];
  for (let i = 0; i < source.media.length; i += 3) {
    images.push(...await Promise.all(source.media.slice(i, i + 3).map(async item => ({ ...await decodeCreationImage(item.url, deadline),
      galleryItemId: source.galleryItemId, exactSku: source.shopifySku }))));
  }
  return images;
}
export async function prepareGalleryDraft(supabase: SupabaseClient, source: GalleryCreationDraft, deadline: number,
  recovery?: { receipt: GalleryCreationReceipt; snapshot: OwnedDraftSnapshot }): Promise<ReadyGalleryDraft> {
  const mode = galleryDraftCreationMode();
  if (!mode) throw new Error("SYNC_CREATION_NOT_ENABLED");
  const [config, variants, gallery, images] = await Promise.all([readCreationShopConfiguration(deadline),
    fetchCreationVariantIdentities(deadline), galleryCatalog(supabase, deadline), imageProof(source, deadline)]);
  return readyGalleryCreationDraft(source, { mode, now: Date.now(), shopDomain: CREATION_SHOP, shopCurrency: config.currency,
    expectedAppNamespace: config.namespace, definition: config.definition, catalog: { complete: true, capturedAt: new Date().toISOString(), gallery,
      shopify: variants }, images, recovery });
}

export async function reserveGalleryDraft(supabase: SupabaseClient, input: unknown): Promise<GalleryCreationRecord> {
  if (!galleryDraftCreationMode()) throw new Error("SYNC_CREATION_NOT_ENABLED");
  const draft = parseGalleryCreationDraft(input);
  const { data, error } = await supabase.rpc("reserve_gallery_shopify_draft", { p_draft: draft });
  if (error || !data?.id) throw new Error(safeCode(error, "SYNC_CREATION_RESERVATION_FAILED"));
  return data;
}

export async function runPersistedGalleryDraft(supabase: SupabaseClient, id: string) {
  const deadline = Date.now() + 45000, owner = randomUUID();
  const ports: CreationWorkerPorts = {
    mode: galleryDraftCreationMode(), now: Date.now,
    beforeWrite: () => { if (deadline - Date.now() < 15000) throw new Error("SYNC_CREATION_TIME_BUDGET"); },
    claim: async (itemId, leaseOwner) => {
      const { data, error } = await supabase.rpc("claim_gallery_shopify_draft", { p_id: itemId, p_owner: leaseOwner, p_seconds: 60 });
      if (error) throw new Error(safeCode(error, "SYNC_CREATION_CLAIM_FAILED")); return data;
    },
    advance: async (record, leaseOwner, patch) => {
      timeLeft(deadline);
      const { data, error } = await supabase.rpc("advance_gallery_shopify_draft", { p_id: record.id, p_owner: leaseOwner,
        p_expected_version: record.version, p_expected_stage: record.stage, p_patch: patch });
      if (error || !data?.id) throw new Error(safeCode(error, "SYNC_CREATION_TRANSACTION_FAILED")); return data;
    },
    release: async (itemId, leaseOwner) => { await supabase.rpc("release_gallery_shopify_draft", { p_id: itemId, p_owner: leaseOwner }); },
    recordFailure: async (itemId, leaseOwner, code) => {
      const { error } = await supabase.rpc("record_gallery_shopify_draft_error", { p_id: itemId, p_owner: leaseOwner, p_error: code });
      if (error) throw new Error("SYNC_CREATION_DIAGNOSTIC_FAILED");
    },
    prepare: (source, recovery) => prepareGalleryDraft(supabase, source, deadline, recovery),
    lookup: async ready => (await lookupCreatedGalleryDraft(ready, deadline))?.snapshot ?? null,
    create: ready => createGalleryShopifyDraft(ready, deadline),
    configure: variables => configureGalleryDraftVariant(variables, deadline),
    media: async (ready, snapshot) => {
      const readback = await lookupCreatedGalleryDraft(ready, deadline);
      if (!readback || JSON.stringify(readback.snapshot) !== JSON.stringify(snapshot)) throw new Error("SYNC_CREATION_DRAFT_VERSION_CHANGED");
      if (readback.media.some(item => item.status !== "READY" || !item.image)) throw new Error("SYNC_CREATION_MEDIA_PENDING");
      const media: DraftMediaReadback[] = [];
      for (let i = 0; i < readback.media.length; i += 3) {
        media.push(...await Promise.all(readback.media.slice(i, i + 3).map(async item => ({ ...await decodeCreationImage(item.image!.url, deadline),
          productGid: snapshot.productGid, mediaGid: item.id, status: item.status, alt: item.alt ?? "" }))));
      }
      return media;
    },
  };
  return runGalleryDraftCreation(id, owner, ports);
}
