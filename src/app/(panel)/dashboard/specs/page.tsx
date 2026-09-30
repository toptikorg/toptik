import { requireAdminPage } from "@/lib/admin/authz";
import TypedSpecsEditor from "./typed-specs-editor";
export const dynamic = "force-dynamic";
export const metadata = { title: "מפרט מוצרים | TopTik", robots: { index: false, follow: false } };
export default async function TypedSpecsPage() {
  await requireAdminPage();
  return <TypedSpecsEditor />;
}
