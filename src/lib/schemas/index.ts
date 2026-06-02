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

import type { z } from 'zod';
import * as schemas from '../types/schemas.generated';
import { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';
import type { KnownToolRequestSchemas } from '../utils/tool-request-schemas';

export * from '../types/schemas.generated';
export { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';
export { TOOL_RESPONSE_SCHEMAS } from '../utils/response-schemas';
export {
  SyncCreativesItemSchema,
  SyncCreativesSuccessStrictSchema,
  SyncCreativesResponseStrictSchema,
  SyncCreativesActionSchema,
} from '../validation/sync-creatives';
export type { SyncCreativesItem, SyncCreativesSuccessStrict } from '../validation/sync-creatives';

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
