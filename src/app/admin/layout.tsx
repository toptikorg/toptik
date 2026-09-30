import type { ReactNode } from "react";
import type { Metadata } from "next";

// Render /admin fresh on every request so its HTML never points at client chunks
// from a previous deployment.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
