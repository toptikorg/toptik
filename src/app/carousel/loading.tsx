export default function GalleryLoading() {
  return <main dir="rtl" style={{minHeight:"100vh",background:"#17120f",color:"#f2e6cf",display:"grid",placeContent:"center",padding:24,textAlign:"center",fontSize:22}} role="status" aria-live="polite">
    <h1 style={{fontSize:28}}>פותחים את גלריית טופ תיק…</h1>
    <p>טוענים את המוצרים. אפשר להמתין כאן.</p>
    <Link href="https://www.toptik.co.il/" style={{color:"inherit",padding:16}}>חזרה לחנות</Link>
  </main>;
}
import Link from "next/link";

