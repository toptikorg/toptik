import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { supabaseEnv } from "@/lib/supabase/env";
import type { MediaIdentity } from "./media-sync-core";
import type { ReviewedMediaEntry } from "./reviewed-media-guard";
import { reviewEntry, reviewIdentity, reviewPath, signMediaReview, verifyMediaReview, type MediaReviewRecord } from "./reviewed-media-record";

const BUCKET = "toptik-media-reviews";
const MAX_BYTES = 16 * 1024;
const missing = (e: unknown) => {
  if (!e || typeof e !== "object" || !("statusCode" in e)) return false;
  if (["404", "NoSuchBucket", "NoSuchKey"].includes(String(e.statusCode))) return true;
  return String(e.statusCode) === "400" && "message" in e && e.message === "Bucket not found";
};
const key = () => { const value = supabaseEnv.serviceRoleKey; if (!value || value.length < 32) throw new Error("MEDIA_REVIEW_SIGNING_UNAVAILABLE"); return value; };
async function bounded<T>(run: () => PromiseLike<T>, deadline: number): Promise<T> {
  const ms = Math.min(5000, deadline - Date.now()); if (!Number.isFinite(deadline) || ms <= 0) throw new Error("MEDIA_REVIEW_TIME_BUDGET");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve(run()), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("MEDIA_REVIEW_TIME_BUDGET")), ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function readRecord(path: string, identity: MediaIdentity | null, deadline: number): Promise<MediaReviewRecord> {
  const { data, error } = await bounded(() => createSupabaseServiceRoleClient().storage.from(BUCKET).download(path), deadline);
  if (error || !data || data.size > MAX_BYTES) throw new Error("MEDIA_REVIEW_STORAGE_READ_FAILED");
  const input = JSON.parse(await data.text());
  const record = verifyMediaReview(input, identity ?? reviewIdentity(input?.record?.identity), key());
  if (reviewPath(record) !== path) throw new Error("MEDIA_REVIEW_RECORD_INVALID");
  return record;
}
/** Exact identity prefix only. Private storage, signed records, no browser-owned
 * JSON or filename/alt inference. A missing registry grants zero approvals. */
export async function loadReviewedMedia(identity: MediaIdentity, deadline: number): Promise<ReviewedMediaEntry[]> {
  const expected = reviewIdentity(identity);
  const records = await loadItemReviews(expected.itemId, deadline);
  return records.filter(r => JSON.stringify(r.identity) === JSON.stringify(expected)).map(reviewEntry);
}
async function loadItemReviews(itemId: string, deadline: number): Promise<MediaReviewRecord[]> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(itemId)) throw new Error("MEDIA_REVIEW_RECORD_INVALID");
  const prefix = "v1/" + itemId;
  const { data, error } = await bounded(() => createSupabaseServiceRoleClient().storage.from(BUCKET).list(prefix, { limit: 251, sortBy: { column: "name", order: "asc" } }), deadline);
  if (missing(error)) return [];
  if (error || !data || data.length > 250) throw new Error("MEDIA_REVIEW_STORAGE_READ_FAILED");
  const result: MediaReviewRecord[] = [];
  for (const file of data) {
    if (!/^[a-f0-9]{64}\.json$/.test(file.name)) throw new Error("MEDIA_REVIEW_RECORD_INVALID");
    const record = await readRecord(prefix + "/" + file.name, null, deadline);
    if (record.identity.itemId !== itemId) throw new Error("MEDIA_REVIEW_RECORD_INVALID");
    result.push(record);
  }
  return result;
}
/** Admin guard only requests changed-media item IDs and still verifies current
 * SKU/variant binding. Signed evidence for an old binding cannot authorize it. */
export async function loadReviewedMediaForItems(itemIds: string[], deadline: number): Promise<ReviewedMediaEntry[]> {
  if (!Array.isArray(itemIds) || itemIds.length > 500) throw new Error("MEDIA_REVIEW_RECORD_INVALID");
  const entries: ReviewedMediaEntry[] = [];
  for (const id of new Set(itemIds)) entries.push(...(await loadItemReviews(id, deadline)).map(reviewEntry));
  return entries;
}
/** Idempotent immutable registration. The only caller first checks admin role,
 * exact current gallery binding, READY single-variant Shopify media and bytes. */
export async function saveReviewedMedia(record: MediaReviewRecord, deadline: number) {
  const signed = signMediaReview(record, key()), path = reviewPath(record), storage = createSupabaseServiceRoleClient().storage;
  const existing = await bounded(() => storage.getBucket(BUCKET), deadline);
  if (existing.error && !missing(existing.error)) throw new Error("MEDIA_REVIEW_STORAGE_READ_FAILED");
  if (!existing.data) {
    const created = await bounded(() => storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES, allowedMimeTypes: ["application/json"] }), deadline);
    if (created.error) {
      const raced = await bounded(() => storage.getBucket(BUCKET), deadline);
      if (raced.error || !raced.data || raced.data.public) throw new Error("MEDIA_REVIEW_STORAGE_UNAVAILABLE");
    }
  } else if (existing.data.public) throw new Error("MEDIA_REVIEW_STORAGE_NOT_PRIVATE");
  const body = JSON.stringify(signed);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("MEDIA_REVIEW_RECORD_INVALID");
  const uploaded = await bounded(() => storage.from(BUCKET).upload(path, body, { contentType: "application/json", upsert: false }), deadline);
  // A simultaneous or repeated approval can only reuse the same exact tuple.
  // Every result, including a successful upload, is read back and signature checked.
  const stored = await readRecord(path, record.identity, deadline);
  if (stored.mediaId !== record.mediaId || stored.imageUrl !== record.imageUrl || stored.decodedSha256 !== record.decodedSha256) throw new Error("MEDIA_REVIEW_RECORD_INVALID");
  return { registered: true, replayed: Boolean(uploaded.error), mediaId: stored.mediaId, decodedSha256: stored.decodedSha256 };
}
