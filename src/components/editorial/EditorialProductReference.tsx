import Image from 'next/image';
import type { ReactNode } from 'react';
import { storeHandle } from '@/lib/editorial/product-reference-core';
import { resolveArticleProduct, resolveArticleHero } from '@/lib/editorial/product-reference';

export async function EditorialProductLink({ href, children }: { href: string; children: ReactNode }) {
  const handle = storeHandle(href);
  if (!handle) return <a href={href}>{children}</a>;
  const result = await resolveArticleProduct(handle);
  if (!result.product) return <span>הדוגמה אינה זמינה כרגע לרכישה</span>;
  if (!result.replaced) return <a href={href}>{children}</a>;
  return <a href={`https://www.toptik.co.il/products/${encodeURIComponent(result.product.handle)}`}>דוגמה זמינה נוספת: {result.product.title}</a>;
}

export async function EditorialProductFigure({ image, href }: {
  image: { src: string; alt: string; width: number; height: number; color: string }; href: string;
}) {
  const hero = await resolveArticleHero({ ...image, href, caption: image.color });
  if (!hero) return null;
  return <figure><a href={hero.href}><Image src={hero.src} alt={hero.alt} width={hero.width} height={hero.height} sizes="(max-width: 780px) 94vw, 560px" quality={75} loading="lazy" /></a><figcaption>{hero.caption}</figcaption></figure>;
}
