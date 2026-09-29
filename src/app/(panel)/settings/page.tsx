import Link from "next/link";
import { requireAdminPage } from "@/lib/admin/authz";
import { AdminTopBar } from "@/components/admin/AdminTopBar";
import { SettingsUsersClient } from "@/components/admin/SettingsUsersClient";
import { VaultLauncher } from "@/components/admin/VaultLauncher";
import { ArrowBackIcon, ServerIcon, ExternalIcon, VercelIcon, GithubIcon } from "@/components/admin/icons";
import { INTERNIC_URL, VERCEL_URL, GITHUB_URL } from "@/lib/admin/config";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, role } = await requireAdminPage();

  return (
    <>
      <AdminTopBar email={user.email ?? null} />
      <main className="admin-main">
        <Link href="/dashboard" className="admin-back">
          <ArrowBackIcon />
          חזרה ללוח הבקרה
        </Link>

        <div className="admin-page-head">
          <p className="admin-eyebrow">הגדרות אדמין</p>
          <h1 className="admin-title">ניהול מנהלים והגדרות</h1>
          <p className="admin-subtitle">נהלו את חשבונות המנהלים והגדרות המערכת.</p>
        </div>

        {/* Admin-user management is owner-only (enforced again by the API). */}
        {role === "owner" ? (
          <SettingsUsersClient currentEmail={user.email ?? null} />
        ) : (
          <div className="admin-feedback admin-feedback--info" role="status">
            ניהול חשבונות המנהלים זמין לבעלים בלבד.
          </div>
        )}

        <div className="admin-grid" style={{ marginTop: 22 }}>
          <a href={INTERNIC_URL} target="_blank" rel="noopener noreferrer" className="admin-tile">
            <span className="admin-tile-icon">
              <ServerIcon />
            </span>
            <span className="admin-tile-body">
              <span className="admin-tile-title">ניהול אחסון ודומיין — internic</span>
              <span className="admin-tile-desc">portal.internic.co.il</span>
            </span>
            <span className="admin-tile-ext">
              <ExternalIcon />
            </span>
          </a>

          <a href={VERCEL_URL} target="_blank" rel="noopener noreferrer" className="admin-tile">
            <span className="admin-tile-icon">
              <VercelIcon />
            </span>
            <span className="admin-tile-body">
              <span className="admin-tile-title">Vercel</span>
              <span className="admin-tile-desc">vercel.com/rordan-ais-projects</span>
            </span>
            <span className="admin-tile-ext">
              <ExternalIcon />
            </span>
          </a>

          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="admin-tile">
            <span className="admin-tile-icon">
              <GithubIcon />
            </span>
            <span className="admin-tile-body">
              <span className="admin-tile-title">קוד בענן — GitHub</span>
              <span className="admin-tile-desc">github.com/Yula-Digital</span>
            </span>
            <span className="admin-tile-ext">
              <ExternalIcon />
            </span>
          </a>

          <VaultLauncher />
        </div>
      </main>
    </>
  );
}
