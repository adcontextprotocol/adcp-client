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
  GetProductsRequestSchema as LegacyGetProductsRequestSchema,
  GetProductsResponseSchema,
  PublisherPropertySelectorSchema,
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
import { GetProductsRequestSchema } from '../lib/schemas';
import type { Format, AvailablePackage, PackageUpdate } from '../lib/types/core.generated';
import type { CanonicalGetProductsRequest } from '../lib/v2/projection/creative-delivery';
import type {
  GetProductsResponse,
  GetProductsRequest,
  Package,
  PackageRequest,
  Product,
  PublisherPropertySelector,
  ProductFormatDeclaration,
  Placement,
  Transformer,
  ListCreativeFormatsResponse,
  PackageStatus,
  ListTransformersResponseCreativeAgent,
  GetAdCPCapabilitiesResponse,
  ListTransformersResponse,
} from '../lib/types/tools.generated';

declare const unknownInput: unknown;

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

// Published-package consumer composition must preserve the concrete field
// bindings, not only expose the ZodObject helper names.
const ProductOutputExtensionsSchema = z.object({
  publisher_properties: z.array(PublisherPropertySelectorSchema),
});
const CompatibleProductSchema = ProductSchema.safeExtend(ProductOutputExtensionsSchema.shape);
const StagedCompatibleProductSchema = CompatibleProductSchema.safeExtend({
  placements: z.array(z.object({ placement_id: z.string(), name: z.string() })).optional(),
});
const ConsumerProductSchema = ProductSchema.safeExtend({
  publisher_properties: z.array(z.object({ property_id: z.string() })).optional(),
});
const StagedConsumerProductSchema = ConsumerProductSchema.safeExtend({
  placements: z.array(z.object({ placement_id: z.string(), name: z.string() })).optional(),
});
function acceptZodObject<T extends z.ZodObject>(schema: T): T {
  return schema;
}
acceptZodObject(ProductSchema);
acceptZodObject(StagedConsumerProductSchema);
acceptZodObject(StagedCompatibleProductSchema);
declare const consumerProduct: z.output<typeof ConsumerProductSchema>;
const consumerProductId: string = consumerProduct.product_id;
void consumerProductId;
declare const stagedConsumerProduct: z.output<typeof StagedConsumerProductSchema>;
const stagedPublisherProperties: Array<{ property_id: string }> | undefined =
  stagedConsumerProduct.publisher_properties;
void stagedPublisherProperties;
ProductSchema.safeExtend({
  // @ts-expect-error Product compatibility bridges still require Zod schemas.
  publisher_properties: 123,
});
ProductSchema.safeExtend({
  // @ts-expect-error Product compatibility bridges still require Zod schemas.
  placements: 123,
});
ProductSchema.safeExtend({
  // @ts-expect-error Unbridged Product fields retain normal safeExtend compatibility checks.
  name: z.number(),
});
const ProductChannelsSchema = ProductSchema.pick({ channels: true });
const productChannelsInput: z.input<typeof ProductChannelsSchema> = {};
void productChannelsInput;
const ProductWithPlacementsSchema = ProductSchema.safeExtend({
  placements: z
    .array(
      z.object({
        placement_id: z.string(),
        name: z.string(),
      })
    )
    .optional(),
});
declare const productWithPlacements: z.output<typeof ProductWithPlacementsSchema>;
const productPublisherProperties: PublisherPropertySelector[] = productWithPlacements.publisher_properties;
void productPublisherProperties;
const ExtendedGetProductsResponseSchema = GetProductsResponseSchema.extend({
  products: z.array(ProductSchema),
}).partial();
const extendedProductsResponse = ExtendedGetProductsResponseSchema.safeParse(unknownInput);
if (extendedProductsResponse.success) {
  extendedProductsResponse.data.products?.map(item => item.product_id);
}
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;
type Assert<T extends true> = T;
type ExtendedProduct = NonNullable<z.output<typeof ExtendedGetProductsResponseSchema>['products']>[number];
type ExtendedProductIsTyped = Assert<IsAny<ExtendedProduct> extends false ? true : false>;
type ProductWithPlacementsPublisherProperties = z.output<typeof ProductWithPlacementsSchema>['publisher_properties'];
type ProductWithPlacementsPublisherPropertiesIsTyped = Assert<
  IsAny<ProductWithPlacementsPublisherProperties> extends false
    ? IsNever<ProductWithPlacementsPublisherProperties> extends false
      ? true
      : false
    : false
>;
const PickedProductPublisherPropertiesSchema = ProductSchema.pick({ publisher_properties: true });
type PickedPublisherProperties = z.output<typeof PickedProductPublisherPropertiesSchema>['publisher_properties'];
type PickedPublisherPropertiesIsTyped = Assert<
  IsAny<PickedPublisherProperties> extends false
    ? IsNever<PickedPublisherProperties> extends false
      ? true
      : false
    : false
>;
declare const pickedPublisherProperties: PickedPublisherProperties;
const pickedPublisherPropertiesAsPublic: PublisherPropertySelector[] = pickedPublisherProperties;
void (null as unknown as ExtendedProductIsTyped);
void (null as unknown as ProductWithPlacementsPublisherPropertiesIsTyped);
void (null as unknown as PickedPublisherPropertiesIsTyped);
void pickedPublisherPropertiesAsPublic;
type InferredPackage = z.infer<typeof PackageSchema>;
declare const inferredPackage: InferredPackage;
const inferredPackageAsPublic: Package = inferredPackage;
declare const publicPackage: Package;
const publicPackageAsInferred: InferredPackage = publicPackage;
void inferredPackageAsPublic;
void publicPackageAsInferred;

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
const product: Product = ProductSchema.parse(unknownInput);
const mediaPackage: Package = PackageSchema.parse(unknownInput);
const packageRequest: PackageRequest = PackageRequestSchema.parse(unknownInput);
const packageUpdate: PackageUpdate = PackageUpdateSchema.parse(unknownInput);
const productsResponse: GetProductsResponse = GetProductsResponseSchema.parse(unknownInput);
const getProductsRequest: GetProductsRequest = LegacyGetProductsRequestSchema.parse(unknownInput);
const minimalGetProductsRequestInput: z.input<typeof GetProductsRequestSchema> = {
  buying_mode: 'brief',
};
const extendedGetProductsRequest = GetProductsRequestSchema.extend({
  local_extension: z.string().optional(),
}).parse({ buying_mode: 'wholesale' }) satisfies CanonicalGetProductsRequest & {
  local_extension?: string;
};
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
  getProductsRequest,
  minimalGetProductsRequestInput,
  extendedGetProductsRequest,
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
