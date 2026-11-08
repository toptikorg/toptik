import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findGalleryVideo, galleryVideos, videoStructuredData } from "@/lib/video-gallery";
import { SITE_ORIGIN } from "@/lib/seo/site";
import { jsonLdString } from "@/lib/seo/structured-data";
import { VideoCard } from "@/components/video-gallery/VideoCard";
import { VideoHeader } from "@/components/video-gallery/VideoHeader";
import styles from "@/components/video-gallery/VideoGallery.module.css";

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return galleryVideos.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const video = findGalleryVideo(slug);
  if (!video) return { robots: { index: false, follow: true } };
  const title = `${video.title} | סרטוני TopTik`;
  const url = `/videos/${video.slug}`;
  const image = `/videos/${video.file}.webp`;
  return {
    title,
    description: video.description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: { type: "website", title, description: video.description, url, images: [{ url: image, alt: video.title }] },
    twitter: { card: "summary_large_image", title, description: video.description, images: [image] },
  };
}

export default async function VideoPage({ params }: PageProps) {
  const { slug } = await params;
  const video = findGalleryVideo(slug);
  if (!video) notFound();
  return (
    <main className={styles.shell}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(videoStructuredData(video, SITE_ORIGIN)) }} />
      <VideoHeader />
      <div className={styles.detailWrap}>
        <Link href="/videos" className={styles.back}>חזרה לכל הסרטונים</Link>
        <VideoCard video={video} detail />
      </div>
      <footer className={styles.footer}>משלוח חינם לכל הארץ · <a href="https://www.toptik.co.il/">לחנות TopTik</a></footer>
    </main>
  );
}
