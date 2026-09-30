import "server-only";
import { after } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { galleryDraftCreationMode, runPersistedGalleryDraft } from "./creation-runtime";

const CONTINUATION_URL = "https://landing.toptik.co.il/api/admin/shopify/drafts";
export const MAX_CREATION_HOPS = 8;

/** Bounded wakeup for the same durable UUID. No origin from caller input. */
export function scheduleGalleryDraftCreation(id: string, hop = 0): void {
  if (!galleryDraftCreationMode()) return;
  after(async () => {
    try {
      const result = await runPersistedGalleryDraft(createSupabaseServiceRoleClient(), id);
      if (!result.pending || hop >= MAX_CREATION_HOPS || !process.env.ADMIN_PANEL_TOKEN) return;
      // Avoid a rapid chain on a busy lock or a missing response. The durable
      // intent survives the bounded chain and can resume by its UUID.
      await new Promise(resolve => setTimeout(resolve, 1500));
      const response = await fetch(CONTINUATION_URL, { method: "PATCH", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(8000), headers: { "content-type": "application/json", "x-admin-token": process.env.ADMIN_PANEL_TOKEN },
        body: JSON.stringify({ id, hop: hop + 1 }) });
      if (response.status !== 202) throw new Error("SYNC_CREATION_CONTINUATION_NOT_ACCEPTED");
      await response.body?.cancel();
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SYNC_CREATION_BACKGROUND_FAILED";
      console.error("Gallery draft creation pending", { id, code });
    }
  });
}
