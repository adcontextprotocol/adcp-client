import { z } from 'zod';
import { GetProductsRequestSchema as GeneratedGetProductsRequestSchema } from '../types/schemas.generated';
import { GetProductsRequest_FieldsValues } from '../types/inline-enums.generated';
import type { CanonicalGetProductsRequest } from '../v2/projection/creative-delivery';

type LooseObjectShapeFor<T extends object> = {
  [K in keyof T]-?: undefined extends T[K]
    ? z.ZodOptional<z.ZodType<Exclude<T[K], undefined>, Exclude<T[K], undefined>>>
    : z.ZodType<T[K], T[K]>;
};

type ZodShapeOutput<U extends z.core.$ZodShape> = {
  [K in keyof U as undefined extends z.output<U[K]> ? never : K]: z.output<U[K]>;
} & {
  [K in keyof U as undefined extends z.output<U[K]> ? K : never]?: z.output<U[K]>;
};

/** Portable loose-object facade retained across adopter declaration emit. */
export type LooseObjectSchemaFor<T extends object> = {
  extend<U extends z.core.$ZodShape>(shape: U): LooseObjectSchemaFor<Omit<T, keyof U> & ZodShapeOutput<U>>;
} & z.ZodObject<LooseObjectShapeFor<T>, z.core.$loose> &
  z.ZodType<T & Record<string, unknown>, T & Record<string, unknown>>;

/** Wire-compatible request schema, including the legacy `format_ids` selector. */
export const LegacyGetProductsRequestSchema = GeneratedGetProductsRequestSchema;

type CanonicalGetProductsField = NonNullable<CanonicalGetProductsRequest['fields']>[number];
const canonicalGetProductsFields = /* @__PURE__ */ GetProductsRequest_FieldsValues.filter(
  (field): field is CanonicalGetProductsField => field !== 'format_ids'
) as [CanonicalGetProductsField, ...CanonicalGetProductsField[]];

/** Primary request schema; legacy `format_ids` selection is rejected. */
export const GetProductsRequestSchema = /* @__PURE__ */ (() =>
  GeneratedGetProductsRequestSchema.safeExtend({
    fields: z.array(z.enum(canonicalGetProductsFields)).optional(),
  }))() as unknown as LooseObjectSchemaFor<CanonicalGetProductsRequest>;
