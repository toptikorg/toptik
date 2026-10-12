import policyJson from './product-reference-policy.json';

export type ReferencePolicy = { id: string; vendor: string; type: string; family: string | null; skus: string[]; fallbacks: string[] };
export const referencePolicy: Record<string, ReferencePolicy> = policyJson;
export type PublicArticleProduct = {
  id: string; handle: string; title: string; vendor: string; type: string; available: boolean;
  image: string; width: number; height: number;
};
export function storeHandle(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.toptik.co.il');
    if (url.protocol !== 'https:' || !['www.toptik.co.il', 'toptik.co.il'].includes(url.hostname) || url.port || url.username || url.password) return null;
    const match = url.pathname.match(/^\/products\/([^/]+)\/?$/);
    if (!match) return null;
    const handle = decodeURIComponent(match[1]);
    return /^[\p{L}\p{N}-]+$/u.test(handle) ? handle : null;
  } catch { return null; }
}
export type ProductRead = { state: 'found'; product: PublicArticleProduct } | { state: 'missing' | 'unavailable' };
export async function resolveProductReference(handle: string, read: (handle: string) => Promise<ProductRead>) {
  const original = await read(handle);
  if (original.state === 'found') return { product: original.product, replaced: false, state: 'found' as const };
  // A timeout, rate limit or malformed payload is NOT evidence of removal.
  if (original.state !== 'missing') return { product: null, replaced: false, state: 'unavailable' as const };
  const rule = referencePolicy[handle];
  for (const candidate of rule?.fallbacks ?? []) {
    const result = await read(candidate);
    if (result.state === 'found' && result.product.id === referencePolicy[candidate]?.id && result.product.available && result.product.vendor === rule.vendor && result.product.type === rule.type) {
      return { product: result.product, replaced: true, state: 'found' as const };
    }
  }
  return { product: null, replaced: false, state: 'missing' as const };
}
