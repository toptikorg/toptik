import Link from "next/link";
import type { GalleryVideo } from "@/lib/video-gallery";
import { VideoPlayer } from "./VideoPlayer";
import styles from "./VideoGallery.module.css";

export function VideoCard({ video, detail = false }: { video: GalleryVideo; detail?: boolean }) {
  return (
    <article className={`${styles.card} ${detail ? styles.detailCard : ""}`}>
      <div className={styles.player}>
        <div className={styles.titleBar}>
          {detail ? <h1 data-video-live-title>{video.title}</h1> : <h2 data-video-live-title>{video.title}</h2>}
          {video.liveCopy.map((line) => <p key={line} className={styles.liveCopy} data-video-live-copy>{line}</p>)}
        </div>
        <VideoPlayer file={video.file} slug={video.slug} title={video.title} />
      </div>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>{video.eyebrow}</p>
        <p>{video.description}</p>
        {detail && video.collection && (
          <p><a href={video.collection.url}>{video.collection.name}</a></p>
        )}
        <div className={styles.actions} aria-label="קישורי רכישה">
          {video.products.map((product) => (
            <a key={product.url} href={product.url} data-product-name={product.name} data-video-id={video.slug} className={styles.buy}>
              לרכישת {product.name}
            </a>
          ))}
        </div>
        {!detail && <Link className={styles.watch} href={`/videos/${video.slug}`}>לצפייה בסרטון</Link>}
        <details className={styles.transcript} open>
          <summary>תמלול הסרטון</summary>
          <p>{video.transcript}</p>
        </details>
      </div>
    </article>
  );
}
