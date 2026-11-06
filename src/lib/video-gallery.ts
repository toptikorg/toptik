export type VideoProduct = { name: string; url: string };
export type GalleryVideo = {
  slug: string;
  file: string;
  title: string;
  eyebrow: string;
  description: string;
  transcript: string;
  products: readonly VideoProduct[];
};

export const galleryVideos: readonly GalleryVideo[] = [
  {
    slug: "intuo-upscape",
    file: "01-intuo-vs-upscape",
    title: "מזוודות Samsonite: Intuo או Upscape?",
    eyebrow: "מזוודות וטרולי",
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
    title: "איך בוחרים מזוודת טרולי לנסיעה?",
    eyebrow: "מדריך לנסיעה",
    description: "לפני שבוחרים טרולי, בדקו את מידות הכבודה המותרות אצל חברת התעופה שלכם. הכירו את דגם Intuo בגודל 55 ס״מ.",
    transcript: "מחפשים טרולי לנסיעה? לפני שבוחרים, בדקו את מידות הכבודה המותרות אצל חברת התעופה שלכם. באתר טופ תיק תוכלו לבחור מבין דגמי סמסונייט ולהזמין במשלוח חינם.",
    products: [{ name: "Intuo Easy Access בצבע ליים", url: "https://www.toptik.co.il/products/samsonite-intuo-55-easy-access-lime-kl974005" }],
  },
  {
    slug: "samsonite-pro-dlx-6",
    file: "03-pro-dlx",
    title: "תיק מחשב Samsonite PRO-DLX 6",
    eyebrow: "עבודה ונסיעות",
    description: "תיק גב שחור עם אפשרות הרחבה ותא למחשב עד 15.6 אינץ׳. מומלץ לבדוק את מידות המחשב לפני הבחירה.",
    transcript: "מחפשים תיק גב למחשב? פרו די אל אקס שש של סמסונייט מתרחב ומתאים למחשב בגודל עד חמש עשרה נקודה שש אינץ׳. גלו את התיק השחור באתר טופ תיק, עם משלוח חינם.",
    products: [{ name: "PRO-DLX 6 שחור", url: "https://www.toptik.co.il/products/km209008" }],
  },
  {
    slug: "mandarina-duck-city-bag",
    file: "04-mandarina",
    title: "תיק צד Mandarina Duck ליום בעיר",
    eyebrow: "תיקים ליום יום",
    description: "הכירו תיק צד אדום מסדרת Mellow Leather של מנדרינה דאק, ליום בעיר וליציאה בערב.",
    transcript: "מחפשים תיק צד עם נוכחות? תיק מלו לדר האדום של מנדרינה דאק מתאים ליום בעיר וליציאה בערב. גלו את הדגם באתר טופ תיק והזמינו עם משלוח חינם.",
    products: [{ name: "Mellow Leather FZT52 אדום", url: "https://www.toptik.co.il/products/p10fzt5224f" }],
  },
];

export function findGalleryVideo(slug: string): GalleryVideo | undefined {
  return galleryVideos.find((video) => video.slug === slug);
}
