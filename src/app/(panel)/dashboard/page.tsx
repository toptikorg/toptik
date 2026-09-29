import Link from "next/link";
import { requireAdminPage } from "@/lib/admin/authz";
import {
  LANDING_URL,
  GALLERY_EDITOR_URL,
  SHOPIFY_ADMIN_URL,
  WHATSAPP_AGENT_URL,
} from "@/lib/admin/config";
import { AdminTopBar } from "@/components/admin/AdminTopBar";
import {
  SettingsIcon,
  GalleryIcon,
  LandingIcon,
  ShopIcon,
  WhatsappIcon,
  ExternalIcon,
} from "@/components/admin/icons";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { user } = await requireAdminPage();

  return (
    <>
      <AdminTopBar email={user.email ?? null} />
      <main className="admin-main">
        <div className="admin-page-head">
          <p className="admin-eyebrow">לוח בקרה</p>
          <h1 className="admin-title">ברוכים הבאים לפאנל הניהול</h1>
          <p className="admin-subtitle">בחרו את הפעולה שברצונכם לבצע.</p>
        </div>

        <nav className="admin-grid" aria-label="תפריט ניהול">
          <Link href="/settings" className="admin-tile">
            <span className="admin-tile-icon">
              <SettingsIcon />
            </span>
            <span className="admin-tile-body">
              <span className="admin-tile-title">הגדרות אדמין</span>
              <span className="admin-tile-desc">משתמשי מנהל · אחסון ודומיין</span>
            </span>
          </Link>

          <a href={GALLERY_EDITOR_URL} target="_blank" rel="noopener noreferrer" className="admin-tile">
            <span className="admin-tile-icon">
              <GalleryIcon />
            </span>
            <span className="admin-tile-body">
              <span className="admin-tile-title">עדכון גלריית דף הנחיתה</span>
              <span className="admin-tile-desc">landing.toptik.co.il/admin</span>
            </span>
            <span className="admin-tile-ext">
              <ExternalIcon />
            </span>
          </a>

          <a href={LANDING_URL} target="_blank" rel="noopener noreferrer" className="admin-tile">
            <span className="admin-tile-icon">
              <LandingIcon />
            </span>
            <span className="admin-tile-body">
              <span className="admin-tile-title">צפייה בדף הנחיתה</span>
              <span className="admin-tile-desc">landing.toptik.co.il</span>
            </span>
            <span className="admin-tile-ext">
              <ExternalIcon />
            </span>
          </a>

          <a
            href={SHOPIFY_ADMIN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="admin-tile admin-tile--brass"
          >
            <span className="admin-tile-icon">
              <ShopIcon />
            </span>
            <span className="admin-tile-body">
              <span className="admin-tile-title">חנות אונליין שופיפיי אדמין</span>
              <span className="admin-tile-desc">admin.shopify.com</span>
            </span>
            <span className="admin-tile-ext">
              <ExternalIcon />
            </span>
          </a>

          <a
            href={WHATSAPP_AGENT_URL || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="admin-tile"
          >
            <span className="admin-tile-icon">
              <WhatsappIcon />
            </span>
            <span className="admin-tile-body">
              <span className="admin-tile-title">סוכן וואטסאפ AI</span>
              <span className="admin-tile-desc">agent.toptik.co.il</span>
            </span>
            <span className="admin-tile-ext">
              <ExternalIcon />
            </span>
          </a>
        </nav>
      </main>
    </>
  );
}
