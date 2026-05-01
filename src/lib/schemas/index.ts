/**
 * Consolidated schema exports for MCP tool registration.
 *
 * The generated Zod schemas in `../types/schemas.generated` cover every
 * AdCP tool — the framework-registered {@link AdcpToolMap} tools AND
 * tools like `creative_approval` / `update_rights` that ship as
 * `customTools` extensions because the spec models them as out-of-band
 * callbacks rather than MCP-registered surfaces.
 *
 * This module re-exports the generated schemas plus two convenience
 * helpers for the `customTools` registration path:
 *
 *   - {@link TOOL_INPUT_SHAPES}: `toolName → inputSchema` map, ready to
 *     pass as `inputSchema` to MCP SDK's `server.registerTool()`. Uses
 *     the same tool-name keys as `AdcpServerConfig.customTools`.
 *   - {@link customToolFor}: sugar for registering a single custom tool
 *     with type-safe `handler` params derived from the schema's shape.
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

export * from '../types/schemas.generated';
export { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';

type InputShape = Record<string, z.ZodType>;

function shapeOf(s: unknown): InputShape | undefined {
  if (!s) return undefined;
  const candidate = (s as { shape?: InputShape }).shape;
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
 * et al.) PLUS the two tools the spec models as customTool-only
 * extensions — `creative_approval` and `update_rights` — so sellers
 * don't have to hand-author shapes for those either.
 *
 * If a future AdCP release adds a new tool with a generated request
 * schema, add its entry here (or to `TOOL_REQUEST_SCHEMAS` if it's
 * framework-registrable) — CI's `ci:schema-check` catches missing
 * map entries by diffing against the generated schemas.
 */
export const TOOL_INPUT_SHAPES: Readonly<Record<string, Readonly<InputShape>>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(TOOL_REQUEST_SCHEMAS).flatMap(([k, s]) => {
      const shape = shapeOf(s);
      return shape ? [[k, shape] as const] : [];
    })
  ),
  creative_approval: schemas.CreativeApprovalRequestSchema.shape,
  update_rights: schemas.UpdateRightsRequestSchema.shape,
});

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
