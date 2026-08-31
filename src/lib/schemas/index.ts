/**
 * Consolidated schema exports for MCP tool registration.
 *
 * The generated Zod schemas in `../types/schemas.generated` cover every
 * AdCP tool — the framework-registered {@link AdcpToolMap} tools AND
 * tools like `creative_approval`, `search_brands`, and brand verification
 * tasks that ship as `customTools` extensions because the spec models them
 * outside the SDK's framework-registered surface.
 *
 * This module re-exports the generated schemas plus two convenience
 * helpers for the `customTools` registration path:
 *
 *   - {@link TOOL_INPUT_SHAPES}: `toolName → raw Zod shape` map, ready to
 *     pass as `inputSchema` to MCP SDK's `server.registerTool()` when the
 *     request schema is a ZodObject.
 *   - {@link TOOL_INPUT_SCHEMAS}: `toolName → full Zod schema` map for
 *     custom tools whose request schema is a union/intersection and cannot
 *     be represented as a raw shape without weakening validation.
 *   - {@link TOOL_RESPONSE_SCHEMAS}: `toolName → full Zod response schema`
 *     map for response validation and compliance tooling.
 *   - {@link customToolFor}: sugar for registering a single custom tool
 *     with type-safe `handler` params derived from the schema's shape.
 *   - {@link customToolForSchema}: same sugar for full Zod schemas.
 *   - {@link treatOptionalNullsAsAbsent}: reads a seller's explicit `null` as
 *     an omitted field wherever the schema declares it optional and
 *     non-nullable, so one unreported hint doesn't discard a whole response.
 *
 * ```ts
 * import { createAdcpServer } from '@adcp/sdk/server/legacy/v5';
 * import { TOOL_INPUT_SHAPES, customToolFor } from '@adcp/sdk/schemas';
 *
 * createAdcpServer({
 *   customTools: {
 *     creative_approval: customToolFor(
 *       'creative_approval',
 *       'Accept a buyer creative for approval.',
 *       TOOL_INPUT_SHAPES.creative_approval,
 *       async (args, extra) => { ... },
 *     ),
 *   },
 *   ...,
 * });
 * ```
 */

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';
import { GetProductsRequest_FieldsValues } from '../types/inline-enums.generated';
import type { CanonicalGetProductsRequest } from '../v2/projection/creative-delivery';
import { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';
import type { KnownToolRequestSchemas } from '../utils/tool-request-schemas';
import {
  getToolSchemaDocument,
  type ResolvedToolSchemaDocument,
  type ResponseVariant,
} from '../validation/schema-loader';
import { resolveAdcpVersion } from '../utils/adcp-version-config';

export * from '../types/schemas.generated';
export { treatOptionalNullsAsAbsent } from './optional-nulls';

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
export const LegacyGetProductsRequestSchema = schemas.GetProductsRequestSchema;

type CanonicalGetProductsField = NonNullable<CanonicalGetProductsRequest['fields']>[number];
const canonicalGetProductsFields = GetProductsRequest_FieldsValues.filter(
  (field): field is CanonicalGetProductsField => field !== 'format_ids'
) as [CanonicalGetProductsField, ...CanonicalGetProductsField[]];

/** Primary request schema; legacy `format_ids` selection is rejected. */
export const GetProductsRequestSchema = schemas.GetProductsRequestSchema.safeExtend({
  fields: z.array(z.enum(canonicalGetProductsFields)).optional(),
}) as unknown as LooseObjectSchemaFor<CanonicalGetProductsRequest>;

export { BiddingPolicySchema } from '../validation/bidding-policy';
export { CanonicalBudgetAllocationSchema } from '../validation/budget-allocation';
export { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';
export { TOOL_RESPONSE_SCHEMAS } from '../utils/response-schemas';
export {
  SyncCreativesItemSchema,
  SyncCreativesSuccessStrictSchema,
  SyncCreativesResponseStrictSchema,
  SyncCreativesActionSchema,
} from '../validation/sync-creatives';
export type { SyncCreativesItem, SyncCreativesSuccessStrict } from '../validation/sync-creatives';

export interface ToolSchemaLookupOptions {
  /** AdCP release/minor/legacy alias resolved through the bundled schema loader. */
  adcpVersion?: string;
}

export interface ToolResponseSchemaLookupOptions extends ToolSchemaLookupOptions {
  /** Response arm to retrieve. Defaults to the synchronous response schema. */
  variant?: ResponseVariant;
}

export type VersionedToolSchema = ResolvedToolSchemaDocument;

/** Retrieve the protocol-authored request JSON Schema for a specific AdCP release. */
export function getToolInputSchema(
  toolName: string,
  options: ToolSchemaLookupOptions = {}
): VersionedToolSchema | undefined {
  return getToolSchemaDocument(toolName, 'request', resolveAdcpVersion(options.adcpVersion));
}

/** Retrieve a protocol-authored response JSON Schema for a specific AdCP release. */
export function getToolResponseSchema(
  toolName: string,
  options: ToolResponseSchemaLookupOptions = {}
): VersionedToolSchema | undefined {
  return getToolSchemaDocument(toolName, options.variant ?? 'sync', resolveAdcpVersion(options.adcpVersion));
}

type InputShape = Record<string, z.ZodType>;
type InputSchema = z.ZodType;
type ShapeOf<T> = T extends { shape: infer TShape extends InputShape } ? TShape : never;
type ToolInputShapes = {
  [K in keyof KnownToolRequestSchemas]: ShapeOf<KnownToolRequestSchemas[K]>;
} & {
  creative_approval: typeof schemas.CreativeApprovalRequestSchema.shape;
  search_brands: typeof schemas.SearchBrandsRequestSchema.shape;
  verify_brand_claims: typeof schemas.VerifyBrandClaimsRequestBulkSchema.shape;
} & {
  readonly [toolName: string]: Readonly<InputShape> | undefined;
};

type ToolInputSchemas = {
  [K in keyof KnownToolRequestSchemas]: KnownToolRequestSchemas[K];
} & {
  creative_approval: typeof schemas.CreativeApprovalRequestSchema;
  search_brands: typeof schemas.SearchBrandsRequestSchema;
  verify_brand_claim: typeof schemas.VerifyBrandClaimRequestSchema;
  verify_brand_claims: typeof schemas.VerifyBrandClaimsRequestBulkSchema;
} & {
  readonly [toolName: string]: InputSchema | undefined;
};

function shapeOf<T extends { shape?: InputShape }>(s: T | undefined): T['shape'] | undefined {
  const candidate = s?.shape;
  return candidate && typeof candidate === 'object' ? candidate : undefined;
}

/**
 * Map of every known AdCP tool name to its Zod input shape — i.e., the
 * `.shape` of its request schema, ready to pass as `inputSchema` to MCP
 * SDK's `server.registerTool()`.
 *
 * Superset of {@link TOOL_REQUEST_SCHEMAS}: covers every tool already
 * registered with the framework (get_products, create_media_buy,
 * sync_catalogs, check_governance, comply_test_controller, all five
 * *_collection_list tools, validate_property_delivery, acquire_rights,
 * et al.) PLUS shape-compatible custom surfaces such as `creative_approval`,
 * `search_brands`, and `verify_brand_claims` so sellers don't have to
 * hand-author shapes for those either.
 *
 * `verify_brand_claim` is intentionally not present here: its request schema
 * is an envelope intersected with a claim-variant union, so use
 * {@link TOOL_INPUT_SCHEMAS} with {@link customToolForSchema} to preserve the
 * discriminated union at validation time.
 *
 * Known tool names retain exact `.shape` field types for IDE completion and
 * handler inference. Arbitrary string lookups return `undefined` until callers
 * narrow the tool name to a known key.
 *
 * If a future AdCP release adds a new tool with a generated request
 * schema, add its entry here (or to `TOOL_REQUEST_SCHEMAS` if it's
 * framework-registrable) — CI's `ci:schema-check` catches missing
 * map entries by diffing against the generated schemas.
 */
export const TOOL_INPUT_SHAPES = Object.freeze({
  ...Object.fromEntries(
    Object.entries(TOOL_REQUEST_SCHEMAS).map(([k, s]) => {
      const shape = shapeOf(s);
      if (!shape) {
        throw new Error(
          `TOOL_REQUEST_SCHEMAS["${k}"] has no .shape — schema must be a ZodObject (use merge() not and())`
        );
      }
      return [k, shape] as const;
    })
  ),
  creative_approval: schemas.CreativeApprovalRequestSchema.shape,
  search_brands: schemas.SearchBrandsRequestSchema.shape,
  verify_brand_claims: schemas.VerifyBrandClaimsRequestBulkSchema.shape,
}) as Readonly<ToolInputShapes>;

/**
 * Map of known AdCP tool names to their full generated Zod request schemas.
 *
 * Prefer {@link TOOL_INPUT_SHAPES} when registering a shape-compatible tool
 * with `registerTool()`. Use this map for union/intersection request schemas,
 * notably `verify_brand_claim`, where a raw shape would lose the correlation
 * between `claim_type` and the corresponding `claim` payload.
 */
export const TOOL_INPUT_SCHEMAS = Object.freeze({
  ...TOOL_REQUEST_SCHEMAS,
  creative_approval: schemas.CreativeApprovalRequestSchema,
  search_brands: schemas.SearchBrandsRequestSchema,
  verify_brand_claim: schemas.VerifyBrandClaimRequestSchema,
  verify_brand_claims: schemas.VerifyBrandClaimsRequestBulkSchema,
}) as Readonly<ToolInputSchemas>;

/**
 * Register a custom tool with MCP-compatible `inputSchema` + handler
 * wiring. Returns an object shaped for
 * `AdcpServerConfig.customTools[name]` — pass it straight through.
 *
 * Why it exists: sellers adding tools outside `AdcpToolMap` have to
 * publish an `inputSchema` via `tools/list` (MCP spec requirement). Doing
 * that by hand means authoring a Zod shape that matches the generated
 * AdCP spec schema — easy to drift silently. Using this helper guarantees
 * the advertised shape is the same shape the SDK validates the request
 * against.
 */
export function customToolFor<TShape extends InputShape>(
  name: string,
  description: string,
  inputSchema: TShape,
  handler: (args: z.input<z.ZodObject<TShape>>, extra?: unknown) => unknown | Promise<unknown>
): {
  description: string;
  inputSchema: TShape;
  handler: (args: z.input<z.ZodObject<TShape>>, extra?: unknown) => unknown | Promise<unknown>;
} {
  // `name` participates in the return contract's narrowing only indirectly
  // (via the caller's key when spread into `customTools`). Callers retain
  // it as a parameter so future stricter registration (logging, metrics,
  // schema-registry lookups) can be added without an API break.
  void name;
  return { description, inputSchema, handler };
}

/**
 * Register a custom tool whose MCP `inputSchema` is a full Zod schema rather
 * than a raw shape. Use this for request schemas with top-level unions or
 * intersections, where `.shape` would either be unavailable or would weaken
 * runtime validation.
 */
export function customToolForSchema<TSchema extends InputSchema>(
  name: string,
  description: string,
  inputSchema: TSchema,
  handler: (args: z.input<TSchema>, extra?: unknown) => unknown | Promise<unknown>
): {
  description: string;
  inputSchema: TSchema;
  handler: (args: z.input<TSchema>, extra?: unknown) => unknown | Promise<unknown>;
} {
  void name;
  return { description, inputSchema, handler };
}
