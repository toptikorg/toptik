import Image from "next/image";
import { redirect } from "next/navigation";
import { getPanelAccess } from "@/lib/admin/authz";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { SetupClient } from "@/components/admin/SetupClient";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const { role } = await getPanelAccess();
  if (role) redirect("/dashboard");

  // No service-role read on this public page: the setup token is checked by
  // POST /api/panel/setup, which also refuses once any account exists.
  const envOk = hasSupabaseAdminEnv();

  return (
    <main className="admin-main admin-main--narrow">
      <div className="admin-auth-card">
        <Image src="/toptiklogo.png" alt="TOPTIK" width={380} height={150} className="admin-auth-logo-img" priority />
        <h1 className="admin-auth-title">הקמת מנהל ראשי</h1>
        <p className="admin-auth-sub">
          ברוכים הבאים ל‑TOPTIK Admin. צרו את חשבון המנהל הראשון. לאחר מכן תוכלו להזמין עד שני מנהלים נוספים מתוך הפאנל.
        </p>
        {envOk ? (
          <SetupClient />
        ) : (
          <div className="admin-feedback admin-feedback--info" role="status">
            חיבור ל‑Supabase אינו מוגדר בסביבה זו. הגדירו את משתני הסביבה של Supabase והטוקן כדי להפעיל את ההקמה.
          </div>
        )}
      </div>
    </main>
  );
}
