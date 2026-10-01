import { readFileSync } from 'node:fs';
const limits = readFileSync(new URL('../../src/lib/shopify/existing-media-limits.ts', import.meta.url), 'utf8').replace(/^export /gm, '');
/** Inlines the production policy in isolated data-URL tests, before imports are stripped. */
export const resolveImageLimits = source => source.replace('import { MAX_EXISTING_MEDIA_PIXELS } from "./existing-media-limits";', limits);
