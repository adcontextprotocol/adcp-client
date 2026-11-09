/**
 * Capability-keyed projection of JSON Schemas through the proposed
 * `x-adcp-applies-when` annotation.
 *
 * PROTOTYPE for adcontextprotocol/adcp#8452 (RFC) and adcontextprotocol/adcp#8454
 * (annotation), which target AdCP 3.3. Bundled AdCP schemas do not carry the
 * annotation yet, so against them every projection here is a no-op. The
 * semantics follow `docs/reference/schema-extensions.mdx#x-adcp-applies-when`
 * in the spec repo (RFC revision of 2026-10-24) and may change with the RFC.
 *
 * ```jsonc
 * "floor_price": {
 *   "x-adcp-applies-when": { "delivery_types": ["non_guaranteed"] },
 *   "type": "number"
 * }
 * ```
 *
 * - `delivery_types` matches `media_buy.supported_delivery_types` and
 *   `pricing_models` matches `media_buy.supported_pricing_models`. When the
 *   list is undeclared, the key matches (fail open).
 * - `capabilities` holds dotted paths into the `get_adcp_capabilities`
 *   response. A path matches when it is present, not `null`, and not `false`;
 *   absence doesn't match, because capability blocks declare support by being
 *   present.
 * - When the agent publishes no block at a key's root (for example, a
 *   governance agent has no `media_buy`), the key matches.
 * - Any match across all keys keeps the property (OR).
 * - Dropping only deletes from `properties`. Required properties and
 *   properties of closed objects are never dropped.
 *
 * @module
 */

/** The annotation keyword this module reads. @experimental */
export const APPLIES_WHEN_KEYWORD = 'x-adcp-applies-when';

/**
 * Value of an `x-adcp-applies-when` annotation. @experimental
 */
export interface AppliesWhen {
  /** `delivery-type` enum values, matched against `media_buy.supported_delivery_types`. */
  delivery_types?: readonly string[];
  /** `pricing-model` enum values, matched against `media_buy.supported_pricing_models`. */
  pricing_models?: readonly string[];
  /** Dotted paths into the `get_adcp_capabilities` response, such as `media_buy.conversion_tracking`. */
  capabilities?: readonly string[];
}

type JsonObject = Record<string, unknown>;

/** Annotation keys matched against a declared capability list. */
const DECLARED_LIST_KEYS: Readonly<Record<string, string>> = {
  delivery_types: 'media_buy.supported_delivery_types',
  pricing_models: 'media_buy.supported_pricing_models',
};

/** Keywords whose value is a map of name to subschema. `properties` is handled separately. */
const SCHEMA_MAP_KEYWORDS = ['$defs', 'definitions', 'patternProperties', 'dependentSchemas'] as const;
/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
/** Keywords whose value is a single subschema (`items` may also be a draft-07 tuple array). */
const SCHEMA_KEYWORDS = [
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
] as const;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPath(root: unknown, dottedPath: string): unknown {
  let current: unknown = root;
  for (const segment of dottedPath.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** True when the agent publishes no block at the root of a multi-segment path. */
function rootBlockAbsent(capabilities: JsonObject, dottedPath: string): boolean {
  const dot = dottedPath.indexOf('.');
  if (dot <= 0) return false;
  const root = capabilities[dottedPath.slice(0, dot)];
  return root === undefined || root === null;
}

/**
 * Decide whether an `x-adcp-applies-when` annotation keeps its property for an
 * agent with the given `get_adcp_capabilities` response.
 *
 * Returns `true` (keep) on any match. A key also matches when its list is
 * undeclared (`delivery_types`, `pricing_models`) or when the agent publishes
 * no block at the key's root. Annotations this SDK can't evaluate (malformed
 * values, unknown keys) keep the property.
 *
 * @experimental Prototype for adcontextprotocol/adcp#8452. Semantics may change.
 */
export function appliesWhenSatisfied(annotation: unknown, capabilities: unknown): boolean {
  if (!isObject(annotation) || !isObject(capabilities)) return true;
  const entries = Object.entries(annotation);
  if (entries.length === 0) return true;
  for (const [key, values] of entries) {
    if (!Array.isArray(values) || values.length === 0) return true;
    const declaredPath = DECLARED_LIST_KEYS[key];
    if (declaredPath !== undefined) {
      const declared = readPath(capabilities, declaredPath);
      // Undeclared is not empty: an absent (or invalid, empty) list matches.
      // This also covers an agent with no `media_buy` block at all.
      if (!Array.isArray(declared) || declared.length === 0) return true;
      if (values.some(value => declared.includes(value))) return true;
    } else if (key === 'capabilities') {
      if (
        values.some(path => {
          if (typeof path !== 'string') return true;
          if (rootBlockAbsent(capabilities, path)) return true;
          const value = readPath(capabilities, path);
          return value !== undefined && value !== null && value !== false;
        })
      ) {
        return true;
      }
    } else {
      // A key this SDK doesn't know may match; keep rather than guess.
      return true;
    }
  }
  return false;
}

/**
 * Names the parent requires anywhere, failing closed: its own `required`;
 * every `allOf` / `anyOf` / `oneOf` arm and `if` / `then` / `else` branch,
 * recursively (so a name that appears only in an `if` condition's `required`
 * counts); draft-07 `dependencies` (array form and schema form); and the
 * 2020-12 `dependentRequired` / `dependentSchemas` equivalents. Mirrors
 * `requiredNames` in the spec repo's `scripts/lint-applies-when.cjs`.
 */
function requiredNames(parent: unknown, names: Set<string> = new Set()): Set<string> {
  if (!isObject(parent)) return names;
  const addAll = (list: unknown) => {
    if (Array.isArray(list)) for (const name of list) if (typeof name === 'string') names.add(name);
  };
  addAll(parent.required);
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const arms = parent[keyword];
    if (Array.isArray(arms)) for (const arm of arms) requiredNames(arm, names);
  }
  for (const keyword of ['if', 'then', 'else'] as const) requiredNames(parent[keyword], names);
  for (const keyword of ['dependencies', 'dependentRequired', 'dependentSchemas'] as const) {
    const map = parent[keyword];
    if (!isObject(map)) continue;
    for (const dependency of Object.values(map)) {
      if (Array.isArray(dependency)) addAll(dependency);
      else requiredNames(dependency, names);
    }
  }
  return names;
}

// Maps are rebuilt with Object.fromEntries, which defines own properties, so a
// property literally named `__proto__` survives as data.
function projectSchemaMap(map: JsonObject, capabilities: JsonObject): JsonObject {
  let changed = false;
  const entries = Object.entries(map).map(([name, subschema]): [string, unknown] => {
    const projected = projectNode(subschema, capabilities);
    if (projected !== subschema) changed = true;
    return [name, projected];
  });
  return changed ? Object.fromEntries(entries) : map;
}

function projectProperties(properties: JsonObject, parent: JsonObject, capabilities: JsonObject): JsonObject {
  // Deleting a property from a closed object would forbid it (a tightening),
  // and the spec forbids annotating there. Defensively drop nothing.
  const closed = parent.additionalProperties === false || parent.unevaluatedProperties === false;
  let required: Set<string> | undefined;
  let changed = false;
  const entries: Array<[string, unknown]> = [];
  for (const [name, subschema] of Object.entries(properties)) {
    if (
      !closed &&
      isObject(subschema) &&
      APPLIES_WHEN_KEYWORD in subschema &&
      !appliesWhenSatisfied(subschema[APPLIES_WHEN_KEYWORD], capabilities) &&
      !(required ??= requiredNames(parent)).has(name)
    ) {
      changed = true;
      continue;
    }
    const projected = projectNode(subschema, capabilities);
    if (projected !== subschema) changed = true;
    entries.push([name, projected]);
  }
  return changed ? Object.fromEntries(entries) : properties;
}

function projectSchemaArray(arms: unknown[], capabilities: JsonObject): unknown[] {
  let changed = false;
  const out = arms.map(arm => {
    const projected = projectNode(arm, capabilities);
    if (projected !== arm) changed = true;
    return projected;
  });
  return changed ? out : arms;
}

function projectNode(node: unknown, capabilities: JsonObject): unknown {
  if (!isObject(node)) return node;
  let out: JsonObject | undefined;
  const update = (key: string, value: unknown) => {
    if (value === node[key]) return;
    out ??= { ...node };
    out[key] = value;
  };

  if (isObject(node.properties)) update('properties', projectProperties(node.properties, node, capabilities));
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const value = node[keyword];
    if (isObject(value)) update(keyword, projectSchemaMap(value, capabilities));
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const value = node[keyword];
    if (Array.isArray(value)) update(keyword, projectSchemaArray(value, capabilities));
  }
  for (const keyword of SCHEMA_KEYWORDS) {
    const value = node[keyword];
    if (Array.isArray(value)) update(keyword, projectSchemaArray(value, capabilities));
    else if (isObject(value)) update(keyword, projectNode(value, capabilities));
  }
  return out ?? node;
}

/**
 * Return `schema` without the optional properties whose `x-adcp-applies-when`
 * annotation doesn't apply to an agent with the given `get_adcp_capabilities`
 * response. Pass the agent's own, server-wide capabilities: keys are
 * seller-global.
 *
 * - **Dropping only deletes from `properties`.** Nothing else changes: no
 *   renames, retypes, or required fields; `additionalProperties`, `required`,
 *   enum values, and `$defs` entries are left as they are.
 * - **Never drops a required property**, even if annotated, wherever the
 *   parent requires it: `required`, `allOf` / `anyOf` / `oneOf` arms,
 *   `if` / `then` / `else` (including names only in `if`), and
 *   `dependencies` / `dependentRequired` / `dependentSchemas`.
 * - **Never drops from a closed object** (`additionalProperties: false` or
 *   `unevaluatedProperties: false`). The spec forbids both placements; these
 *   are defensive guards.
 * - **Nesting.** A dropped property takes its whole subtree with it, so a
 *   property survives only when it and every ancestor property match.
 * - **Pure.** The input is never mutated. Unchanged subtrees are shared by
 *   reference with the input, and the input itself is returned when nothing
 *   is removed, so treat the result as read-only.
 * - **Walks** `properties`, `items` / `prefixItems`, `allOf` / `anyOf` /
 *   `oneOf`, `if` / `then` / `else`, `not`, `additionalProperties`,
 *   `patternProperties`, `dependentSchemas`, and `$defs` / `definitions`.
 *   Values under `const`, `default`, `enum`, `examples`, and `x-*` keywords
 *   are instance data and are left alone.
 * - **`$ref`s are left in place.** The annotation is read from the property
 *   declaration before any dereferencing. A local reference (`#/...`, or the
 *   document's own `$id` plus a fragment, as in the bundled MCP tool schemas)
 *   points into the same document, which this function projects as a whole,
 *   so the reference sees the projected target and projects the same way in
 *   every context. No inlining, so no cycles. References to other documents
 *   aren't followed.
 * - With no capabilities object (`undefined` / `null`), the input is returned
 *   unchanged.
 *
 * Not handled: the spec says projections SHOULD NOT be applied to schemas of
 * records the buyer already accepted (committed proposal or media-buy
 * snapshots). This function can't tell such schemas apart; don't pass them.
 *
 * @example
 * ```ts
 * import { projectSchemaForCapabilities } from '@adcp/sdk/schemas';
 *
 * const narrowed = projectSchemaForCapabilities(productSchema, {
 *   media_buy: { supported_delivery_types: ['guaranteed'] },
 * });
 * // `floor_price` / `price_guidance` (annotated non_guaranteed) are gone.
 * ```
 *
 * @experimental Prototype for adcontextprotocol/adcp#8452 / #8454 (AdCP 3.3).
 * Not production-hardened; the annotation semantics may change with the RFC.
 */
export function projectSchemaForCapabilities<T>(schema: T, capabilities: unknown): T {
  if (!isObject(capabilities)) return schema;
  return projectNode(schema, capabilities) as T;
}
