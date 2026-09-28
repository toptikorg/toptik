import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs";
// Cache responses on the Vercel edge essentially forever — each unique source URL
// is trimmed exactly once. Storage objects are content-addressed (per upload UUID),
// so the URL changes when the image changes.
export const revalidate = false;

const ALLOWED_HOSTNAME_SUFFIX = ".supabase.co";
const ALLOWED_PATH_PREFIX = "/storage/v1/object/public/";

const CACHE_HEADERS: HeadersInit = {
  "cache-control": "public, max-age=31536000, s-maxage=31536000, immutable",
};

export async function GET(req: NextRequest) {
  const sourceUrlRaw = req.nextUrl.searchParams.get("u");
  if (!sourceUrlRaw) {
    return NextResponse.json({ error: "missing u" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(sourceUrlRaw);
  } catch {
    return NextResponse.json({ error: "invalid u" }, { status: 400 });
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.endsWith(ALLOWED_HOSTNAME_SUFFIX) ||
    !parsed.pathname.startsWith(ALLOWED_PATH_PREFIX)
  ) {
    return NextResponse.json({ error: "forbidden host" }, { status: 403 });
  }

  // Optional target width. We resize to this BEFORE trim/encode so sharp works
  // on a small buffer (decode+encode of the full-res source is the dominant
  // cost), and this is ALSO the final served width — callers render the result
  // directly via <Image unoptimized>, so there is no second optimizer/AVIF pass.
  const widthRaw = req.nextUrl.searchParams.get("w");
  const targetWidth = widthRaw
    ? Math.min(Math.max(Number.parseInt(widthRaw, 10) || 0, 64), 2048)
    : null;

  let sourceBytes: Buffer;
  try {
    const res = await fetch(parsed.toString(), {
      cache: "no-store",
      headers: { accept: "image/*" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `source ${res.status}` }, { status: 502, headers: { "cache-control": "no-store" } });
    }
    sourceBytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    const message = error instanceof Error ? error.message : "fetch failed";
    return NextResponse.json({ error: message }, { status: 502, headers: { "cache-control": "no-store" } });
  }

  try {
    // Threshold 12 removes the flat near-white background WITHOUT eating into
    // light/cream products (which sit only ~15-35 levels off pure white).
    // Resize first (when a width is requested) so trim+encode run on far fewer
    // pixels — this is the single most expensive step in the request.
    const base = targetWidth
      ? sharp(sourceBytes).resize({ width: targetWidth, withoutEnlargement: true })
      : sharp(sourceBytes);
    const { data: trimmed, info } = await base
      .trim({ threshold: 12 })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    // Keep the tight crop so EVERY colour fills the frame consistently. A product
    // photographed small inside a large white canvas yields a small-but-valid
    // crop that MUST be kept — gating on area ratio (the old behaviour) returned
    // the un-cropped original for those variants, so they showed up small and
    // off-centre next to colours whose source filled the canvas. Only fall back
    // when the crop is DEGENERATE (a near-empty sliver = trim ate a white product).
    const degenerate =
      info.width < 32 ||
      info.height < 32 ||
      info.width / info.height > 4 ||
      info.height / info.width > 4;
    if (!degenerate) {
      return new NextResponse(new Uint8Array(trimmed), {
        headers: { ...CACHE_HEADERS, "content-type": "image/webp" },
      });
    }

    const originalBase = targetWidth
      ? sharp(sourceBytes).resize({ width: targetWidth, withoutEnlargement: true })
      : sharp(sourceBytes);
    const original = await originalBase.webp({ quality: 82 }).toBuffer();
    return new NextResponse(new Uint8Array(original), {
      headers: { ...CACHE_HEADERS, "content-type": "image/webp" },
    });
  } catch {
    // A crop failure can still use the same photo without trimming. Decode and
    // re-encode it: never cache an HTML/error body as a successful WebP image.
    try {
      const fallback = targetWidth
        ? sharp(sourceBytes).resize({ width: targetWidth, withoutEnlargement: true })
        : sharp(sourceBytes);
      const validImage = await fallback.webp({ quality: 82 }).toBuffer();
      return new NextResponse(new Uint8Array(validImage), {
        headers: { ...CACHE_HEADERS, "content-type": "image/webp" },
      });
    } catch {
      return NextResponse.json({ error: "invalid source image" }, {
        status: 502,
        headers: { "cache-control": "no-store" },
      });
    }
  }
}
