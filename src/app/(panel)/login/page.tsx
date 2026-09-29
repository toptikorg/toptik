import Image from "next/image";
import { redirect } from "next/navigation";
import { getPanelAccess } from "@/lib/admin/authz";
import { LoginClient } from "@/components/admin/LoginClient";
import { LogoutButton } from "@/components/admin/LogoutButton";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Only an authorized admin goes on to the dashboard. A signed-in account
  // without a panel role stays here (no redirect loop, no service-role read).
  const { user, role } = await getPanelAccess();
  if (role) redirect("/dashboard");

  const { error } = await searchParams;
  const initialError = error === "link" ? "הקישור פג תוקף או שאינו תקין. נסו שוב." : undefined;

  return (
    <main className="admin-main admin-main--narrow">
      <div className="admin-auth-card">
        <Image src="/toptiklogo.png" alt="TOPTIK" width={380} height={150} className="admin-auth-logo-img" priority />
        <h1 className="admin-auth-title">פאנל הניהול של TOPTIK</h1>
        {user ? (
          <>
            <div className="admin-feedback admin-feedback--error" role="alert">
              לחשבון הזה אין הרשאת ניהול.
            </div>
            <LogoutButton />
          </>
        ) : (
          <>
            <p className="admin-auth-sub">התחברו עם פרטי המנהל שלכם כדי להמשיך.</p>
            <LoginClient initialError={initialError} />
          </>
        )}
      </div>
    </main>
  );
}
