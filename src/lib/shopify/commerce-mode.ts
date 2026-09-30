/** Separate publication gate. Draft creation authorization never enables this. */
export function commercialPublicationMode(env:Record<string,string|undefined>):'publish_verified_v1'|undefined {
 return env.VERCEL_ENV==='production'&&env.SHOPIFY_GALLERY_PUBLISH_MODE==='publish_verified_v1'?'publish_verified_v1':undefined;
}
