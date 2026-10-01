"use client";

import { useState } from "react";
import Link from "next/link";
import { createPanelBrowserClient } from "@/lib/admin/supabase-browser";

export function LoginClient({ initialError, returnTo = "/dashboard" }: { initialError?: string; returnTo?: "/dashboard" | "/admin" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const supabase = createPanelBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        setError("אימייל או סיסמה שגויים.");
        setBusy(false);
        return;
      }
      // Full navigation so the server renders with the fresh session cookie.
      window.location.assign(returnTo);
    } catch {
      setError("שגיאת התחברות. נסו שוב.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error && (
        <div className="admin-feedback admin-feedback--error" role="alert">
          {error}
        </div>
      )}

      <div className="admin-field">
        <label className="admin-label" htmlFor="login-email">
          כתובת מייל
        </label>
        <input
          id="login-email"
          className="admin-input"
          type="email"
          dir="ltr"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@toptik.co.il"
          required
        />
      </div>

      <div className="admin-field">
        <label className="admin-label" htmlFor="login-password">
          סיסמה
        </label>
        <input
          id="login-password"
          className="admin-input"
          type="password"
          dir="ltr"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />
      </div>

      <button type="submit" className="admin-btn admin-btn--primary admin-btn--block" disabled={busy}>
        {busy && <span className="admin-spin" />}
        כניסה
      </button>

      <div style={{ textAlign: "center", marginTop: 18 }}>
        <Link href="/reset" className="admin-link">
          שכחתי סיסמה
        </Link>
      </div>
    </form>
  );
}
