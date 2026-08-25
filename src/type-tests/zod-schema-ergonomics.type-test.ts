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
  MediaBuyFeaturesSchema,
  ProductSchema,
  PackageSchema,
  PackageRequestSchema,
  PackageUpdateSchema,
  GetProductsResponseSchema,
  ProductFormatDeclarationSchema,
  PlacementSchema,
  FormatSchema,
  TransformerSchema,
  AvailablePackageSchema,
  ListCreativeFormatsResponseSchema,
  PackageStatusSchema,
  ListTransformersResponseCreativeAgentSchema,
  GetAdCPCapabilitiesResponseSchema,
  ListTransformersResponseSchema,
} from '../lib/types/schemas.generated';
import type { Format, AvailablePackage, PackageUpdate } from '../lib/types/core.generated';
import type {
  GetProductsResponse,
  Package,
  PackageRequest,
  Product,
  ProductFormatDeclaration,
  Placement,
  Transformer,
  ListCreativeFormatsResponse,
  PackageStatus,
  ListTransformersResponseCreativeAgent,
  GetAdCPCapabilitiesResponse,
  ListTransformersResponse,
} from '../lib/types/tools.generated';

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

void ProductSchema.shape.reporting_capabilities;
PackageSchema.pick({ package_id: true });
PackageRequestSchema.extend({ _buyer_note: z.string().optional() });
PackageUpdateSchema.omit({ paused: true });
GetProductsResponseSchema.pick({ status: true });

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

// Typed record/object intersections should also stay object-shaped. The
// catchall preserves additional-property validation while keeping helpers.
const MediaBuyFeaturesExtended = MediaBuyFeaturesSchema.extend({
  _evaluated_at: z.string().datetime(),
});
void MediaBuyFeaturesExtended;

// Beta.6 expansion pushed these declarations across TS7056's serialization
// threshold. Their explicit annotations must retain parse output types and,
// for object schemas, the public composition helpers.
declare const unknownInput: unknown;
const product: Product = ProductSchema.parse(unknownInput);
const mediaPackage: Package = PackageSchema.parse(unknownInput);
const packageRequest: PackageRequest = PackageRequestSchema.parse(unknownInput);
const packageUpdate: PackageUpdate = PackageUpdateSchema.parse(unknownInput);
const productsResponse: GetProductsResponse = GetProductsResponseSchema.parse(unknownInput);
const productFormat: ProductFormatDeclaration = ProductFormatDeclarationSchema.parse(unknownInput);
const placement: Placement = PlacementSchema.parse(unknownInput);
const format: Format = FormatSchema.parse(unknownInput);
const transformer: Transformer = TransformerSchema.parse(unknownInput);
const availablePackage: AvailablePackage = AvailablePackageSchema.parse(unknownInput);
const formatsResponse: ListCreativeFormatsResponse = ListCreativeFormatsResponseSchema.parse(unknownInput);
const packageStatus: PackageStatus = PackageStatusSchema.parse(unknownInput);
const transformerResponse: ListTransformersResponseCreativeAgent =
  ListTransformersResponseCreativeAgentSchema.parse(unknownInput);
const capabilities: GetAdCPCapabilitiesResponse = GetAdCPCapabilitiesResponseSchema.parse(unknownInput);
const listTransformers: ListTransformersResponse = ListTransformersResponseSchema.parse(unknownInput);
void [
  product,
  mediaPackage,
  packageRequest,
  packageUpdate,
  productsResponse,
  productFormat,
  placement,
  format,
  transformer,
  availablePackage,
  formatsResponse,
  packageStatus,
  transformerResponse,
  capabilities,
  listTransformers,
];

ProductFormatDeclarationSchema.pick({ format_kind: true });
FormatSchema.pick({ format_id: true });
TransformerSchema.pick({ transformer_id: true });
AvailablePackageSchema.pick({ package_id: true });
ListCreativeFormatsResponseSchema.pick({ formats: true });
PackageStatusSchema.pick({ package_id: true });
ListTransformersResponseCreativeAgentSchema.pick({ transformers: true });
GetAdCPCapabilitiesResponseSchema.pick({ status: true });
ListTransformersResponseSchema.pick({ transformers: true });
