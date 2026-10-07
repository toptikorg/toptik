import { isUnavailableCarouselPayload } from "@/lib/carousel/fallback-data";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { adminCarouselPayloadSchema } from "@/lib/validation/carousel";
import { gallerySyncHash, outboxPayload } from "@/lib/shopify/sync-worker";
import { normalizeSyncSku } from "@/lib/shopify/sync-rules";
import { MD20_VARIANTS, isShopifyOwnedVariant, SHOPIFY_OWNED_MESSAGE } from "@/lib/shopify/variant-source-policy";
import { plainDescriptionToHtml, descriptionTextFromHtml, assertSafeDescriptionHtml } from "@/lib/shopify/description-document";

// Admin-only write path (service role). Moved unchanged from ./repository.ts so
// the public read path cannot reach the service-role client (GAL-025 / GAL-015).

export async function saveCarouselPayload(input: unknown, mediaActor?: { actorType: "supabase_user" | "admin_panel_token"; actorId: string }) {
  // Check before schema parsing strips the failure marker and before any write.
  if (isUnavailableCarouselPayload(input)) {
    throw new Error("Cannot save an unavailable catalog. Reload the catalog first.");
  }
  const parsed = adminCarouselPayloadSchema.parse(input);
  // "changed-only": the merchant editor sends just the rows it changed. Every
  // per-item check below still applies to each submitted row, but rows that
  // were not submitted are neither required, versioned, written nor deleted.
  const changedOnly = parsed.saveMode === "changed-only";
  const supabase = createSupabaseServiceRoleClient();

  const normalizedItems = parsed.items.map((item) => ({
    ...item,
    id: item.id ?? crypto.randomUUID(),
    angles: item.angles.map((angle) => ({
      ...angle,
      id: angle.id ?? crypto.randomUUID(),
    })),
  }));

  const ownedItems = normalizedItems.filter(item => isShopifyOwnedVariant(item.id));
  if (ownedItems.length) {
    const [current, currentAngles] = await Promise.all([
      supabase.from("carousel_items").select("*").in("id", MD20_VARIANTS.map(v => v.itemId)),
      supabase.from("carousel_item_angles").select("*").in("item_id", MD20_VARIANTS.map(v => v.itemId)),
    ]);
    if (current.error || currentAngles.error) throw new Error("SYNC_VARIANT_GALLERY_READ_FAILED");
    const fields = { title: "title", description: "description", descriptionHtml: "description_html", seoTitle: "seo_title",
      seoDescription: "seo_description", catalogNumber: "catalog_number", coverImagePath: "cover_image_path", coverImageAlt: "cover_image_alt", isActive: "is_active" } as const;
    for (const item of ownedItems) {
      const row = current.data.find(r => r.id === item.id);
      const previousAngles = currentAngles.data.filter(a => a.item_id === item.id);
      if (!row || Object.entries(fields).some(([client, column]) =>
        (item[client as keyof typeof fields] ?? null) !== (row[column] ?? null)) ||
        item.angles.length !== previousAngles.length || item.angles.some(a => {
          const old = previousAngles.find(p => p.id === a.id);
          return !old || old.angle_key !== a.angleKey || old.angle_order !== a.angleOrder ||
            old.image_path !== a.imagePath || (old.image_alt ?? null) !== (a.imageAlt ?? null);
        })) throw new Error(SHOPIFY_OWNED_MESSAGE);
    }
  }

  let { data: priorContentRows, error: priorContentError } = await supabase
    .from("carousel_items")
    .select("id,title,description,description_html,catalog_number,seo_title,seo_description,copy_updated_at");
  let richSchemaAvailable = !priorContentError;
  if (priorContentError && /description_html/i.test(priorContentError.message)) {
    const priorSync = await supabase.from("carousel_items").select("id,title,description,catalog_number,seo_title,seo_description,copy_updated_at");
    priorContentRows = priorSync.data as typeof priorContentRows;
    priorContentError = priorSync.error;
  }
  let syncSchemaAvailable = !priorContentError;
  // A draft deployment can run against a database before its additive sync
  // migration. Preserve the existing editor read/write path in that case.
  if (priorContentError && /seo_title|copy_updated_at|column|schema cache/i.test(priorContentError.message)) {
    syncSchemaAvailable = false;
    richSchemaAvailable = false;
    const legacy = await supabase.from("carousel_items").select("id,title,description,catalog_number");
    priorContentRows = legacy.data as typeof priorContentRows;
    priorContentError = legacy.error;
  }
  if (priorContentError) throw priorContentError;
  const revisionRead = await supabase.from("carousel_items").select("id,editor_revision");
  const editorSchemaAvailable = !revisionRead.error;
  if (revisionRead.error && !["42703", "PGRST204"].includes(revisionRead.error.code)) throw revisionRead.error;
  if (editorSchemaAvailable && !syncSchemaAvailable) throw new Error("GALLERY_EDITOR_SYNC_SCHEMA_REQUIRED");
  const storedRevisions = new Map((revisionRead.data ?? []).map((row: { id: string; editor_revision: number }) => [row.id, row.editor_revision]));
  if (editorSchemaAvailable) {
    if (!parsed.settings.editorRevision) throw new Error("GALLERY_EDITOR_REVISION_REQUIRED");
    for (const item of normalizedItems) {
      if (storedRevisions.has(item.id) && item.editorRevision !== storedRevisions.get(item.id)) {
        throw new Error("GALLERY_EDITOR_STALE_RELOAD");
      }
    }
  }
  const priorContent = new Map(((priorContentRows ?? []) as Array<{
    id: string;
    title: string;
    description: string | null;
    description_html?: string | null;
    catalog_number: string | null;
    seo_title: string | null;
    seo_description: string | null;
    copy_updated_at: string;
  }>).map(row => [row.id, row]));
  const incomingIds = new Set(normalizedItems.map(item => item.id));
  // A changed-only save never deletes by omission (see itemIdsToDelete below),
  // so the completeness requirement only guards the full-catalog contract.
  if (syncSchemaAvailable && !changedOnly && [...priorContent.keys()].some(id => !incomingIds.has(id))) {
    // This canary supports copy changes. Deleting a bound row would invalidate
    // its identity/audit history; deletion needs the later archive protocol.
    throw new Error("SYNC_GALLERY_DELETE_REQUIRES_ARCHIVE");
  }

  const itemsToSave = normalizedItems.map((item, index) => {
    const previous = priorContent.get(item.id);
    const inputItem = parsed.items[index];
    let description = item.description ?? "";
    let descriptionHtml: string | null = previous?.description_html ?? null;
    if (typeof inputItem.descriptionHtml === "string") {
      if (!richSchemaAvailable) throw new Error("SYNC_DESCRIPTION_MIGRATION_REQUIRED");
      if (inputItem.descriptionHtml !== previous?.description_html) assertSafeDescriptionHtml(inputItem.descriptionHtml);
      descriptionHtml = inputItem.descriptionHtml;
      description = descriptionTextFromHtml(descriptionHtml);
    } else if (typeof previous?.description_html === "string") {
      if ((inputItem.description ?? "") !== (previous.description ?? "")) {
        throw new Error("SYNC_DESCRIPTION_RICH_EDITOR_REQUIRED");
      }
      // A legacy client saving another field cannot erase rich structure or
      // trigger a historical plain-text repair underneath the stored HTML.
      description = previous.description ?? "";
    } else if (richSchemaAvailable && (!previous || description !== (previous.description ?? ""))) {
      descriptionHtml = plainDescriptionToHtml(description);
      description = descriptionTextFromHtml(descriptionHtml);
    }
    const seoTitle = inputItem.seoTitle === undefined ? previous?.seo_title ?? null : inputItem.seoTitle;
    const seoDescription = inputItem.seoDescription === undefined ? previous?.seo_description ?? null : inputItem.seoDescription;
    const copyChanged = !previous || previous.title !== item.title ||
      (previous.description ?? "") !== description ||
      (previous.description_html ?? null) !== descriptionHtml ||
      (previous.seo_title ?? null) !== (seoTitle ?? null) ||
      (previous.seo_description ?? null) !== (seoDescription ?? null);
    const submittedVersion = inputItem.copyUpdatedAt;
    if (syncSchemaAvailable && previous && copyChanged && !submittedVersion) {
      throw new Error("SYNC_COPY_VERSION_REQUIRED");
    }
    if (previous && submittedVersion && previous.copy_updated_at &&
        Date.parse(submittedVersion) !== Date.parse(previous.copy_updated_at) && copyChanged) {
      throw new Error("SYNC_COPY_STALE_EDIT_RELOAD");
    }
    return {
      ...item,
      description: description || null,
      descriptionHtml,
      // Full-catalog saves from old clients/imports preserve SEO unless the
      // caller explicitly supplied an SEO value (including an empty string).
      seoTitle,
      seoDescription,
      copyUpdatedAt: copyChanged ? new Date().toISOString() : previous?.copy_updated_at ?? new Date().toISOString(),
    };
  });

  if (!editorSchemaAvailable) {
  const { error: settingsError } = await supabase.from("carousel_settings").upsert(
    {
      id: 1,
      autoplay_ms: parsed.settings.autoplayMs,
      transition_mode: parsed.settings.transitionMode,
    },
    { onConflict: "id" },
  );
  if (settingsError) throw settingsError;
  }

  if (changedOnly && itemsToSave.length === 0) {
    // Settings-only change. save_gallery_catalog_atomic requires 1..5000 items,
    // so apply the two settings columns with a single conditional UPDATE that
    // is itself the settings CAS: it matches only while the stored revision is
    // the one the editor loaded (a concurrent settings change bumps it through
    // gallery_editor_revision_bump). No product row is touched.
    if (editorSchemaAvailable) {
      const { data, error } = await supabase.from("carousel_settings")
        .update({ autoplay_ms: parsed.settings.autoplayMs, transition_mode: parsed.settings.transitionMode })
        .eq("id", 1).eq("editor_revision", parsed.settings.editorRevision)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("GALLERY_EDITOR_SETTINGS_STALE_RELOAD");
    }
    // Pre-editor schemas already upserted the settings above.
    return { ok: true };
  }

  // Full row incl. scraped side-data (colours + tech specs) so a "save all"
  // from the admin persists everything an import produced — not just images.
  const fullRow = (item: (typeof itemsToSave)[number]) => ({
    id: item.id,
    title: item.title,
    description: item.description ?? null,
    ...(richSchemaAvailable ? { description_html: item.descriptionHtml } : {}),
    seo_title: item.seoTitle ?? null,
    seo_description: item.seoDescription ?? null,
    copy_updated_at: item.copyUpdatedAt,
    catalog_number: item.catalogNumber ?? null,
    source_url: item.sourceUrl ?? null,
    cover_image_path: item.coverImagePath,
    ...(editorSchemaAvailable ? { cover_image_alt: item.coverImageAlt ?? null } : {}),
    display_order: item.displayOrder,
    is_active: item.isActive,
    color: item.color ?? null,
    dimensions: item.dimensions ?? null,
    weight: item.weight ?? null,
    sizes: item.sizes ?? null,
    available_colors: item.availableColors ?? null,
    colors: item.colors ?? null,
    tech_specs: item.techSpecs ?? null,
  });

  // Progressive fallbacks for older DB schemas: drop the newest columns first
  // if the DB rejects them, so a save never fails outright on a lagging schema.
  const rowVariants = [
    itemsToSave.map(fullRow),
    // without colors/tech_specs/color/dimensions/weight/sizes/available_colors
    itemsToSave.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description ?? null,
      catalog_number: item.catalogNumber ?? null,
      source_url: item.sourceUrl ?? null,
      cover_image_path: item.coverImagePath,
      display_order: item.displayOrder,
      is_active: item.isActive,
    })),
    // legacy: without catalog_number/source_url too
    itemsToSave.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description ?? null,
      cover_image_path: item.coverImagePath,
      display_order: item.displayOrder,
      is_active: item.isActive,
    })),
  ];

  const angleRows = itemsToSave.flatMap(item => item.angles.map(angle => ({
    id: angle.id, item_id: item.id, angle_key: angle.angleKey,
    image_path: angle.imagePath, angle_order: angle.angleOrder,
    ...(editorSchemaAvailable ? { image_alt: angle.imageAlt ?? null } : {}),
  })));
  let itemsError: { message: string } | null = null;
  let upsertedItems: { id: string }[] | null = null;
  if (syncSchemaAvailable) {
    // The database checks these versions under row locks and commits copy plus
    // its durable outbox together. Once the sync schema exists, a missing RPC
    // must fail closed; falling back to UPSERT would reintroduce lost updates.
    // Changed-only: version exactly the submitted rows. The copy CAS rejects an
    // expected-version key for a row absent from p_items (it would read as a
    // deletion), and an unsubmitted row has nothing to version.
    const expectedVersions = Object.fromEntries(changedOnly
      ? itemsToSave.map(item => [item.id, priorContent.get(item.id)?.copy_updated_at ?? null])
      : [
        ...[...priorContent.values()].map(item => [item.id, item.copy_updated_at]),
        ...itemsToSave.filter(item => !priorContent.has(item.id)).map(item => [item.id, null]),
      ]);
    const result = await supabase.rpc(editorSchemaAvailable ? "save_gallery_catalog_atomic" : "save_gallery_items_with_copy_cas", {
      p_items: itemsToSave.map(fullRow), p_expected_versions: expectedVersions,
      ...(editorSchemaAvailable ? {
        p_expected_editor_revisions: Object.fromEntries(itemsToSave.map(item => [item.id, item.editorRevision ?? null])),
        p_angles: angleRows,
        p_media_actor: mediaActor ?? null,
        p_settings: { autoplay_ms: parsed.settings.autoplayMs, transition_mode: parsed.settings.transitionMode },
        p_expected_settings_revision: parsed.settings.editorRevision,
      } : {}),
    });
    itemsError = result.error;
    upsertedItems = result.data;
  } else {
    for (const rows of rowVariants) {
      const result = await supabase
        .from("carousel_items")
        .upsert(rows, { onConflict: "id" })
        .select("id");
      itemsError = result.error;
      upsertedItems = result.data;
      if (!result.error) break;
      // Only retry with a smaller row when the failure is a missing column.
      if (!/column|does not exist|schema cache/i.test(result.error.message)) break;
    }
  }

  if (itemsError) throw itemsError;

  const validItemIds = new Set((upsertedItems ?? []).map((row: { id: string }) => row.id));

  const incomingItemIds = new Set(itemsToSave.map((item) => item.id));
  const itemIdsToDelete = syncSchemaAvailable || changedOnly ? [] : [...priorContent.keys()]
    .filter(id => !incomingItemIds.has(id));

  if (itemIdsToDelete.length > 0) {
    const { error: deleteItemsError } = await supabase
      .from("carousel_items")
      .delete()
      .in("id", itemIdsToDelete);
    if (deleteItemsError) throw deleteItemsError;
  }

  if (!editorSchemaAvailable) {
  if (angleRows.length > 0) {
    const { error: anglesError } = await supabase
      .from("carousel_item_angles")
      .upsert(angleRows, { onConflict: "id" });
    if (anglesError) throw anglesError;
  }

  if (validItemIds.size > 0) {
    const { data: existingAngles } = await supabase.from("carousel_item_angles").select("id,item_id");
    const incomingAngleIds = new Set(itemsToSave.flatMap((item) => item.angles.map((angle) => angle.id)));
    const angleIdsToDelete = (existingAngles ?? [])
      .filter((row: { id: string; item_id: string }) => validItemIds.has(row.item_id) && !incomingAngleIds.has(row.id))
      .map((row: { id: string }) => row.id);

    if (angleIdsToDelete.length > 0) {
      const { error } = await supabase.from("carousel_item_angles").delete().in("id", angleIdsToDelete);
      if (error) throw error;
    }
  }

  }

  // Mirror only actual Gallery-owned copy edits to the private outbox. A batch
  // "save all" with unchanged copy must not generate a wave of Shopify writes.
  // The migrated database already committed its outbox atomically above.
  // Retain the legacy compatibility path only before the sync migration.
  if (!syncSchemaAvailable) {
  const changedCopyIds = new Set(itemsToSave.filter(item => {
    const previous = priorContent.get(item.id);
    return !previous || previous.title !== item.title ||
      (previous.description ?? null) !== (item.description ?? null) ||
      (previous.description_html ?? null) !== (item.descriptionHtml ?? null) ||
      (previous.seo_title ?? null) !== (item.seoTitle ?? null) ||
      (previous.seo_description ?? null) !== (item.seoDescription ?? null);
  }).map(item => item.id));
  // Retry queue delivery after a previous transient outbox failure: if a
  // binding exists but its last agreed payload differs, enqueue again even if
  // this Save All did not itself change the copy.
  const keyedItems = itemsToSave.flatMap(item => {
    const catalogKey = normalizeSyncSku(item.catalogNumber);
    return catalogKey ? [{ item, catalogKey }] : [];
  });
  if (keyedItems.length) {
    const [bindingResult, stateResult] = await Promise.all([
      supabase.from("shopify_gallery_bindings").select("catalog_key,carousel_item_id"),
      supabase.from("shopify_gallery_sync_state").select("catalog_key,last_synced_payload"),
    ]);
    if (bindingResult.error && !/does not exist|schema cache|could not find the table/i.test(bindingResult.error.message)) throw new Error("Shopify sync binding read failed");
    if (stateResult.error && !/does not exist|schema cache|could not find the table/i.test(stateResult.error.message)) throw new Error("Shopify sync state read failed");
    const boundItemIds = new Set((bindingResult.data ?? []).map((row: { carousel_item_id: string }) => row.carousel_item_id));
    const syncedByKey = new Map((stateResult.data ?? []).map((row: { catalog_key: string; last_synced_payload: unknown }) => [row.catalog_key, row.last_synced_payload]));
    for (const { item, catalogKey } of keyedItems) {
      if (!boundItemIds.has(item.id)) continue;
      const content = { title: item.title, description: item.description ?? "", descriptionHtml: item.descriptionHtml, seoTitle: item.seoTitle ?? null, seoDescription: item.seoDescription ?? null };
      const previousSynced = syncedByKey.get(catalogKey) as typeof content | undefined;
      if (!previousSynced || gallerySyncHash(previousSynced) !== gallerySyncHash(content)) changedCopyIds.add(item.id);
    }
  }
  const changedCopy = itemsToSave.filter(item => changedCopyIds.has(item.id));
  const outboxRows = changedCopy.flatMap(item => {
    const catalogKey = normalizeSyncSku(item.catalogNumber);
    if (!catalogKey) return [];
    const content = {
      title: item.title,
      description: item.description ?? "",
      descriptionHtml: item.descriptionHtml,
      seoTitle: item.seoTitle ?? null,
      seoDescription: item.seoDescription ?? null,
    };
    return [{
      carousel_item_id: item.id,
      catalog_key: catalogKey,
      content_hash: gallerySyncHash(content),
      payload: outboxPayload(content),
      status: "pending",
      attempts: 0,
      created_at: new Date().toISOString(),
      last_error: null,
    }];
  });
  if (outboxRows.length) {
    const { error: outboxError } = await supabase.from("shopify_gallery_content_outbox")
      .upsert(outboxRows, { onConflict: "carousel_item_id,content_hash" });
    // The migration is deployed separately. Keep the existing Gallery editor
    // operational before setup; once the table exists, any other failure must
    // surface because the downstream sync could otherwise be silently lost.
    if (outboxError && !/does not exist|schema cache|could not find the table/i.test(outboxError.message)) {
      throw new Error("Gallery content saved, but Shopify sync enqueue failed. Retry the save after checking the sync queue.");
    }
  }
  }

  return { ok: true };
}
