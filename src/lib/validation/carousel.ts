import { z } from "zod";

export const carouselSettingsSchema = z.object({
  editorRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  autoplayMs: z.number().int().min(1500).max(12000),
  transitionMode: z.enum(["shatter-particle", "curtain-fade"]),
});

export const carouselAngleInputSchema = z.object({
  id: z.string().uuid().optional(),
  angleKey: z.string().min(1).max(32),
  angleOrder: z.number().int().min(1).max(50),
  imagePath: z.string().min(1),
  imageAlt: z.string().max(512).nullable().optional(),
});

// Scraped colour swatch (drives the per-colour gallery swap). Kept lenient so
// an import's colours survive the save round-trip untouched.
const carouselColorSchema = z.object({
  name: z.string().max(80),
  hex: z.string().max(16).nullable(),
  colorCode: z.string().max(16).nullable(),
  imagePath: z.string().min(1),
  angles: z.array(z.string()).max(30).optional(),
  sourceUrl: z.string().max(2000).nullable(),
  catalogNumber: z.string().max(64).nullable(),
});

// Cached tech-specs blob (the נתונים טכניים modal). Also carries the product's
// catalog category ("suitcase" | "carryon") set in the admin — stored here so
// it round-trips in the tech_specs JSON without a new DB column.
const cachedTechSpecsSchema = z.object({
  specs: z.array(
    z.object({
      heading: z.string().max(60),
      items: z.array(z.object({ label: z.string().max(200), value: z.string().max(200) })).max(60),
    }),
  ).max(20),
  colors: z.array(
    z.object({
      name: z.string().max(80),
      hex: z.string().max(16).nullable(),
      swatchUrl: z.string().max(2000).nullable(),
    }),
  ).max(40),
  category: z.string().max(20).nullable().optional(),
});

export const carouselItemInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(120),
  description: z.string().max(50000).nullable().optional(),
  descriptionHtml: z.string().max(250000).nullable().optional(),
  seoTitle: z.string().max(512).nullable().optional(),
  seoDescription: z.string().max(5000).nullable().optional(),
  editorRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  copyUpdatedAt: z.string().max(64).nullable().optional(),
  catalogNumber: z.string().trim().min(2).max(64).nullable().optional(),
  sourceUrl: z.string().url().max(2000).nullable().optional(),
  displayOrder: z.number().int().min(1).max(9999),
  isActive: z.boolean(),
  coverImagePath: z.string().min(1),
  coverImageAlt: z.string().max(512).nullable().optional(),
  color: z.string().max(60).nullable().optional(),
  dimensions: z.string().max(100).nullable().optional(),
  weight: z.string().max(30).nullable().optional(),
  sizes: z.array(z.string().max(30)).max(10).nullable().optional(),
  availableColors: z.array(z.string().max(40)).max(20).nullable().optional(),
  colors: z.array(carouselColorSchema).max(40).nullable().optional(),
  techSpecs: cachedTechSpecsSchema.nullable().optional(),
  // May be empty: a hand-entered product can be saved with only a cover image
  // before angle images are uploaded (the display falls back to the cover).
  angles: z.array(carouselAngleInputSchema).max(30),
});

// A full-catalog save must accommodate the existing 82 rows and future imports.
// This is separate from the smaller, per-request manufacturer import batch.
// Keep aligned with save_gallery_items_with_copy_cas's bounded input limit.
export const MAX_CAROUSEL_ITEMS = 5000;

export const adminCarouselPayloadSchema = z.object({
  settings: carouselSettingsSchema,
  items: z.array(carouselItemInputSchema).min(1).max(MAX_CAROUSEL_ITEMS),
});
