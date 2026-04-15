/**
 * Zod schema for brand.json (House Portfolio variant).
 *
 * Covers the subset of the AdCP brand.json spec that sandbox entities produce:
 * $schema, house, brands[] with identity and creative fields.
 *
 * @see schemas/cache/latest/brand.json for the full JSON Schema.
 */

import { z } from 'zod';

// ---- Primitives ----

const BrandIdSchema = z.string().regex(/^[a-z0-9_]+$/);

const LocalizedNameSchema = z
  .record(z.string().min(1), z.string().min(1))
  .refine(obj => Object.keys(obj).length >= 1 && Object.keys(obj).length <= 1, {
    message: 'Localized name must have exactly one locale key',
  });

const KellerTypeSchema = z.enum(['master', 'sub_brand', 'endorsed', 'independent']);

// ---- Logo ----

const LogoSchema = z
  .object({
    url: z.string().url(),
    orientation: z.enum(['square', 'horizontal', 'vertical', 'stacked']).optional(),
    background: z.enum(['dark-bg', 'light-bg', 'transparent-bg']).optional(),
    variant: z.enum(['primary', 'secondary', 'icon', 'wordmark', 'full-lockup']).optional(),
    tags: z.array(z.string()).optional(),
    usage: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  })
  .passthrough();

// ---- Colors ----

const ColorValueSchema = z.union([
  z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).min(1),
]);

const ColorsSchema = z.record(z.string(), ColorValueSchema);

// ---- Fonts ----

const FontFileSchema = z
  .object({
    url: z.string().url(),
    weight: z.number().int().min(100).max(900).optional(),
    weight_range: z.tuple([z.number().int(), z.number().int()]).optional(),
    style: z.enum(['normal', 'italic', 'oblique']).optional(),
  })
  .passthrough();

const FontRoleSchema = z.union([
  z.string(),
  z
    .object({
      family: z.string(),
      files: z.array(FontFileSchema).max(36).optional(),
      opentype_features: z
        .array(z.string().regex(/^[a-z0-9]{4}$/))
        .max(20)
        .optional(),
      fallbacks: z.array(z.string().max(100)).max(10).optional(),
    })
    .passthrough(),
]);

const FontsSchema = z.record(z.string(), FontRoleSchema);

// ---- Voice / Tone ----

const ToneSchema = z.union([
  z.string(),
  z.object({
    voice: z.string().optional(),
    attributes: z.array(z.string()).optional(),
    dos: z.array(z.string()).optional(),
    donts: z.array(z.string()).optional(),
  }),
]);

// ---- Brand entry ----

const BrandEntrySchema = z
  .object({
    id: BrandIdSchema,
    names: z.array(LocalizedNameSchema).min(1),
    url: z.string().url().optional(),
    keller_type: KellerTypeSchema.optional(),
    parent_brand: BrandIdSchema.optional(),
    description: z.string().optional(),
    industries: z.array(z.string()).min(1).optional(),
    target_audience: z.string().optional(),
    logos: z.array(LogoSchema).optional(),
    colors: ColorsSchema.optional(),
    fonts: FontsSchema.optional(),
    tone: ToneSchema.optional(),
    tagline: z.union([z.string(), z.array(LocalizedNameSchema).min(1)]).optional(),
  })
  .passthrough();

// ---- House ----

const HouseSchema = z
  .object({
    domain: z.string(),
    name: z.string().min(1),
    names: z.array(LocalizedNameSchema).optional(),
    architecture: z.enum(['branded_house', 'house_of_brands', 'hybrid']).optional(),
  })
  .passthrough();

// ---- House Portfolio (the variant sandbox entities produce) ----

export const BrandJsonSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.string().optional(),
    house: z.union([HouseSchema, z.string()]),
    brands: z.array(BrandEntrySchema).min(1),
    last_updated: z.string().datetime().optional(),
  })
  .passthrough();

export type BrandJson = z.infer<typeof BrandJsonSchema>;
