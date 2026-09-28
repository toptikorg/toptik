"use client";

export default function CarouselError({ unstable_retry }: { unstable_retry: () => void }) {
  return <main className="showroom-product-page" dir="rtl">
    <section className="showroom-product-panel">
      <h1>לא ניתן לטעון כרגע את אולם התצוגה</h1>
      <p>אפשר לנסות שוב, או להמשיך לחנות טופ תיק ולבדוק שם את המוצרים, המחירים והזמינות.</p>
      <button onClick={unstable_retry}>ניסיון נוסף</button>{" "}
      <a href="https://www.toptik.co.il/">המשך לחנות טופ תיק</a>
    </section>
  </main>;
}
