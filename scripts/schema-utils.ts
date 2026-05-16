/**
 * Shared utilities for schema processing during code generation.
 */

/**
 * Set of JSDoc `@format` tag values that ts-to-zod can translate into Zod
 * validators. Anything else is dropped (Ajv still enforces the JSON Schema
 * `format` against the unstripped schema at runtime).
 *
 * Source: ts-to-zod's `builtInJSDocFormatsTypes` in `core/jsDocTags.ts`. Keep
 * in sync if upgrading ts-to-zod.
 */
const TS_TO_ZOD_SUPPORTED_FORMATS = new Set([
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'ip',
  'ipv4',
  'ipv6',
  'url',
  'uuid',
  'emoji',
  'base64',
  'base64url',
  'nanoid',
  'cuid',
  'cuid2',
  'ulid',
  'cidrv4',
  'cidrv6',
  'iso-date',
  'iso-time',
  'iso-datetime',
  'iso-duration',
  'int',
  'float32',
  'float64',
  'int32',
  'uint32',
  'int64',
  'uint64',
]);

/**
 * Inject JSON Schema validation constraints as JSDoc tags into each
 * subschema's `description`, so json-schema-to-typescript emits them as
 * JSDoc and ts-to-zod picks them up.
 *
 * Pipeline context: the codegen goes JSON Schema → TypeScript (jsts) → Zod
 * (ts-to-zod). The TS hop is lossy — `revision: number` can't carry
 * `minimum: 1`. ts-to-zod natively reads six JSDoc constraint tags
 * (`@minimum`, `@maximum`, `@minLength`, `@maxLength`, `@pattern`,
 * `@format`), so we encode the constraints into the JSDoc-bound description
 * field before jsts runs. The emitted JSDoc round-trips into Zod chains
 * (`z.number().min(1)`, etc).
 *
 * Skipped (Ajv still enforces these against the unstripped schema at runtime):
 *  - `exclusiveMinimum` / `exclusiveMaximum` — ts-to-zod has no exclusive variant.
 *  - `pattern` containing `\n` or `\r` — would break JSDoc parsing.
 *  - `format` values outside ts-to-zod's supported set.
 *
 * Forward slashes inside a `pattern` are escaped (`/` → `\/`) so the regex
 * literal jsDocTags wraps it in (`/PATTERN/`) stays valid.
 *
 * Fixes adcp-client#1745.
 */
export function injectJsdocConstraints(schema: any): any {
  return walk(schema);

  function walk(node: any): any {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);

    const out: any = { ...node };

    // Recurse into structural keywords before annotating, so nested
    // subschemas get their own injections. The set mirrors enforceStrictSchema.
    if (out.properties && typeof out.properties === 'object') {
      out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, walk(v)]));
    }
    if (out.patternProperties && typeof out.patternProperties === 'object') {
      out.patternProperties = Object.fromEntries(Object.entries(out.patternProperties).map(([k, v]) => [k, walk(v)]));
    }
    if (out.additionalProperties && typeof out.additionalProperties === 'object') {
      out.additionalProperties = walk(out.additionalProperties);
    }
    if (out.items) {
      out.items = Array.isArray(out.items) ? out.items.map(walk) : walk(out.items);
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(out[key])) {
        out[key] = out[key].map(walk);
      }
    }
    for (const key of ['not', 'if', 'then', 'else', 'contains', 'propertyNames']) {
      if (out[key] && typeof out[key] === 'object') {
        out[key] = walk(out[key]);
      }
    }
    for (const key of ['definitions', '$defs']) {
      if (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
        out[key] = Object.fromEntries(Object.entries(out[key]).map(([k, v]) => [k, walk(v)]));
      }
    }

    // Now annotate this node's own description with any constraint tags it
    // carries. Tags are appended idempotently — if the description already
    // contains `@minimum N`, we don't re-add it (lets the function run
    // multiple times safely; ref resolution may visit the same schema twice).
    const tags: string[] = [];
    const existingDescription = typeof out.description === 'string' ? out.description : '';

    const addTag = (tag: string, value: string | number) => {
      const line = `@${tag} ${value}`;
      // Allow-list-style idempotency: only suppress if the *exact* tag with
      // the same value is already present. Different values mean a real
      // conflict — let jsts emit both so a human reviewing the diff sees it.
      if (existingDescription.split('\n').some(l => l.trim() === line)) return;
      tags.push(line);
    };

    if (typeof out.minimum === 'number') addTag('minimum', out.minimum);
    if (typeof out.maximum === 'number') addTag('maximum', out.maximum);
    if (typeof out.minLength === 'number') addTag('minLength', out.minLength);
    if (typeof out.maxLength === 'number') addTag('maxLength', out.maxLength);
    if (typeof out.pattern === 'string' && !/[\n\r]/.test(out.pattern)) {
      // Escape `/` so ts-to-zod's `/PATTERN/` wrapper stays a valid literal.
      const escaped = out.pattern.replace(/\//g, '\\/');
      addTag('pattern', escaped);
    }
    if (typeof out.format === 'string' && TS_TO_ZOD_SUPPORTED_FORMATS.has(out.format)) {
      addTag('format', out.format);
    }

    if (tags.length > 0) {
      out.description = existingDescription ? `${existingDescription}\n${tags.join('\n')}` : tags.join('\n');
    }

    return out;
  }
}

/**
 * Recursively remove minItems constraints from arrays to allow empty arrays.
 *
 * DESIGN DECISION: The AdCP JSON Schema specifies minItems: 1 for fields like
 * publisher_domains, which is technically correct per spec. However, real-world
 * agents often return empty arrays (e.g., when not authorized for any publishers).
 * We prioritize interoperability over strict spec compliance here.
 *
 * This is necessary because:
 * - json-schema-to-typescript converts minItems: 1 to [T, ...T[]] tuple syntax
 * - ts-to-zod converts these to z.tuple([]).rest() which requires at least one element
 *
 * By removing minItems, we generate string[] and z.array() instead, which accept
 * empty arrays. maxItems is preserved so Zod can emit .max(N) for runtime validation.
 */
export function removeMinItemsConstraints(schema: any): any {
  return removeArrayConstraints(schema, ['minItems']);
}

/**
 * Recursively remove both minItems and maxItems constraints from arrays.
 *
 * Used by TypeScript type generation where maxItems combined with oneOf causes
 * json-schema-to-typescript to enumerate every possible tuple length+variant
 * permutation, producing thousands of index signatures. TypeScript has no native
 * bounded-length array concept, so maxItems adds no type safety.
 *
 * Zod generation should use removeMinItemsConstraints instead to preserve
 * .max(N) runtime validation.
 */
export function removeArrayLengthConstraints(schema: any): any {
  return removeArrayConstraints(schema, ['minItems', 'maxItems']);
}

function removeArrayConstraints(schema: any, keys: string[]): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => removeArrayConstraints(item, keys));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (keys.includes(key)) {
      continue;
    }
    result[key] = removeArrayConstraints(value, keys);
  }
  return result;
}
