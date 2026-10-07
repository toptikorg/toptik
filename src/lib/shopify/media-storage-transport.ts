import { MAX_EXISTING_MEDIA_PIXELS } from "./existing-media-limits";
import "server-only";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import sharp from "sharp";
import { isPrivateAddress } from "@/lib/catalog-source/source-allowlist";
import { hasSupabaseAdminEnv, supabaseEnv } from "@/lib/supabase/env";
import type { StagedMediaSource } from "./media-transport-requests";
import { stagedMediaUrl } from "./media-transport-requests";
import { MediaStorageFailure, type MediaStorageStage } from "./media-storage-diagnostics";

const ORIGIN = "https://ekgpaoavsavrtbhlbwdg.supabase.co";
const PREFIX = `${ORIGIN}/storage/v1/object/public/carousel-media/`;
const MAX_BYTES = 8 * 1024 * 1024;
type Decoded = { sha256: string; byteLength: number; width: number; height: number; mime: StagedMediaSource["mime"] };
function fail(code: string): never { throw new Error(code); }
function remaining(deadline: number) {
  if (!Number.isFinite(deadline) || deadline <= Date.now()) fail("MEDIA_STORAGE_TIME_BUDGET");
  return Math.min(10000, deadline - Date.now());
}
function expectedSource(source: StagedMediaSource) {
  if (!source || source.url !== stagedMediaUrl(source.identity, source.contentSha256, source.mime) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(source.receiptId) ||
      !Number.isInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > MAX_BYTES ||
      !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1 ||
      source.width > 16000 || source.height > 16000 || source.width * source.height > MAX_EXISTING_MEDIA_PIXELS) fail("MEDIA_STORAGE_SOURCE_INVALID");
  return source.url.slice(PREFIX.length);
}
async function decode(bytes: Uint8Array, deadline: number): Promise<Decoded> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) fail("MEDIA_STORAGE_BYTE_LIMIT");
  const buffer = Buffer.from(bytes);
  try {
    const decoder = sharp(buffer, { failOn: "error", limitInputPixels: MAX_EXISTING_MEDIA_PIXELS })
      .timeout({ seconds: Math.max(1, Math.ceil(remaining(deadline) / 1000)) });
    const metadata = await decoder.metadata();
    const formats = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
    const mime = metadata.format === "heif" && metadata.compression === "av1" ? "image/avif" : formats[metadata.format as keyof typeof formats];
    if (!mime || !metadata.width || !metadata.height || metadata.width > 16000 || metadata.height > 16000 ||
        metadata.width * metadata.height > MAX_EXISTING_MEDIA_PIXELS || (metadata.pages ?? 1) !== 1) fail("MEDIA_STORAGE_FORMAT_INVALID");
    await decoder.resize({ width: 64, height: 64, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    remaining(deadline);
    return { mime, width: metadata.width, height: metadata.height, byteLength: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex") };
  } catch { fail("MEDIA_STORAGE_DECODE_FAILED"); }
}
function matches(source: StagedMediaSource, actual: Decoded) {
  if (source.contentSha256 !== actual.sha256 || source.mime !== actual.mime || source.byteLength !== actual.byteLength ||
      source.width !== actual.width || source.height !== actual.height) fail("MEDIA_STORAGE_BYTES_CHANGED");
}
async function publicDns(deadline: number) {
  remaining(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([lookup(new URL(ORIGIN).hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MEDIA_STORAGE_TIME_BUDGET")), remaining(deadline)); })]);
    if (!addresses.length || addresses.some(address => isPrivateAddress(address.address))) fail("MEDIA_STORAGE_DNS_UNSAFE");
  } finally { if (timer) clearTimeout(timer); }
}

/** Cheap deterministic checks run before consuming a one-shot mutation permit. */
export function assertImmutableMediaUploadPreflight(source: StagedMediaSource, deadline: number): void {
  remaining(deadline);
  expectedSource(source);
  if (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") fail("MEDIA_STORAGE_DISABLED");
  // Match the SDK's whitespace normalization, while retaining the exact pinned project.
  if (!hasSupabaseAdminEnv() || supabaseEnv.publicUrl?.trim().replace(/\/$/, "") !== ORIGIN) fail("MEDIA_STORAGE_CONFIGURATION_INVALID");
  // The repository bucket permits JPEG/PNG/WebP. AVIF requires a separately
  // verified live bucket capability; don't silently transcode or change policy.
  if (source.mime === "image/avif") fail("MEDIA_STORAGE_MIME_NOT_ENABLED");
}

/** Call only after durable one-shot stage_source/gallery_upload permission. No retry or overwrite. */
export async function uploadImmutableMedia(source: StagedMediaSource, bytes: Uint8Array, deadline: number): Promise<{ outcome: "accepted" }> {
  let stage: MediaStorageStage = "preflight";
  let httpStatus: number | null = null;
  try {
  source = structuredClone(source);
  assertImmutableMediaUploadPreflight(source, deadline);
  const path = expectedSource(source);
  const uploadBytes = new Uint8Array(bytes); // Caller mutation cannot change bytes after verification.
  stage = "decode";
  matches(source, await decode(uploadBytes, deadline));
  stage = "dns";
  await publicDns(deadline);
  const key = supabaseEnv.serviceRoleKey!;
  let response: Response;
  stage = "upload";
  try {
    response = await fetch(`${ORIGIN}/storage/v1/object/carousel-media/${path}`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(remaining(deadline)),
      // Opaque secret keys authenticate through apikey, not a JWT Bearer token.
      // Keep the legacy service_role header while both key types are supported.
      headers: { apikey: key, ...(key.startsWith("sb_secret_") ? {} : { authorization: `Bearer ${key}` }),
        "content-type": source.mime, "cache-control": "max-age=31536000", "x-upsert": "false" },
      body: uploadBytes,
    });
  } catch { fail("MEDIA_STORAGE_UPLOAD_UNCONFIRMED"); }
  httpStatus = response.status;
  await response.body?.cancel().catch(() => {});
  if (!response.ok) fail("MEDIA_STORAGE_UPLOAD_UNCONFIRMED");
  remaining(deadline);
  return { outcome: "accepted" }; // Only independent GET/decode can establish the artifact.
  } catch (error) { throw new MediaStorageFailure(error, stage, httpStatus); }
}

/** Recovery is read-only, including an existing path after an accepted-but-lost upload response. */
export async function readImmutableMedia(source: StagedMediaSource, deadline: number): Promise<Decoded & { url: string; storagePath: string }> {
  source = structuredClone(source);
  remaining(deadline);
  const storagePath = expectedSource(source);
  await publicDns(deadline);
  let response: Response;
  try { response = await fetch(source.url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(remaining(deadline)) }); }
  catch { fail("MEDIA_STORAGE_READ_FAILED"); }
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {}); fail("MEDIA_STORAGE_READ_FAILED");
  }
  const reader = response.body?.getReader();
  if (!reader) fail("MEDIA_STORAGE_READ_FAILED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      remaining(deadline);
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) fail("MEDIA_STORAGE_BYTE_LIMIT");
      chunks.push(chunk.value);
    }
  } catch { await reader.cancel().catch(() => {}); fail("MEDIA_STORAGE_READ_FAILED"); }
  const actual = await decode(Buffer.concat(chunks), deadline);
  matches(source, actual);
  return { ...actual, url: source.url, storagePath };
}
