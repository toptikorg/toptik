import type { Metadata } from "next";
import Link from "next/link";
import { AccessibilityStatement } from "@/components/AccessibilityStatement";
import { AccessibilityWidget } from "@/components/AccessibilityWidget";

export const metadata: Metadata = {
  title: "הצהרת נגישות | גלריית טופ תיק",
  description: "אמצעי נגישות ועזרה ברורה לגלישה בגלריה ובמגזין של טופ תיק בטלפון ובמחשב.",
  alternates: { canonical: "/accessibility" },
};

export default function AccessibilityPage() {
  return <main id="main-content" className="accessibility-page" dir="rtl">
    <nav aria-label="ניווט ראשי"><Link href="/carousel">לגלריית המוצרים</Link><Link href="/journal">למגזין</Link><Link href="/">לדף הבית</Link></nav>
    <h1>הצהרת נגישות</h1>
    <AccessibilityStatement />
    <AccessibilityWidget />
  </main>;
}
