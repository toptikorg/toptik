import Link from "next/link";
import { requireAdminPage } from "@/lib/admin/authz";
import MediaDiagnosticDownload from "@/components/admin/MediaDiagnosticDownload";

export const dynamic = "force-dynamic";
export const metadata = { title: "אבחון תמונה KL966005 | TopTik", robots: { index: false, follow: false } };
export default async function MediaDiagnosticPage() {
  await requireAdminPage();
  return <main className="admin-main"><Link href="/admin">חזרה לניהול הגלריה</Link>
    <h1 className="admin-title">אבחון תמונה KL966005</h1><MediaDiagnosticDownload /></main>;
}
