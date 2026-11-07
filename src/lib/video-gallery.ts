export type VideoProduct = { name: string; url: string };
export type GalleryVideo = {
  slug: string;
  file: string;
  title: string;
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
    title: "������� ��������: Intuo �� Upscape?",
    eyebrow: "������� ������",
    collection: { name: "��� ��������", url: "https://www.toptik.co.il/collections/�������" },
    description: "��� ���� ����� �� �������� ����� 55 ���. ��� ������ �� ������ ������� ���� ������.",
    transcript: "������� ��� ������� ��������? ��� ������� ����� �� �������� ����� ������ ������ ���������. ���� �� ���� ����� �������� ��� ������� ���� ��� ���, �� ����� ����.",
    products: [
      { name: "Intuo Easy Access ���� ����", url: "https://www.toptik.co.il/products/samsonite-intuo-55-easy-access-lime-kl974005" },
      { name: "Upscape Easy Access ���� ����", url: "https://www.toptik.co.il/products/samsonite-upscape-55-easy-access-climbing-ivy-kj114007" },
    ],
  },
  {
    slug: "choosing-55cm-trolley",
    file: "02-cabin-trolley",
    firstPublishedOn: "2026-11-06",
    title: "��� ������ ������ ����� ������? �������� Intuo",
    eyebrow: "����� ������",
    collection: { name: "��� ��������", url: "https://www.toptik.co.il/collections/�������" },
    description: "���� ������� �����, ���� �� ����� ������ ������� ��� ���� ������ ����. ����� �� ��� Intuo ����� 55 ���.",
    transcript: "������ ����� ������? ���� �������, ���� �� ����� ������ ������� ��� ���� ������ ����. ���� ��� ��� ����� ����� ���� ���� �������� ������� ������ ����.",
    products: [{ name: "Intuo Easy Access ���� ����", url: "https://www.toptik.co.il/products/samsonite-intuo-55-easy-access-lime-kl974005" }],
  },
  {
    slug: "samsonite-pro-dlx-6",
    file: "03-pro-dlx",
    // Publication planned for 6 Nov; update if the first public rollout occurs later.
    firstPublishedOn: "2026-11-06",
    title: "��� �� ����� �������� PRO-DLX 6",
    eyebrow: "����� �������",
    description: "��� �� ���� �� ������ ����� ��� ����� �� 15.6 �����. ����� ����� �� ����� ����� ���� ������.",
    transcript: "������ ��� �� �����? ��� �� �� ��� �� �� �������� ����� ������ ����� ����� �� ��� ���� ����� �� �����. ��� �� ���� ����� ���� ��� ���, �� ����� ����.",
    products: [{ name: "PRO-DLX 6 ����", url: "https://www.toptik.co.il/products/km209008" }],
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
