/**
 * Convert a mostly dereferenced bundled JSON Schema into a serializable schema
 * that stores repeated schema nodes once under `$defs`.
 *
 * The upstream `bundled/` tree expands shared definitions at every use site,
 * growing to hundreds of megabytes. This serializer replaces repeated schema
 * nodes with private local refs while leaving annotation/default/example data
 * alone. Public schema readers expand these private refs; validation can keep
 * them to compile small referenced functions instead of multi-megabyte code.
 */

import { createHash, randomUUID } from 'node:crypto';
import uriResolver from 'ajv/dist/runtime/uri';

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
export function compactBundledSchema(
  root: JsonObject,
  options: {
    maxInlineSchemaBytes?: number;
    referencePrefix?: string;
    referenceRoots?: readonly JsonObject[];
    canFactor?: (schema: JsonObject) => boolean;
  } = {}
): JsonObject {
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

  // Validation factoring must preserve existing JSON Pointer addresses. If
  // a pointer descends through a schema node, hoisting that ancestor behind
  // a new $ref would erase the original path. Default archive serialization
  // stays byte-for-byte unchanged; this guard is validation-mode-only.
  const pointerAddressedNodes = new Set<JsonObject>();
  const unionAlternatives = new Set<JsonObject>();
  if (options.maxInlineSchemaBytes !== undefined) {
    const rootUrl = new URL(typeof root.$id === 'string' ? root.$id : '', 'https://adcp.invalid/');
    rootUrl.hash = '';
    const resourcesByUri = new Map<string, JsonObject[]>();
    for (const resource of options.referenceRoots ?? []) {
      const uri = resource.$id as string;
      const matches = resourcesByUri.get(uri) ?? [];
      matches.push(resource);
      resourcesByUri.set(uri, matches);
    }
    for (const schema of visited) {
      // Keep the branch boundary in its union function so AJV retains
      // /oneOf/N and /anyOf/N in diagnostics. Descendants can still be
      // factored, keeping the generated functions bounded.
      for (const keyword of ['oneOf', 'anyOf']) {
        const alternatives = schema[keyword];
        if (Array.isArray(alternatives)) {
          for (const alternative of alternatives) if (isObject(alternative)) unionAlternatives.add(alternative);
        }
      }
      if (typeof schema.$ref !== 'string') continue;
      let fragment: string;
      let resources = [root];
      try {
        if (options.referenceRoots) {
          fragment = uriResolver.parse(schema.$ref).fragment ?? '';
          resources = resourcesByUri.get(schema.$ref.split('#')[0]!) ?? [];
          if (!fragment.startsWith('/')) continue;
        } else {
          const target = new URL(schema.$ref, rootUrl);
          fragment = decodeURIComponent(target.hash.slice(1));
          target.hash = '';
          if (target.href !== rootUrl.href || !fragment.startsWith('/')) continue;
        }
      } catch {
        continue; // AJV remains responsible for malformed reference diagnostics.
      }
      // Remote documents may contain several $id resources. Index those roots
      // so pointer protection does not multiply every ref by every resource.
      for (const resource of resources) {
        let value: unknown = resource;
        for (const segment of fragment.slice(1).split('/')) {
          if (isObject(value)) pointerAddressedNodes.add(value);
          if (!isObject(value) && !Array.isArray(value)) break;
          const decoded = options.referenceRoots ? decodeURIComponent(segment) : segment;
          const key = decoded.replace(/~1/g, '/').replace(/~0/g, '~');
          if (!Object.hasOwn(value, key)) break;
          value = (value as Record<string, unknown>)[key];
        }
        if (isObject(value)) pointerAddressedNodes.add(value);
      }
    }
  }

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
    if (
      schema === root ||
      pointerAddressedNodes.has(schema) ||
      unionAlternatives.has(schema) ||
      (options.canFactor && !options.canFactor(schema))
    )
      continue;
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
    const largeValidationNode = options.maxInlineSchemaBytes !== undefined && weight >= options.maxInlineSchemaBytes;
    if (!largeValidationNode && (useCount < 2 || (!identityShared && weight < 256))) continue;
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
    const referencePrefix = options.referencePrefix ?? '#/$defs/';
    if (sharedName && schema !== expanding) return { $ref: `${referencePrefix}${sharedName}` };
    if (ancestors.has(schema)) {
      if (!sharedName) throw new Error('Dereferenced schema contains an unaddressable cycle');
      return { $ref: `${referencePrefix}${sharedName}` };
    }

    ancestors.add(schema);
    const encoded: JsonObject = Object.create(null);

    for (const [keyword, value] of Object.entries(schema)) {
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
        encoded[keyword] = Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, encodeSchema(child, undefined, ancestors)])
        );
      } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
        encoded[keyword] = value.map(child => encodeSchema(child, undefined, ancestors));
      } else if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
        encoded[keyword] = encodeSchema(value, undefined, ancestors);
      } else if (keyword === 'items') {
        encoded[keyword] = Array.isArray(value)
          ? value.map(child => encodeSchema(child, undefined, ancestors))
          : encodeSchema(value, undefined, ancestors);
      } else if (keyword === 'dependencies' && isObject(value)) {
        encoded[keyword] = Object.fromEntries(
          Object.entries(value).map(([key, child]) => [
            key,
            Array.isArray(child) ? cloneData(child) : encodeSchema(child, undefined, ancestors),
          ])
        );
      } else {
        encoded[keyword] = cloneData(value);
      }
    }
    ancestors.delete(schema);
    // Preserve literal __proto__ keys when compacting remote documents.
    return { ...encoded };
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

/**
 * Prepare a self-contained bundled schema for bounded AJV compilation. Nested
 * IDs in these dereferenced bundles are source annotations, not ref scopes.
 * Walk schema positions only so IDs in enum/default/example data stay intact.
 */
export function compactSchemaForValidation(schema: JsonObject): JsonObject {
  const copied = cloneData(schema) as JsonObject;
  const stripIds = (node: unknown, root = false): void => {
    if (!isObject(node)) return;
    if (!root) delete node.$id;
    forEachChildSchema(node, child => stripIds(child));
  };
  stripIds(copied, true);
  // Factor large one-off nodes too; deduplicating only repeated schemas
  // can still leave a megabyte-sized root validator after dereferencing.
  return compactBundledSchema(copied, { maxInlineSchemaBytes: 1024 });
}

/**
 * Factor a remote schema without treating its $ids as removable annotations.
 * Absolute references preserve their original scope when a node is hoisted.
 * Anchors stay in their resource; dynamic scopes and unusual URIs use the
 * original document so the official compiler retains its normal behavior.
 */
export function compactMcpSchemaForValidation(schema: JsonObject): JsonObject {
  if (schema[COMPACT_DEFINITIONS_KEY] !== undefined || (schema.$defs !== undefined && !isObject(schema.$defs)))
    return schema;

  const copied = cloneData(schema) as JsonObject;
  const resourceUri = `https://mcp-schema.invalid/${randomUUID()}`;
  const resources: JsonObject[] = [];
  const schemaNodes = new Set<JsonObject>();
  const references: string[] = [];
  const relocatable = new Map<JsonObject, boolean>();
  const dynamicKeywords = ['$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor'];
  const scopeKeywords = ['$id', '$schema', '$anchor', ...dynamicKeywords];
  const literalKeywords = new Set(['default', 'enum', 'const']);
  let supported = true;

  const resolveUri = (base: string, reference: string): string => {
    // Match Ajv's RFC URI resolver and normalizeId behavior. WHATWG URL differs
    // for percent-encoded dot segments and must not merge distinct resources.
    const resolved = uriResolver.resolve(base, reference.replace(/#\/?$/, ''));
    if (uriResolver.parse(resolved).error) supported = false;
    return resolved.replace(/#\/?$/, '');
  };

  const containsScope = (value: unknown): boolean => {
    if (!isObject(value)) return false;
    return Object.entries(value).some(
      ([keyword, child]) => scopeKeywords.includes(keyword) || keyword === '$ref' || containsScope(child)
    );
  };

  const normalize = (node: unknown, inheritedUri: string, root = false): boolean => {
    if (!isObject(node)) return true;
    schemaNodes.add(node);
    // Ajv treats an inline $async marker differently from a referenced schema.
    // Keep that compile-time distinction intact, even under a synchronous root.
    if (Object.hasOwn(node, '$async')) supported = false;
    // Ajv scans object-valued extension keywords for IDs more broadly than
    // schema-position traversal. Preserve such graphs without relocating them.
    for (const [keyword, value] of Object.entries(node)) {
      // Ajv's reference-registration walk does not descend prefixItems arrays.
      // Moving scoped items into $defs could otherwise register a new target.
      if (keyword === 'prefixItems' && Array.isArray(value) && value.some(containsScope)) supported = false;
      if (
        keyword === 'dependentSchemas' &&
        isObject(value) &&
        scopeKeywords.some(key => typeof value[key] === 'string' || typeof value[key] === 'boolean')
      )
        supported = false;
      if (
        !SCHEMA_MAP_KEYWORDS.has(keyword) &&
        !SCHEMA_ARRAY_KEYWORDS.has(keyword) &&
        !SCHEMA_VALUE_KEYWORDS.has(keyword) &&
        keyword !== 'items' &&
        keyword !== 'dependencies' &&
        !literalKeywords.has(keyword) &&
        containsScope(value)
      )
        supported = false;
    }
    let uri = inheritedUri;
    if (Object.hasOwn(node, '$id') || root) {
      if (node.$id !== undefined && typeof node.$id !== 'string') {
        supported = false;
        return false;
      }
      if (!root && node.$id === '') supported = false;
      uri = resolveUri(inheritedUri, (node.$id as string | undefined) ?? resourceUri);
      if (uriResolver.parse(uri).fragment) supported = false;
      node.$id = uri;
      resources.push(node);
    }
    if (Object.hasOwn(node, '$ref')) {
      if (typeof node.$ref !== 'string') supported = false;
      else {
        node.$ref = resolveUri(uri, node.$ref);
        references.push(node.$ref as string);
      }
    }
    if (dynamicKeywords.some(keyword => Object.hasOwn(node, keyword))) supported = false;

    let independent = !scopeKeywords.some(keyword => Object.hasOwn(node, keyword));
    forEachChildSchema(node, child => {
      if (!normalize(child, uri)) independent = false;
    });
    // A resource carries its own base URI and anchors when moved as a whole.
    if (typeof node.$id === 'string') independent = true;
    relocatable.set(node, independent);
    return independent;
  };

  try {
    normalize(copied, resourceUri, true);
    const resourcesByUri = new Map<string, JsonObject[]>();
    for (const resource of resources) {
      const uri = resource.$id as string;
      const matches = resourcesByUri.get(uri) ?? [];
      if (matches.length > 0) return schema; // Keep duplicate-ID compilation failures intact.
      matches.push(resource);
      resourcesByUri.set(uri, matches);
    }
    for (const reference of references) {
      const fragment = uriResolver.parse(reference).fragment ?? '';
      const matches = resourcesByUri.get(reference.split('#')[0]!);
      if (!matches) return schema; // External resources remain the compiler's responsibility.
      if (!fragment.startsWith('/')) continue;
      for (const resource of matches) {
        let value: unknown = resource;
        for (const segment of fragment.slice(1).split('/')) {
          const key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
          if (
            (!isObject(value) && !Array.isArray(value)) ||
            !Object.hasOwn(value, key) ||
            (value === copied && key === '$id' && !Object.hasOwn(schema, '$id'))
          )
            return schema;
          value = (value as Record<string, unknown>)[key];
        }
        // A ref into annotation data can make that data executable as a schema.
        // Do not rewrite a graph whose executable nodes were not all visited.
        if (typeof value !== 'boolean' && (!isObject(value) || !schemaNodes.has(value))) return schema;
      }
    }
  } catch {
    return schema; // Leave unsupported URI resolution to the official engine.
  }
  if (!supported) return schema;
  const compacted = compactBundledSchema(copied, {
    maxInlineSchemaBytes: 1024,
    referencePrefix: `${copied.$id as string}#/$defs/`,
    referenceRoots: resources,
    canFactor: node => relocatable.get(node) === true,
  });
  return compacted[COMPACT_DEFINITIONS_KEY] === undefined ? schema : compacted;
}
