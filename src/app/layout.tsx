import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { GalleryAnalytics } from "@/components/GalleryAnalytics";

const italiana = localFont({
  src: "./fonts/Italiana-Regular.woff2",
  variable: "--font-italiana",
  weight: "400",
  display: "swap",
});

const greatVibes = localFont({
  src: "./fonts/GreatVibes-Regular.woff2",
  variable: "--font-great-vibes",
  weight: "400",
  display: "swap",
});

const rubik = localFont({
  src: "./fonts/Rubik[wght].woff2",
  variable: "--font-rubik",
  weight: "400 700",
  display: "swap",
});

const playfair = localFont({
  src: "./fonts/PlayfairDisplay[wght].woff2",
  variable: "--font-playfair",
  weight: "400 700",
  display: "swap",
});

const assistant = localFont({
  src: "./fonts/Assistant[wght].woff2",
  variable: "--font-assistant",
  weight: "300 700",
  display: "swap",
});

// Used by the carousel "MANDARINA DUCK" wordmark (Poppins) and the
// "קולקציה נבחרת" collection title (Heebo) — per the leather-background design.
const poppins = localFont({
  src: [
    { path: "./fonts/Poppins-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Poppins-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "./fonts/Poppins-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-poppins",
  display: "swap",
});

const heebo = localFont({
  src: "./fonts/Heebo[wght].woff2",
  variable: "--font-heebo",
  weight: "300 700",
  display: "swap",
});

export const metadata: Metadata = {
  // Canonical home of the landing page. The apex toptik.co.il was returned to
  // the Shopify store on 2026-06-20; this Vercel app now lives on the
  // `landing` subdomain. See docs/LANDING-SUBDOMAIN.md.
  metadataBase: new URL("https://landing.toptik.co.il"),
  title: "גלריית TopTik | מזוודות, טרולי ותיקי נסיעות",
  description: "גלו מקרוב מזוודות, טרולי ותיקי נסיעות של Mandarina Duck, Bric’s ו-Samsonite. השוו בין דגמים, צבעים ופרטי מוצר, והמשיכו לעמוד המוצר בחנות TopTik.",
  robots: { index: true, follow: true },
  verification: {
    google: [
      "SOL1x5W_O4mnV5j6IGHiH-mW4jopb3hJjIOWZXlaLbg",
      "i3_TvaN0Unb_P7E8uqkDjZ7ag4kwTx-WBgkUTIj7Ssk",
    ],
  },
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
        <GalleryAnalytics />
      </body>
    </html>
  );
}
