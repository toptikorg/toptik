export type VideoProduct = { name: string; url: string };
export type GalleryVideo = {
  slug: string;
  file: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  eyebrow: string;
  description: string;
  transcript: string;
  durationSeconds?: number;
  firstPublishedOn: string;
  collection?: { name: string; url: string };
  products: readonly VideoProduct[];
};

export const galleryVideos: readonly GalleryVideo[] = [
  {
    slug: "intuo-upscape",
    file: "01-intuo-vs-upscape",
    firstPublishedOn: "2026-11-06",
    title: "מזוודות סמסונייט Intuo ו־Upscape בגודל 55 ס״מ",
    seoTitle: "מזוודות סמסונייט Intuo ו־Upscape בגודל 55 ס״מ | סרטון",
    seoDescription: "צפו בסרטון והכירו את מזוודות הטרולי Samsonite Intuo ו־Upscape בגודל 55 ס״מ, עם קישורים לדגמי Easy Access בחנות TopTik.",
    eyebrow: "מזוודות וטרולי",
    collection: { name: "לכל המזוודות", url: "https://www.toptik.co.il/collections/מזוודות" },
    description: "שני דגמי טרולי של סמסונייט בגודל 55 ס״מ. צפו והכירו את הדגמים והצבעים לפני הבחירה.",
    transcript: "מתלבטים בין אינטואו לאפסקייפ? שתי מזוודות טרולי של סמסונייט בגודל חמישים וחמישה סנטימטרים. בחרו את הדגם והצבע שמתאימים לכם והזמינו באתר טופ תיק, עם משלוח חינם.",
    products: [
      { name: "Intuo Easy Access בצבע ליים", url: "https://www.toptik.co.il/products/samsonite-intuo-55-easy-access-lime-kl974005" },
      { name: "Upscape Easy Access בצבע ירוק", url: "https://www.toptik.co.il/products/samsonite-upscape-55-easy-access-climbing-ivy-kj114007" },
    ],
  },
  {
    slug: "choosing-55cm-trolley",
    file: "02-cabin-trolley",
    firstPublishedOn: "2026-11-06",
    title: "טרולי סמסונייט Intuo בגודל 55 ס״מ לנסיעה",
    seoTitle: "טרולי סמסונייט Intuo 55 ס״מ: בחירת מזוודה לנסיעה | סרטון",
    seoDescription: "מחפשים טרולי לנסיעה? צפו בסרטון על Samsonite Intuo בגודל 55 ס״מ ובדקו את מידות הכבודה המותרות בחברת התעופה לפני הבחירה.",
    eyebrow: "מדריך לנסיעה",
    collection: { name: "לכל המזוודות", url: "https://www.toptik.co.il/collections/מזוודות" },
    description: "לפני שבוחרים טרולי, בדקו את מידות הכבודה המותרות אצל חברת התעופה שלכם. הכירו את דגם Intuo בגודל 55 ס״מ.",
    transcript: "מחפשים טרולי לנסיעה? לפני שבוחרים, בדקו את מידות הכבודה המותרות אצל חברת התעופה שלכם. באתר טופ תיק תוכלו לבחור מבין דגמי סמסונייט ולהזמין במשלוח חינם.",
    products: [{ name: "Intuo Easy Access בצבע ליים", url: "https://www.toptik.co.il/products/samsonite-intuo-55-easy-access-lime-kl974005" }],
  },
  {
    slug: "samsonite-pro-dlx-6",
    file: "03-pro-dlx",
    // Publication planned for 6 Nov; update if the first public rollout occurs later.
    firstPublishedOn: "2026-11-06",
    title: "תיק גב למחשב סמסונייט PRO-DLX 6 עד 15.6 אינץ׳",
    seoTitle: "תיק גב למחשב סמסונייט PRO-DLX 6 עד 15.6 אינץ׳ | סרטון",
    seoDescription: "הכירו בסרטון את תיק הגב Samsonite PRO-DLX 6 בצבע שחור, עם אפשרות הרחבה ותא למחשב עד 15.6 אינץ׳, וקישור לרכישה בחנות TopTik.",
    eyebrow: "עבודה ונסיעות",
    description: "תיק גב שחור עם אפשרות הרחבה ותא למחשב עד 15.6 אינץ׳. מומלץ לבדוק את מידות המחשב לפני הבחירה.",
    transcript: "מחפשים תיק גב למחשב? פרו די אל אקס שש של סמסונייט מתרחב ומתאים למחשב בגודל עד חמש עשרה נקודה שש אינץ׳. גלו את התיק השחור באתר טופ תיק, עם משלוח חינם.",
    products: [{ name: "PRO-DLX 6 שחור", url: "https://www.toptik.co.il/products/km209008" }],
  },
];

export function findGalleryVideo(slug: string): GalleryVideo | undefined {
  return galleryVideos.find((video) => video.slug === slug);
}

// This data describes the one video visible on its dedicated watch page.
export function videoStructuredData(video: GalleryVideo, origin: string) {
  const watchUrl = new URL(`/videos/${video.slug}`, origin).href;
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "@id": `${watchUrl}#video`,
    name: video.title,
    description: video.description,
    thumbnailUrl: new URL(`/videos/${video.file}.webp`, origin).href,
    contentUrl: new URL(`/videos/${video.file}.mp4`, origin).href,
    uploadDate: video.firstPublishedOn,
    inLanguage: "he",
  };
}
