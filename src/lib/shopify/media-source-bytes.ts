import { MAX_EXISTING_MEDIA_PIXELS } from "./existing-media-limits";
import "server-only";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import sharp from "sharp";
import { isPrivateAddress } from "@/lib/catalog-source/source-allowlist";
import type { MediaIdentity } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";
import type { StagedMediaSource } from "./media-transport-requests";

/** Server-loaded immutable provenance. A URL supplied by an editor is not this proof. */
export type MediaSourceBytesProof = { identity: MediaIdentity; evidenceId: string; url: string; sha256: string;
  mime: StagedMediaSource["mime"]; width: number; height: number; byteLength: number };
export type CapturedMediaBytes = { bytes: Uint8Array; sha256: string; mime: StagedMediaSource["mime"]; width: number; height: number; byteLength: number;
  /** Duplicate detection only (see MediaVisuals): 32x32 RGB hex of the decoded pixels, flattened on white, border trimmed. */
  visual: string };
const MAX_BYTES = 8 * 1024 * 1024;
function fail(code: string): never { throw new Error(code); }
function budget(deadline: number) {
  if (!Number.isFinite(deadline) || deadline <= Date.now()) fail("MEDIA_SOURCE_TIME_BUDGET");
  return Math.min(8000, deadline - Date.now());
}
export function assertMediaSourceBytesProof(proof: MediaSourceBytesProof) {
  mediaSnapshotFingerprint({ identity: proof.identity, side: "gallery", revision: "source-proof", complete: true, assets: [] });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(proof.evidenceId) || !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(proof.mime) ||
      !Number.isSafeInteger(proof.byteLength) || proof.byteLength < 1 || proof.byteLength > MAX_BYTES ||
      !Number.isSafeInteger(proof.width) || !Number.isSafeInteger(proof.height) || proof.width < 1 || proof.height < 1 ||
      proof.width > 16000 || proof.height > 16000 || proof.width * proof.height > MAX_EXISTING_MEDIA_PIXELS ||
      typeof proof.url !== "string" || proof.url.length > 4096 || /[\s\\#]/.test(proof.url)) fail("MEDIA_SOURCE_PROOF_INVALID");
  return sourceUrl(proof.identity, proof.url);
}
function sourceUrl(identity: MediaIdentity, value: string) {
  mediaSnapshotFingerprint({ identity, side: "gallery", revision: "source-url", complete: true, assets: [] });
  if (typeof value !== "string" || value.length > 4096 || /[\s\\#]/.test(value)) fail("MEDIA_SOURCE_URL_INVALID");
  let url: URL;
  try { url = new URL(value); } catch { return fail("MEDIA_SOURCE_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || /%(?:2e|2f|5c)/i.test(url.pathname) ||
      !((url.origin === "https://cdn.shopify.com" && url.pathname.startsWith("/s/files/")) ||
        (url.origin === "https://ekgpaoavsavrtbhlbwdg.supabase.co" && url.pathname.startsWith("/storage/v1/object/public/carousel-media/")))) fail("MEDIA_SOURCE_URL_INVALID");
  return url;
}
async function bounded<T>(run: () => Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MEDIA_SOURCE_TIME_BUDGET")), budget(deadline)); })]);
    budget(deadline); return result;
  } finally { if (timer) clearTimeout(timer); }
}
/** GET only, exact URL, no redirect/retry. Pixel decoding and exact bytes are both required. */
export async function readVerifiedMediaSourceBytes(input: MediaSourceBytesProof, deadline: number): Promise<Uint8Array> {
  const proof = structuredClone(input); assertMediaSourceBytesProof(proof);
  return (await capture(proof.identity, proof.url, deadline, proof)).bytes;
}
/** Only server-observed product-bound Shopify media / exact Gallery row URLs
 * may call this. This proves bytes, never product ownership or logical keys. */
export async function captureMediaSourceBytes(identity: MediaIdentity, url: string, deadline: number): Promise<CapturedMediaBytes> {
  return capture(structuredClone(identity), url, deadline);
}
/** Full pixel decode (the decode check this replaces) reduced to an encoding-independent fingerprint:
 * EXIF orientation applied, flatten on white, fit inside 512, then THREE 32x32 RGB framings so one
 * unstable crop cannot hide a duplicate: the white-trimmed frame (contain), the own-background-trimmed
 * frame (fill), and the untrimmed frame (contain). Concatenated as 9216 bytes of hex. Distances are
 * taken per framing and the smallest decides (media-sync-core). Calibrated on live photos 8.10.2026. */
async function visualSignature(decoder: sharp.Sharp): Promise<string> {
  const flat = await decoder.clone().rotate().flatten({ background: "#ffffff" }).resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  type Frame = { data: Buffer; info: sharp.OutputInfo };
  const raw = (frame: Frame) => sharp(frame.data, { raw: { width: frame.info.width, height: frame.info.height, channels: frame.info.channels } });
  const trim = async (options: Parameters<sharp.Sharp["trim"]>[0]): Promise<Frame> => {
    try { return await raw(flat).trim(options).raw().toBuffer({ resolveWithObject: true }); }
    catch { return flat; /* a uniform image has no border to trim */ }
  };
  const parts: Buffer[] = [];
  for (const [frame, fit] of [[await trim({ background: "#ffffff", threshold: 12 }), "contain"], [await trim({ threshold: 12 }), "fill"], [flat, "contain"]] as const) {
    const small = await raw(frame).resize(32, 32, { fit, background: "#ffffff" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    if (small.info.channels !== 3 || small.data.length !== 3072) fail("MEDIA_SOURCE_DECODE_FAILED");
    parts.push(small.data);
  }
  return Buffer.concat(parts).toString("hex");
}
async function capture(identity: MediaIdentity, address: string, deadline: number, proof?: MediaSourceBytesProof): Promise<CapturedMediaBytes> {
  const url = sourceUrl(identity, address), stop = Math.min(deadline, Date.now() + 8000);
  budget(stop);
  const addresses = await bounded(() => lookup(url.hostname, { all: true, verbatim: true }), stop);
  if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) fail("MEDIA_SOURCE_DNS_UNSAFE");
  let response: Response;
  try { response = await bounded(() => fetch(address, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(budget(stop)) }), stop); }
  catch { return fail("MEDIA_SOURCE_READ_FAILED"); }
  // An oversize source is a PERMANENT state of the catalog, not a transient read error: it gets
  // its own code (declared size here, streamed size below) so the queue can park the product for
  // review instead of re-downloading the same unchanged files on every batch.
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {}); fail("MEDIA_SOURCE_BYTE_LIMIT");
  }
  if (!response.ok || response.redirected || (response.url && response.url !== address)) {
    await response.body?.cancel().catch(() => {}); fail("MEDIA_SOURCE_READ_FAILED");
  }
  const reader = response.body?.getReader(); if (!reader) fail("MEDIA_SOURCE_READ_FAILED");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const chunk = await bounded(() => reader.read(), stop); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > MAX_BYTES || (proof && size > proof.byteLength)) fail("MEDIA_SOURCE_BYTE_LIMIT"); chunks.push(chunk.value); }
  } catch { await reader.cancel().catch(() => {}); return fail("MEDIA_SOURCE_READ_FAILED"); }
  const bytes = Buffer.concat(chunks);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (proof && (bytes.byteLength !== proof.byteLength || sha256 !== proof.sha256)) fail("MEDIA_SOURCE_BYTES_CHANGED");
  try {
    const decoder = sharp(bytes, { failOn: "error", limitInputPixels: MAX_EXISTING_MEDIA_PIXELS }).timeout({ seconds: Math.max(1, Math.ceil(budget(stop) / 1000)) });
    const metadata = await bounded(() => decoder.metadata(), stop);
    const formats = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
    const mime = metadata.format === "heif" && metadata.compression === "av1" ? "image/avif" : formats[metadata.format as keyof typeof formats];
    if (!mime || !metadata.width || !metadata.height || metadata.width > 16000 || metadata.height > 16000 ||
        metadata.width * metadata.height > MAX_EXISTING_MEDIA_PIXELS || (metadata.pages ?? 1) !== 1 ||
        (proof && (mime !== proof.mime || metadata.width !== proof.width || metadata.height !== proof.height))) fail("MEDIA_SOURCE_DECODE_CHANGED");
    const visual = await bounded(() => visualSignature(decoder), stop);
    budget(stop); return { bytes: new Uint8Array(bytes), sha256, mime, width: metadata.width, height: metadata.height, byteLength: bytes.length, visual };
  } catch { return fail("MEDIA_SOURCE_DECODE_FAILED"); }
}
