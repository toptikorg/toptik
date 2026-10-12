import 'server-only';
import { cache } from 'react';
import { resolveProductReference, storeHandle, type ProductRead } from './product-reference-core';

const read = cache(async (handle: string): Promise<ProductRead> => {
  if (storeHandle(`/products/${encodeURIComponent(handle)}`) !== handle) return { state: 'unavailable' };
  try {
    const response = await fetch(`https://www.toptik.co.il/products/${encodeURIComponent(handle)}.js`, {
      cache: 'no-store', signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (response.status === 404 || response.status === 410) return { state: 'missing' };
    if (!response.ok) return { state: 'unavailable' };
    const p = await response.json();
    const image = typeof p.featured_image === 'string' ? p.featured_image.replace(/^\/\//, 'https://') : '';
    const url = new URL(image);
    if (p.handle !== handle || typeof p.title !== 'string' || typeof p.vendor !== 'string' || typeof p.type !== 'string' || typeof p.available !== 'boolean' ||
      url.protocol !== 'https:' || url.hostname !== 'cdn.shopify.com' || !url.pathname.startsWith('/s/files/1/0622/8082/7130/')) return { state: 'unavailable' };
    const preview = p.media?.find((m: { preview_image?: { src?: string } }) => m.preview_image?.src?.split('?')[0] === image.split('?')[0])?.preview_image;
    return { state: 'found', product: { id: String(p.id), handle, title: p.title, vendor: p.vendor, type: p.type, available: p.available,
      image, width: preview?.width || 1000, height: preview?.height || 1000 } };
  } catch { return { state: 'unavailable' }; }
});
export const resolveArticleProduct = cache((handle: string) => resolveProductReference(handle, read));
export async function resolveArticleHero<T extends { src: string; alt: string; width: number; height: number; caption: string; href?: string }>(hero?: T): Promise<T | undefined> {
  if (!hero?.href) return hero;
  const handle = storeHandle(hero.href);
  if (!handle) return hero;
  const result = await resolveArticleProduct(handle);
  if (!result.product) return undefined;
  if (!result.replaced) return hero;
  const p = result.product;
  return { ...hero, src: p.image, alt: p.title, width: p.width, height: p.height,
    href: `https://www.toptik.co.il/products/${encodeURIComponent(p.handle)}`,
    caption: `דוגמה זמינה נוספת: ${p.title}. מפרט הדגם המתואר במאמר אינו מפרט החלופה.` };
}
