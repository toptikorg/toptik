import { z } from "zod";

export const editorialIdSchema = z.string().regex(/^(?:shopify-\d+|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/);
export const editorialSchema = z.object({
  expectedSku: z.string().trim().max(100).optional(),
  title: z.string().trim().min(8).max(160),
  description: z.string().trim().min(25).max(2500),
  pageTitle: z.string().trim().min(8).max(120),
  metaDescription: z.string().trim().min(30).max(200),
  indexable: z.boolean(),
  sourceUrls: z.array(z.string().url().startsWith("https://")).max(8).default([]),
  specs: z.array(z.object({ label: z.string().min(1).max(100), value: z.string().min(1).max(300) })).max(30).optional(),
});
export type ProductEditorial = z.infer<typeof editorialSchema>;
