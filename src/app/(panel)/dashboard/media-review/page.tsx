import Link from "next/link";
import { requireAdminPage } from "@/lib/admin/authz";
import { getCarouselPayload } from "@/lib/carousel/repository";
import MediaReviewEditor from "@/components/admin/MediaReviewEditor";
export const dynamic = "force-dynamic";
export const metadata = { title: "אישור תמונות לסנכרון | TopTik", robots: { index: false, follow: false } };
export default async function MediaReviewPage() {
  await requireAdminPage();
  const payload = await getCarouselPayload({ includeInactive: true, rawAdmin: true });
  const catalog = payload.items.filter(i => i.shopifyLink).map(i => ({ id: i.id, sku: i.catalogNumber ?? "", title: i.title,
    color: i.color ?? null, variantId: i.shopifyLink!.variantId, handle: i.shopifyLink!.handle }));
  return <main className="admin-main"><Link href="/admin">חזרה לניהול הגלריה</Link>
    <h1 className="admin-title">אישור תמונות לסנכרון</h1><MediaReviewEditor catalog={catalog} /></main>;
}
