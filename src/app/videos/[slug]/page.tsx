import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findGalleryVideo, galleryVideos } from "@/lib/video-gallery";
import { VideoCard } from "@/components/video-gallery/VideoCard";
import styles from "@/components/video-gallery/VideoGallery.module.css";

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return galleryVideos.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const video = findGalleryVideo(slug);
  if (!video) return { robots: { index: false, follow: true } };
  return {
    title: `${video.title} | סרטוני TopTik`,
    description: video.description,
    alternates: { canonical: `/videos/${video.slug}` },
    robots: { index: true, follow: true },
  };
}

export default async function VideoPage({ params }: PageProps) {
  const { slug } = await params;
  const video = findGalleryVideo(slug);
  if (!video) notFound();
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">TOPTIK</Link>
        <nav className={styles.nav} aria-label="ניווט ראשי">
          <Link href="/videos">כל הסרטונים</Link>
          <Link href="/journal">המגזין</Link>
          <a href="https://www.toptik.co.il/">לחנות</a>
        </nav>
      </header>
      <div className={styles.detailWrap}>
        <Link href="/videos" className={styles.back}>חזרה לכל הסרטונים</Link>
        <VideoCard video={video} detail />
      </div>
      <footer className={styles.footer}>משלוח חינם לכל הארץ · <a href="https://www.toptik.co.il/">לחנות TopTik</a></footer>
    </main>
  );
}
