import { NextResponse, type NextRequest } from "next/server";
import { authorizeGalleryAdmin } from "@/lib/admin/gallery-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { parseMediaDiagnosticInput, readKl966005DiagnosticBytes } from "@/lib/shopify/media-diagnostic";

export const runtime = "nodejs";
export const maxDuration = 60;
// Preserve the existing diagnostic's configuration. This does NOT reproduce historical iad1.
export const preferredRegion = "syd1";
const privateHeaders = { "Cache-Control": "no-store, private, max-age=0", Pragma: "no-cache",
  Vary: "Cookie, X-Admin-Token", "X-Content-Type-Options": "nosniff" };
const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers: privateHeaders });

/** Explicit fixed-product read-only export; never registers, enqueues or persists a capture. */
export async function POST(request: NextRequest) {
  const auth = await authorizeGalleryAdmin(request, { sessionMutation: true });
  if (!auth.ok) {
    for (const [key, value] of Object.entries(privateHeaders)) auth.response.headers.set(key, value);
    return auth.response;
  }
  const deadline = Date.now() + 35000;
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return reply({ error: "MEDIA_DIAGNOSTIC_INPUT_INVALID" }, 415);
    }
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024)) return reply({ error: "MEDIA_DIAGNOSTIC_INPUT_LIMIT" }, 413);
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "MEDIA_DIAGNOSTIC_INPUT_INVALID" }, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error("MEDIA_DIAGNOSTIC_TIME_BUDGET");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("MEDIA_DIAGNOSTIC_TIME_BUDGET")), ms);
        })]).finally(() => { if (timer) clearTimeout(timer); });
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024) throw new Error("MEDIA_DIAGNOSTIC_INPUT_LIMIT");
        chunks.push(part.value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("MEDIA_DIAGNOSTIC_INPUT_INVALID"); }
    const input = parseMediaDiagnosticInput(value);
    const result = await readKl966005DiagnosticBytes(createSupabaseServiceRoleClient(), input, deadline);
    const observation = result.metadata.observation;
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" }[observation.mime];
    const commit = /^[a-f0-9]{40,64}$/.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "") ? process.env.VERCEL_GIT_COMMIT_SHA! : "unavailable";
    const region = /^[a-z]{3}[0-9]{1,2}$/.test(process.env.VERCEL_REGION ?? "") ? process.env.VERCEL_REGION! : "unavailable";
    const deployment = /^[a-zA-Z0-9_-]{1,120}$/.test(process.env.VERCEL_DEPLOYMENT_ID ?? "") ? process.env.VERCEL_DEPLOYMENT_ID! : "unavailable";
    const environment = ["production", "preview", "development"].includes(process.env.VERCEL_ENV ?? "") ? process.env.VERCEL_ENV! : "unavailable";
    return new Response(result.bytes, { status: 200, headers: { ...privateHeaders,
      "Content-Type": observation.mime, "Content-Length": String(result.bytes.length),
      "Content-Disposition": `attachment; filename="KL966005-image3-${observation.sha256.slice(0, 12)}.${extension}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-SHA256": observation.sha256, "X-TopTik-Captured-At": result.metadata.observedAt,
      "X-TopTik-Media-Id": result.metadata.native.mediaId, "X-TopTik-Product-Id": result.metadata.identity.productId,
      "X-TopTik-Variant-Id": result.metadata.identity.variantId, "X-TopTik-Native-Fingerprint": result.metadata.native.fingerprint,
      "X-TopTik-Git-Commit": commit, "X-TopTik-Region": region, "X-TopTik-Configured-Region": "syd1",
      "X-TopTik-Deployment-Id": deployment, "X-TopTik-Environment": environment,
      "X-TopTik-Image-Width": String(observation.width), "X-TopTik-Image-Height": String(observation.height),
      "X-TopTik-Node": result.metadata.runtime.node, "X-TopTik-Sharp": result.metadata.runtime.sharp,
      "X-TopTik-Vips": result.metadata.runtime.vips, "X-TopTik-Observation": "new-capture-not-historical-recovery",
      "X-TopTik-Request-Profile": result.metadata.runtime.requestProfile,
    } });
  } catch (error) {
    const code = error instanceof Error && /^(?:MEDIA_DIAGNOSTIC|MEDIA_SOURCE|MEDIA_REVIEW)_[A-Z0-9_]{1,90}$/.test(error.message)
      ? error.message : "MEDIA_DIAGNOSTIC_READ_FAILED";
    return reply({ error: code }, code === "MEDIA_DIAGNOSTIC_INPUT_LIMIT" ? 413 : code.includes("INPUT") || code.includes("INVALID") ? 400 : 409);
  }
}
