import type { MetadataRoute } from "next";
import { getPublicCatalog } from "@/lib/carousel/public-catalog";
import { SHOWROOM_ORIGIN, showroomPath } from "@/lib/carousel/editorial";
export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const payload = await getPublicCatalog();
  return [{ url: SHOWROOM_ORIGIN + "/carousel" }, ...payload.items.filter(i => i.editorial?.indexable).map(i => ({
    url: SHOWROOM_ORIGIN + showroomPath(i.id), images: i.coverImagePath ? [i.coverImagePath] : [],
  }))];
}
