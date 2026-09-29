import type { Metadata } from "next";
import {
  Italiana,
  Great_Vibes,
  Rubik,
  Playfair_Display,
  Assistant,
  Poppins,
  Heebo,
} from "next/font/google";
import "./globals.css";

const italiana = Italiana({
  subsets: ["latin"],
  variable: "--font-italiana",
  weight: ["400"],
  display: "swap",
});

const greatVibes = Great_Vibes({
  subsets: ["latin"],
  variable: "--font-great-vibes",
  weight: ["400"],
  display: "swap",
});

const rubik = Rubik({
  subsets: ["latin", "hebrew"],
  variable: "--font-rubik",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const assistant = Assistant({
  subsets: ["latin", "hebrew"],
  variable: "--font-assistant",
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

// Used by the carousel "MANDARINA DUCK" wordmark (Poppins) and the
// "קולקציה נבחרת" collection title (Heebo) — per the leather-background design.
const poppins = Poppins({
  subsets: ["latin"],
  variable: "--font-poppins",
  weight: ["500", "600", "700"],
  display: "swap",
});

const heebo = Heebo({
  subsets: ["latin", "hebrew"],
  variable: "--font-heebo",
  weight: ["300", "400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  // Canonical home of the landing page. The apex toptik.co.il was returned to
  // the Shopify store on 2026-06-20; this Vercel app now lives on the
  // `landing` subdomain. See docs/LANDING-SUBDOMAIN.md.
  metadataBase: new URL("https://landing.toptik.co.il"),
  // Site-wide default (GAL-028). The gallery sets its own share metadata in
  // src/app/carousel/page.tsx.
  title: "TopTik | מזוודות, טרולי ותיקי נסיעות",
  description: "מזוודות, טרולי ותיקי נסיעות של TopTik. הכירו את המוצרים לפני שתמשיכו לרכישה באתר TopTik.",
  // Keep the existing site public while content and SEO await release approval.
  robots: { index: false, follow: true },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#fdf8ee",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${italiana.variable} ${greatVibes.variable} ${rubik.variable} ${playfair.variable} ${assistant.variable} ${poppins.variable} ${heebo.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
