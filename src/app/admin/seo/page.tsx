import type { Metadata } from "next";
import EditorialEditor from "./EditorialEditor";
export const metadata: Metadata = { title: "ניהול תוכן ו־SEO | טופ תיק", robots: { index: false, follow: false } };
export default function Page() { return <EditorialEditor />; }
