// Type-level gate for generated Zod object ergonomics.
//
// The public schemas are commonly composed by adopters with ZodObject helpers.
// A redundant `Record<string, unknown>` union intersection must not erase those
// methods from schemas whose effective runtime surface is the object shape.

import { z } from 'zod';
import {
  CanonicalFormatDisplayTagSchema,
  CanonicalFormatHTML5BannerSchema,
  CanonicalFormatImageSchema,
  ProductSchema,
} from '../lib/types/schemas.generated';

const ProductWithCacheSchema = ProductSchema.extend({
  _cached_at: z.string().datetime(),
});
void ProductWithCacheSchema;

const ProductWithoutDescriptionSchema = ProductSchema.omit({
  description: true,
});
void ProductWithoutDescriptionSchema;

const ProductIdentifierSchema = ProductSchema.pick({
  product_id: true,
});
void ProductIdentifierSchema;

// Pass 4 (`unwrapNamedRecordUnionIntersections`) target schemas: the
// `SizeModeMutexSchema.and(z.object(...))` form previously left these as
// `ZodIntersection`. Type-level assertion that helpers come back — a
// future codegen regression here surfaces at compile time instead of
// only via the `.d.ts` regression grep.
const DisplayTagExtended = CanonicalFormatDisplayTagSchema.extend({
  _adopter_marker: z.string(),
});
void DisplayTagExtended;

const ImagePicked = CanonicalFormatImageSchema.pick({ experimental: true });
void ImagePicked;

const HTML5BannerOmitted = CanonicalFormatHTML5BannerSchema.omit({
  deprecated: true,
});
void HTML5BannerOmitted;
