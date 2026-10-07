import { NextResponse, type NextRequest } from 'next/server';
import { requireGalleryAdmin } from '@/lib/admin/gallery-access';
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { isShopifySyncConfigured } from '@/lib/shopify/admin-api';
import { configuredShopifySyncMode } from '@/lib/shopify/sync-rules';
import { mediaSyncEnabled } from '@/lib/shopify/media-work-queue';
import { typedSpecSyncEnabled } from '@/lib/shopify/typed-spec-worker';
import { evaluateCombinedSyncStatus } from '@/lib/shopify/combined-sync-status';

export const runtime = 'nodejs';
export const preferredRegion = 'syd1';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(req: NextRequest) {
  const denied = await requireGalleryAdmin(req); if (denied) return denied;
  const productId = req.nextUrl.searchParams.get('productId');
  if (productId !== null && !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(productId)) return NextResponse.json({ error: 'SYNC_STATUS_INPUT_INVALID', queuesClear: false, liveVerified: false }, { status: 400, headers });
  try {
    const { data, error } = await createSupabaseServiceRoleClient().rpc('read_toptik_combined_sync_status', { p_product_gid: productId }).abortSignal(AbortSignal.timeout(5000));
    if (error) throw new Error('SYNC_STATUS_RPC_FAILED');
    const state = evaluateCombinedSyncStatus(data, {
      copy: process.env.VERCEL_ENV === 'production' && isShopifySyncConfigured() && configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE) === 'verified_catalog',
      media: mediaSyncEnabled(), specifications: typedSpecSyncEnabled(),
    });
    return NextResponse.json(state, { status: state.status === 'unknown' ? 503 : 200, headers });
  } catch {
    return NextResponse.json({ error: 'SYNC_STATUS_UNAVAILABLE', status: 'unknown', queuesClear: false, liveVerified: false }, { status: 503, headers });
  }
}
