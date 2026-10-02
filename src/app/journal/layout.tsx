import Link from "next/link";
import { AccessibilityWidget } from "@/components/AccessibilityWidget";

export default function JournalLayout({children}: {children: React.ReactNode}) {
  return <>{children}<footer className="accessibility-help-footer"><Link href="/accessibility">הצהרת נגישות ועזרה בגלישה</Link></footer><AccessibilityWidget /></>;
}
