/**
 * Convert a mostly dereferenced bundled JSON Schema into a serializable schema
 * that stores repeated schema nodes once under `$defs`.
 *
 * The upstream `bundled/` tree expands shared definitions at every use site,
 * growing to hundreds of megabytes. This serializer replaces repeated schema
 * nodes with private local refs while leaving annotation/default/example data
 * alone. The runtime store expands the private refs before returning a schema.
 */

import { createHash } from 'node:crypto';

type JsonObject = Record<string, unknown>;

export const COMPACT_DEFINITIONS_KEY = 'x-adcp-compact-definitions';

const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalProperties',
  'additionalItems',
  'contains',
  'if',
  'then',
  'else',
  'not',
  'propertyNames',
  'contentSchema',
  'unevaluatedProperties',
  'unevaluatedItems',
]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function forEachChildSchema(schema: JsonObject, visit: (schema: unknown) => void): void {
  for (const [keyword, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
      for (const child of Object.values(value)) visit(child);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
      visit(value);
    } else if (keyword === 'items') {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else {
        visit(value);
      }
    } else if (keyword === 'dependencies' && isObject(value)) {
      for (const child of Object.values(value)) {
        if (!Array.isArray(child)) visit(child);
      }
    }
  }
}

function cloneData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneData);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneData(child)]));
}

/**
 * Compact an acyclic schema object graph. Repeated schemas become private local
 * `$defs` refs. The archive reader expands those private refs before exposing
 * a schema, preserving the original document and AJV diagnostic paths.
 */
export function compactBundledSchema(root: JsonObject): JsonObject {
  const referenceCounts = new Map<JsonObject, number>();
  const visited = new Set<JsonObject>();

  const countSchema = (value: unknown): void => {
    if (!isObject(value)) return;
    referenceCounts.set(value, (referenceCounts.get(value) ?? 0) + 1);
    if (visited.has(value)) return;
    visited.add(value);
    forEachChildSchema(value, countSchema);
  };
  countSchema(root);

  const signatureCache = new Map<JsonObject, string>();
  const weightCache = new Map<JsonObject, number>();
  const schemaSignature = (schema: JsonObject): string => {
    const cached = signatureCache.get(schema);
    if (cached) return cached;
    const hash = createHash('sha256');
    const updateHash = (value: string): void => {
      hash.update(`${Buffer.byteLength(value)}:`);
      hash.update(value);
    };
    let weight = 2;
    for (const [keyword, value] of Object.entries(schema)) {
      updateHash(keyword);
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
        for (const [key, child] of Object.entries(value)) {
          updateHash(key);
          if (isObject(child)) {
            updateHash(schemaSignature(child));
            weight += weightCache.get(child) ?? 0;
          } else {
            const serialized = JSON.stringify(child);
            updateHash(serialized);
            weight += Buffer.byteLength(serialized);
          }
        }
      } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
        for (const child of value) {
          if (isObject(child)) {
            updateHash(schemaSignature(child));
            weight += weightCache.get(child) ?? 0;
          } else {
            const serialized = JSON.stringify(child);
            updateHash(serialized);
            weight += Buffer.byteLength(serialized);
          }
        }
      } else if (SCHEMA_VALUE_KEYWORDS.has(keyword) && isObject(value)) {
        updateHash(schemaSignature(value));
        weight += weightCache.get(value) ?? 0;
      } else if (keyword === 'items') {
        // Draft-07 assigns different semantics to `items: schema` and the
        // one-element tuple form `items: [schema]`; keep their signatures
        // distinct even though both contain the same child sequence.
        updateHash(Array.isArray(value) ? 'tuple' : 'single');
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) {
          if (isObject(child)) {
            updateHash(schemaSignature(child));
            weight += weightCache.get(child) ?? 0;
          } else {
            const serialized = JSON.stringify(child);
            updateHash(serialized);
            weight += Buffer.byteLength(serialized);
          }
        }
      } else if (keyword === 'dependencies' && isObject(value)) {
        for (const [key, child] of Object.entries(value)) {
          updateHash(key);
          if (isObject(child)) {
            updateHash(schemaSignature(child));
            weight += weightCache.get(child) ?? 0;
          } else {
            const serialized = JSON.stringify(child);
            updateHash(serialized);
            weight += Buffer.byteLength(serialized);
          }
        }
      } else {
        const serialized = JSON.stringify(value);
        updateHash(serialized);
        weight += Buffer.byteLength(serialized);
      }
    }
    const signature = hash.digest('hex');
    signatureCache.set(schema, signature);
    weightCache.set(schema, weight);
    return signature;
  };

  const signatureGroups = new Map<string, JsonObject[]>();
  for (const schema of visited) {
    if (schema === root) continue;
    const signature = schemaSignature(schema);
    const group = signatureGroups.get(signature) ?? [];
    group.push(schema);
    signatureGroups.set(signature, group);
  }

  const sharedNames = new Map<JsonObject, string>();
  const sharedDefinitions = new Map<string, JsonObject>();
  const reservedNames = new Set(isObject(root.$defs) ? Object.keys(root.$defs) : []);
  let sharedIndex = 0;
  for (const group of signatureGroups.values()) {
    const useCount = group.reduce((sum, schema) => sum + (referenceCounts.get(schema) ?? 0), 0);
    const weight = weightCache.get(group[0]!) ?? 0;
    // Tiny repeated schemas compress better as literals than as a definition
    // plus multiple pointer strings. Identity-shared nodes are retained even
    // when small because they came from an authored `$ref` boundary.
    const identityShared = group.some(schema => (referenceCounts.get(schema) ?? 0) > 1);
    if (useCount < 2 || (!identityShared && weight < 256)) continue;
    let name: string;
    do name = `__adcp_shared_${sharedIndex++}`;
    while (reservedNames.has(name));
    reservedNames.add(name);
    for (const schema of group) sharedNames.set(schema, name);
    sharedDefinitions.set(name, group[0]!);
  }

  const encodeSchema = (schema: unknown, expanding?: JsonObject, ancestors = new Set<JsonObject>()): unknown => {
    if (!isObject(schema)) return schema;

    const sharedName = sharedNames.get(schema);
    if (sharedName && schema !== expanding) return { $ref: `#/$defs/${sharedName}` };
    if (ancestors.has(schema)) {
      if (!sharedName) throw new Error('Dereferenced schema contains an unaddressable cycle');
      return { $ref: `#/$defs/${sharedName}` };
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(schema);
    const encoded: JsonObject = {};

    for (const [keyword, value] of Object.entries(schema)) {
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
        encoded[keyword] = Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, encodeSchema(child, undefined, nextAncestors)])
        );
      } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
        encoded[keyword] = value.map(child => encodeSchema(child, undefined, nextAncestors));
      } else if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
        encoded[keyword] = encodeSchema(value, undefined, nextAncestors);
      } else if (keyword === 'items') {
        encoded[keyword] = Array.isArray(value)
          ? value.map(child => encodeSchema(child, undefined, nextAncestors))
          : encodeSchema(value, undefined, nextAncestors);
      } else if (keyword === 'dependencies' && isObject(value)) {
        encoded[keyword] = Object.fromEntries(
          Object.entries(value).map(([key, child]) => [
            key,
            Array.isArray(child) ? cloneData(child) : encodeSchema(child, undefined, nextAncestors),
          ])
        );
      } else {
        encoded[keyword] = cloneData(value);
      }
    }
    return encoded;
  };

  const compacted = encodeSchema(root, root) as JsonObject;
  if (compacted[COMPACT_DEFINITIONS_KEY] !== undefined) {
    throw new Error(`Schema already contains reserved property ${COMPACT_DEFINITIONS_KEY}`);
  }
  const defs = isObject(compacted.$defs) ? { ...compacted.$defs } : {};
  for (const [name, schema] of sharedDefinitions) defs[name] = encodeSchema(schema, schema);
  if (Object.keys(defs).length > 0) compacted.$defs = defs;
  if (sharedDefinitions.size > 0) compacted[COMPACT_DEFINITIONS_KEY] = [...sharedDefinitions.keys()];
  return compacted;
}
