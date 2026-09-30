import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { SourceColorVariant } from "@/lib/catalog-source/types";

// Shared image-ingest helper: download a remote (Mandarina CDN) image and
// re-upload it to the Supabase `carousel-media` bucket, returning the public
// URL. Used by both the catalog import route and the colour warmer so product
// images are never hot-linked from the source.

const DOWNLOAD_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Do NOT advertise image/avif: content-negotiating CDNs (e.g. eMAG/akamai)
  // would then serve AVIF, which the Supabase storage bucket rejects. Ask for
  // jpeg/png/webp only so every source returns a bucket-supported format.
  accept: "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.5",
  referer: "https://mandarinaduck.com/",
};

function extensionFromContentType(contentType: string | null) {
  if (!contentType) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  return "jpg";
}

function extensionFromUrl(url: string) {
  const cleanPath = url.split("?")[0];
  const parts = cleanPath.split(".");
  const ext = parts[parts.length - 1]?.toLowerCase();
  if (!ext) return null;
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  return null;
}

// `pathPrefix` is the storage folder (e.g. `imports/mandarina/<catalog>`); the
// file name is `<NN>-<uuid>.<ext>`.
export async function uploadRemoteImageToStorage(
  pathPrefix: string,
  imageUrl: string,
  index: number,
  referer = DOWNLOAD_HEADERS.referer,
): Promise<string> {
  const sourceRes = await fetch(imageUrl, {
    headers: { ...DOWNLOAD_HEADERS, referer },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!sourceRes.ok) {
    throw new Error(`Failed to download source image (${sourceRes.status})`);
  }
  const contentType = sourceRes.headers.get("content-type");
  if (!contentType?.startsWith("image/")) {
    throw new Error("Source image has unsupported content type");
  }

  const bytes = await sourceRes.arrayBuffer();
  const ext = extensionFromUrl(imageUrl) ?? extensionFromContentType(contentType);
  const filePath = `${pathPrefix.replace(/\/$/, "")}/${String(index + 1).padStart(2, "0")}-${crypto.randomUUID()}.${ext}`;

  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase.storage
    .from("carousel-media")
    .upload(filePath, bytes, { contentType, upsert: false });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from("carousel-media").getPublicUrl(filePath);
  return data.publicUrl;
}

// Re-host each colour variant's FULL gallery (its rotation angles) into the
// bucket, returning handle → [public URLs]. Each colour gets its own subfolder.
// Per-image failures are tolerated; a colour with zero re-hosted images is simply
// absent from the map (and later dropped by toCarouselColors).
export async function uploadVariantGalleries(
  baseFolder: string,
  variants: SourceColorVariant[],
): Promise<Map<string, string[]>> {
  const byHandle = new Map<string, string[]>();
  await Promise.all(
    variants.map(async (variant) => {
      const folder = `${baseFolder.replace(/\/$/, "")}/${variant.handle}`;
      const urls = await Promise.all(
        variant.imageUrls.map(async (imageUrl, index) => {
          try {
            return await uploadRemoteImageToStorage(folder, imageUrl, index);
          } catch {
            return null;
          }
        }),
      );
      const ok = urls.filter((url): url is string => Boolean(url));
      if (ok.length > 0) byHandle.set(variant.handle, ok);
    }),
  );
  return byHandle;
}
