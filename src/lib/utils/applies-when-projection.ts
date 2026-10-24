/**
 * Capability-keyed projection of JSON Schemas through the proposed
 * `x-adcp-applies-when` annotation.
 *
 * PROTOTYPE for adcontextprotocol/adcp#8452 (RFC) and adcontextprotocol/adcp#8454
 * (annotation), which target AdCP 3.3. Bundled AdCP schemas do not carry the
 * annotation yet, so against them every projection here is a no-op. The
 * semantics follow `docs/reference/schema-extensions.mdx#x-adcp-applies-when`
 * in the spec repo and may change with the RFC.
 *
 * ```jsonc
 * "cancellation_policy": {
 *   "x-adcp-applies-when": { "delivery_types": ["guaranteed"] },
 *   "$ref": "#/$defs/external:core~1cancellation-policy.json"
 * }
 * ```
 *
 * - `delivery_types` matches `media_buy.supported_delivery_types` and
 *   `pricing_models` matches `media_buy.supported_pricing_models`. When the
 *   seller hasn't declared the list, the property is kept (fail open).
 * - `capabilities` holds dotted paths into the `get_adcp_capabilities`
 *   response. A path is satisfied when it is present and not `false`.
 * - Any match across all keys keeps the property (OR).
 * - Projection only removes optional properties. It never renames, retypes,
 *   or adds required fields.
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

/**
 * Decide whether an `x-adcp-applies-when` annotation keeps its property for a
 * seller with the given `get_adcp_capabilities` response.
 *
 * Returns `true` (keep) on any match, and also whenever the annotation can't
 * be evaluated: a malformed value, an unknown key, or a `delivery_types` /
 * `pricing_models` key whose capability list the seller hasn't declared.
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
      // Undeclared is not empty: an absent (or invalid, empty) list fails open.
      if (!Array.isArray(declared) || declared.length === 0) return true;
      if (values.some(value => declared.includes(value))) return true;
    } else if (key === 'capabilities') {
      if (
        values.some(path => {
          if (typeof path !== 'string') return true;
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
 * Property names a projection must never drop from `parent`, even if a
 * (misplaced) annotation says so: the parent's own `required`, `required` in
 * its direct `allOf` / `anyOf` / `oneOf` / `then` / `else` arms, and the
 * targets of `dependentRequired` / array-form `dependencies`.
 */
function protectedPropertyNames(parent: JsonObject): Set<string> {
  const names = new Set<string>();
  const addAll = (list: unknown) => {
    if (Array.isArray(list)) for (const name of list) if (typeof name === 'string') names.add(name);
  };
  addAll(parent.required);
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const arms = parent[keyword];
    if (Array.isArray(arms)) for (const arm of arms) if (isObject(arm)) addAll(arm.required);
  }
  for (const keyword of ['then', 'else'] as const) {
    const arm = parent[keyword];
    if (isObject(arm)) addAll(arm.required);
  }
  for (const keyword of ['dependentRequired', 'dependencies'] as const) {
    const map = parent[keyword];
    if (isObject(map)) for (const value of Object.values(map)) addAll(value);
  }
  return names;
}

/** Project each value of a name-to-schema map, sharing it when nothing changes. */
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
  let protectedNames: Set<string> | undefined;
  let changed = false;
  const entries: Array<[string, unknown]> = [];
  for (const [name, subschema] of Object.entries(properties)) {
    if (
      isObject(subschema) &&
      APPLIES_WHEN_KEYWORD in subschema &&
      !appliesWhenSatisfied(subschema[APPLIES_WHEN_KEYWORD], capabilities) &&
      !(protectedNames ??= protectedPropertyNames(parent)).has(name)
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
 * annotation doesn't apply to a seller with the given `get_adcp_capabilities`
 * response.
 *
 * - **Pure.** The input is never mutated. Unchanged subtrees are shared by
 *   reference with the input, and the input itself is returned when nothing
 *   is removed, so treat the result as read-only.
 * - **Walks** `properties`, `items` / `prefixItems`, `allOf` / `anyOf` /
 *   `oneOf`, `if` / `then` / `else`, `not`, `additionalProperties`,
 *   `patternProperties`, `dependentSchemas`, and `$defs` / `definitions`.
 *   Values under `const`, `default`, `enum`, `examples`, and `x-*` keywords
 *   are instance data and are left alone.
 * - **`$ref`s are left in place.** A local reference (`#/...`, or the
 *   document's own `$id` plus a fragment, as in the bundled MCP tool schemas)
 *   points into the same document, which this function projects as a whole,
 *   so the reference sees the projected target. No inlining, so no cycles.
 *   References to other documents aren't followed.
 * - **Required properties are never dropped**, even if annotated. The spec forbids the annotation on
 *   required properties; this is a defensive guard. "Required" covers the
 *   parent's `required`, `required` in its direct `allOf` / `anyOf` / `oneOf`
 *   / `then` / `else` arms, and `dependentRequired` targets.
 * - With no capabilities object (`undefined` / `null`), the input is returned
 *   unchanged.
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
