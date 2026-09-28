import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { editorialIdSchema, editorialSchema, type ProductEditorial } from "./editorial-schema";

// Dedicated public editorial text only. Never writes products, stock or images.
const BUCKET = "carousel-editorial";
let cached: { until: number; data: Record<string, ProductEditorial> } | undefined;
export async function readEditorialOverrides(): Promise<Record<string, ProductEditorial>> {
  if (cached && cached.until > Date.now()) return structuredClone(cached.data);
  const storage = createSupabaseServiceRoleClient().storage.from(BUCKET);
  const result: Record<string, ProductEditorial> = {};
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await storage.list("products", { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (error) {
      if (/bucket.*not found/i.test(error.message)) return {};
      throw new Error("Editorial storage read unavailable");
    }
    for (const file of data ?? []) {
      const id = file.name.replace(/\.json$/, "");
      if (!editorialIdSchema.safeParse(id).success || !file.name.endsWith(".json")) continue;
      const downloaded = await storage.download(`products/${file.name}`);
      if (downloaded.error || !downloaded.data) throw new Error("Editorial record unavailable");
      result[id] = editorialSchema.parse(JSON.parse(await downloaded.data.text()));
    }
    if (!data || data.length < 100) break;
    if (offset >= 5000) throw new Error("Editorial record limit exceeded");
  }
  cached = { until: Date.now() + 60000, data: result };
  return structuredClone(result);
}
export async function saveEditorial(id: string, input: unknown) {
  editorialIdSchema.parse(id);
  const record = editorialSchema.parse(input);
  const client = createSupabaseServiceRoleClient();
  const found = await client.storage.getBucket(BUCKET);
  if (found.error) {
    if (!/not found/i.test(found.error.message)) throw new Error("Editorial storage unavailable");
    const created = await client.storage.createBucket(BUCKET, {
      public: true, fileSizeLimit: 32768, allowedMimeTypes: ["application/json"],
    });
    if (created.error && !/already exists/i.test(created.error.message)) throw new Error("Could not create editorial storage");
  }
  const path = `products/${id}.json`;
  const { error } = await client.storage.from(BUCKET).upload(path, JSON.stringify(record), {
    contentType: "application/json", cacheControl: "0", upsert: true,
  });
  if (error) throw new Error("Editorial save failed");
  cached = undefined;
  const check = await client.storage.from(BUCKET).download(path);
  if (check.error || !check.data || JSON.stringify(editorialSchema.parse(JSON.parse(await check.data.text()))) !== JSON.stringify(record))
    throw new Error("Editorial save could not be verified");
  return record;
}
