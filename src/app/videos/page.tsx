import type { Metadata } from "next";
import { galleryVideos } from "@/lib/video-gallery";
import { VideoCard } from "@/components/video-gallery/VideoCard";
import { VideoHeader } from "@/components/video-gallery/VideoHeader";
import styles from "@/components/video-gallery/VideoGallery.module.css";

export const metadata: Metadata = {
  title: "גלריית סרטוני TopTik | מזוודות ותיקים",
  description: "גלו מזוודות, טרולי ותיקים בסרטונים קצרים עם קישורים לרכישה בחנות TopTik.",
  robots: { index: true, follow: true },
  alternates: { canonical: "/videos" },
};

export default function VideosPage() {
  return (
    <main className={styles.shell}>
      <VideoHeader />
      <div className={styles.hero}>
        <p className={styles.eyebrow}>TOPTIK VIDEO</p>
        <h1>סרטוני מזוודות, טרולי ותיקים</h1>
        <p>מזוודות ותיקים, היכרות וטיפים קצרים שיעזרו לכם לבחור את מה שמתאים לכם.</p>
        <p>מחפשים את הדגם הבא לנסיעה? גלו את מבחר ה<a href="https://www.toptik.co.il/collections/מזוודות">מזוודות</a> בחנות TopTik.</p>
      </div>
      <section className={styles.grid} aria-label="סרטוני מזוודות ותיקים">
        {galleryVideos.map((video) => <VideoCard key={video.slug} video={video} />)}
      </section>
      <footer className={styles.footer}>משלוח חינם לכל הארץ · <a href="https://www.toptik.co.il/">לחנות TopTik</a></footer>
    </main>
  );
}
