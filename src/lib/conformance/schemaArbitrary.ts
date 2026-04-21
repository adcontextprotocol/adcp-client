import fc from 'fast-check';
import type { ConformanceFixtures } from './types';

type JsonSchema = Record<string, unknown> & { type?: string | string[] };

export interface ArbitraryOptions {
  /**
   * ID pools. When a property name matches (e.g. `creative_id`,
   * `creative_ids`), the generator draws from the pool instead of
   * producing random strings. See {@link resolvePoolForKey}.
   */
  fixtures?: ConformanceFixtures;
}

/**
 * Converts a draft-07 JSON Schema into a fast-check arbitrary that
 * produces schema-valid values. Covers the subset of JSON Schema used
 * by AdCP bundled request schemas. Unsupported constructs fall through
 * to a permissive arbitrary rather than throwing, so the fuzzer keeps
 * running on the remainder of the schema.
 */
export function schemaToArbitrary(schema: JsonSchema, opts: ArbitraryOptions = {}): fc.Arbitrary<unknown> {
  if (!schema || typeof schema !== 'object') return fc.anything();

  if ('const' in schema) return fc.constant(schema.const);
  if (Array.isArray(schema.enum)) return fc.constantFrom(...(schema.enum as unknown[]));

  // Composite-shape oneOf: the whole value is one of the branches.
  // Only replaces the dispatch when the outer schema has no standalone
  // `properties` — otherwise oneOf is a side-constraint we generate past.
  if (Array.isArray(schema.oneOf) && !hasOwnProperties(schema)) {
    return fc.oneof(...schema.oneOf.map(s => schemaToArbitrary(s as JsonSchema, opts)));
  }
  if (Array.isArray(schema.anyOf) && !hasOwnProperties(schema)) {
    return fc.oneof(...schema.anyOf.map(s => schemaToArbitrary(s as JsonSchema, opts)));
  }
  // `allOf` is usually conditional (if/then/else) in AdCP schemas; the base
  // shape on the outer schema is the right generator. Ignoring the `if`
  // occasionally produces a sample that violates the conditional — an
  // acceptable cost for not hand-rolling if/then semantics.

  const type = normalizeType(schema);
  switch (type) {
    case 'string':
      return stringArb(schema);
    case 'integer':
      return integerArb(schema);
    case 'number':
      return numberArb(schema);
    case 'boolean':
      return fc.boolean();
    case 'null':
      return fc.constant(null);
    case 'array':
      return arrayArb(schema, opts);
    case 'object':
      return objectArb(schema, opts);
    default:
      return fc.anything();
  }
}

// Years 2020-2040 — well inside Ajv's date-time format validator. Fast-check's
// default `fc.date()` produces ISO strings outside the RFC-3339 range (e.g.,
// `+041510-07-24T...`) that the format validator rejects.
const DATE_MIN = new Date('2020-01-01T00:00:00Z');
const DATE_MAX = new Date('2040-12-31T23:59:59Z');
function boundedDate(): fc.Arbitrary<Date> {
  return fc.date({ min: DATE_MIN, max: DATE_MAX, noInvalidDate: true });
}

function hasOwnProperties(schema: JsonSchema): boolean {
  return !!schema.properties && Object.keys(schema.properties).length > 0;
}

function normalizeType(schema: JsonSchema): string {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type) && typeof schema.type[0] === 'string') return schema.type[0];
  if (schema.properties || schema.required || schema.additionalProperties !== undefined) return 'object';
  if (schema.items) return 'array';
  return 'unknown';
}

function stringArb(schema: JsonSchema): fc.Arbitrary<string> {
  const pattern = schema.pattern as string | undefined;
  const format = schema.format as string | undefined;
  const minLength = (schema.minLength as number | undefined) ?? 0;
  const maxLength = (schema.maxLength as number | undefined) ?? 32;

  // format:uri often co-occurs with pattern `^https://`. Let format take
  // precedence (and narrow schemes when the pattern hints at it) so we
  // produce genuine RFC-3986 URIs rather than pattern-shaped noise that
  // Ajv's format validator rejects.
  if (format === 'uri' || format === 'uri-reference') {
    const httpsOnly = pattern === '^https://' || pattern === '^https:' || pattern === '^https:\\/\\/';
    return fc.webUrl({ validSchemes: httpsOnly ? ['https'] : ['http', 'https'] });
  }
  if (format === 'email') return fc.emailAddress();
  if (format === 'uuid') return fc.uuid();
  if (format === 'date-time') return boundedDate().map(d => d.toISOString());
  if (format === 'date') return boundedDate().map(d => d.toISOString().slice(0, 10));

  if (pattern) {
    try {
      return fc.stringMatching(new RegExp(pattern));
    } catch {
      /* fallthrough */
    }
  }
  return fc.string({ minLength: Math.max(1, minLength), maxLength });
}

function integerArb(schema: JsonSchema): fc.Arbitrary<number> {
  const min = (schema.minimum as number | undefined) ?? -1000;
  const max = (schema.maximum as number | undefined) ?? 1000;
  return fc.integer({ min: Math.ceil(min), max: Math.floor(max) });
}

function numberArb(schema: JsonSchema): fc.Arbitrary<number> {
  const min = (schema.minimum as number | undefined) ?? -1000;
  const max = (schema.maximum as number | undefined) ?? 1000;
  return fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
}

function arrayArb(schema: JsonSchema, opts: ArbitraryOptions): fc.Arbitrary<unknown[]> {
  const items = (schema.items as JsonSchema | undefined) ?? {};
  const minItems = (schema.minItems as number | undefined) ?? 0;
  const maxItems = (schema.maxItems as number | undefined) ?? Math.max(minItems, 3);
  const unique = schema.uniqueItems === true;
  if (unique) {
    return fc.uniqueArray(schemaToArbitrary(items, opts), {
      minLength: minItems,
      maxLength: maxItems,
      selector: x => JSON.stringify(x),
    });
  }
  return fc.array(schemaToArbitrary(items, opts), { minLength: minItems, maxLength: maxItems });
}

interface ObjectShape {
  properties: Record<string, JsonSchema>;
  required: Set<string>;
  additionalProperties: boolean | JsonSchema;
}

function objectArb(schema: JsonSchema, opts: ArbitraryOptions): fc.Arbitrary<Record<string, unknown>> {
  const shape = readObjectShape(schema);
  const anyOfRequired = collectAnyOfRequired(schema);
  const propertySpec = buildPropertyRecordSpec(shape, opts);
  const declared = new Set(Object.keys(propertySpec));
  const baseRequired = Array.from(shape.required).filter(k => declared.has(k));
  const dependencies = readDependencies(schema, declared);

  const base =
    anyOfRequired.length === 0
      ? fc.record(propertySpec, { requiredKeys: baseRequired })
      : fc.nat(anyOfRequired.length - 1).chain(idx => {
          const branch = anyOfRequired[idx]!;
          const requiredKeys = Array.from(new Set([...baseRequired, ...branch.filter(k => declared.has(k))]));
          return fc.record(propertySpec, { requiredKeys });
        });

  let withDeps = base;
  if (dependencies.length > 0) withDeps = base.map(value => enforceDependencies(value, dependencies));

  // Unknown-property probe: when the schema allows additional properties,
  // sometimes inject one. Exercises the "unknown-field tolerance"
  // surface — a common crash source where agents deserialize into a
  // strict struct and reject keys they weren't expecting. Kept at ~15%
  // frequency and capped at one extra key so overall sample validity
  // stays high; the oracle's two-path design absorbs the rest.
  if (shape.additionalProperties !== true) return withDeps;
  return withDeps.chain(value => injectExtraProperty(value, declared));
}

/**
 * Probabilistically adds a single unknown key to `value`. The key name
 * is drawn from a fixed vocabulary that deliberately avoids collisions
 * with well-known AdCP property names, and the value is a minimal
 * primitive. Most samples pass through unchanged.
 */
function injectExtraProperty(
  value: Record<string, unknown>,
  declared: Set<string>
): fc.Arbitrary<Record<string, unknown>> {
  const candidates = EXTRA_PROPERTY_NAMES.filter(k => !(k in value) && !declared.has(k));
  if (candidates.length === 0) return fc.constant(value);
  // 85% pass-through, 15% injection. `fc.nat({max: 19})` gives a 0-19
  // roll; values 0-2 (~15%) trigger injection.
  return fc.nat({ max: 19 }).chain(roll => {
    if (roll > 2) return fc.constant(value);
    return fc.tuple(fc.constantFrom(...candidates), EXTRA_VALUE_ARB).map(([key, v]) => ({ ...value, [key]: v }));
  });
}

const EXTRA_PROPERTY_NAMES: readonly string[] = [
  'x_conformance_probe',
  '_debug_trace',
  'probe_key',
  'unknown_field',
  'test_vendor_ext',
];
const EXTRA_VALUE_ARB: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 16 }),
  fc.integer({ min: 0, max: 999 }),
  fc.boolean()
);

function readDependencies(schema: JsonSchema, declared: Set<string>): Array<[string, string[]]> {
  const raw = schema.dependencies;
  if (!raw || typeof raw !== 'object') return [];
  const out: Array<[string, string[]]> = [];
  for (const [key, deps] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(deps) && declared.has(key)) {
      out.push([key, deps.filter(d => typeof d === 'string' && declared.has(d as string)) as string[]]);
    }
  }
  return out;
}

function enforceDependencies(
  value: Record<string, unknown>,
  dependencies: Array<[string, string[]]>
): Record<string, unknown> {
  let current = value;
  for (const [key, deps] of dependencies) {
    if (!(key in current)) continue;
    const missing = deps.filter(d => !(d in current));
    if (missing.length === 0) continue;
    // Drop the trigger key rather than fabricate values — keeping the sample
    // schema-valid costs us that property but preserves determinism.
    const { [key]: _dropped, ...rest } = current;
    void _dropped;
    current = rest;
  }
  return current;
}

function readObjectShape(schema: JsonSchema): ObjectShape {
  const properties = ((schema.properties as Record<string, JsonSchema>) ?? {}) as Record<string, JsonSchema>;
  const required = new Set<string>(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const additionalProperties =
    typeof schema.additionalProperties === 'boolean'
      ? schema.additionalProperties
      : ((schema.additionalProperties as JsonSchema | undefined) ?? true);
  return { properties, required, additionalProperties };
}

function collectAnyOfRequired(schema: JsonSchema): string[][] {
  if (!Array.isArray(schema.anyOf)) return [];
  const out: string[][] = [];
  for (const branch of schema.anyOf as JsonSchema[]) {
    if (branch && Array.isArray(branch.required) && Object.keys(branch).every(k => k === 'required' || k === 'type')) {
      out.push(branch.required as string[]);
    }
  }
  return out;
}

function buildPropertyRecordSpec(shape: ObjectShape, opts: ArbitraryOptions): Record<string, fc.Arbitrary<unknown>> {
  const spec: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [key, subSchema] of Object.entries(shape.properties)) {
    const fixtureArb = fixtureArbitraryForProperty(key, subSchema, opts.fixtures);
    spec[key] = fixtureArb ?? schemaToArbitrary(subSchema, opts);
  }
  // Honor additionalProperties: false by not emitting keys outside the declared set.
  // Additional-property generation (when the schema allows) is deferred — the
  // stateless tier schemas don't rely on that branch being exercised.
  void shape.additionalProperties;
  return spec;
}

/**
 * Map an AdCP request-property name to the fixture pool it should draw
 * from. Covers singular and plural forms of the well-known ID shapes.
 */
const PROPERTY_TO_POOL: Record<string, keyof ConformanceFixtures> = {
  creative_id: 'creative_ids',
  creative_ids: 'creative_ids',
  media_buy_id: 'media_buy_ids',
  media_buy_ids: 'media_buy_ids',
  list_id: 'list_ids',
  list_ids: 'list_ids',
  standards_id: 'standards_ids',
  standards_ids: 'standards_ids',
  task_id: 'task_ids',
  taskId: 'task_ids',
  plan_id: 'plan_ids',
  account_id: 'account_ids',
  package_id: 'package_ids',
  package_ids: 'package_ids',
};

function resolvePoolForKey(key: string, fixtures: ConformanceFixtures): readonly string[] | null {
  const poolName = PROPERTY_TO_POOL[key];
  if (!poolName) return null;
  const pool = fixtures[poolName];
  return pool && pool.length > 0 ? pool : null;
}

/**
 * If property `key` should be filled from a fixture pool, returns a
 * `fc.constantFrom`-backed arbitrary; otherwise `null` so the caller
 * falls through to schema-derived generation.
 *
 * Pool values are filtered against the sub-schema's string constraints
 * (`pattern`, `minLength`, `maxLength`). This closes two problems:
 *
 *   1. Name-collision: a pool can legitimately match a bare property
 *      name in a nested context where the semantic is different (e.g.,
 *      `account_id` appears both as a top-level ID and inside a nested
 *      oneOf branch). The nested occurrence typically has a tighter
 *      pattern; non-matching pool values drop out and the generator
 *      falls through to schema-derived strings.
 *   2. Pattern bypass: a pool of `['abc']` drawn into a field requiring
 *      `^mb_[a-z0-9]+$` would produce schema-invalid samples that the
 *      oracle would score as the agent's fault. Filtering keeps the
 *      generated request schema-valid.
 *
 * Handles two shapes — scalar `{ type: 'string' }` and plain array
 * `{ type: 'array', items: { type: 'string' } }`. Nested-structured IDs
 * (e.g. `signal_id` as an object with a discriminator) fall through to
 * schema-derived generation; fixture support for those is a P3 concern.
 */
function fixtureArbitraryForProperty(
  key: string,
  subSchema: JsonSchema,
  fixtures: ConformanceFixtures | undefined
): fc.Arbitrary<unknown> | null {
  if (!fixtures) return null;
  const pool = resolvePoolForKey(key, fixtures);
  if (!pool) return null;

  const type = normalizeType(subSchema);
  if (type === 'string') {
    const valid = pool.filter(v => satisfiesStringConstraints(v, subSchema));
    return valid.length > 0 ? fc.constantFrom(...valid) : null;
  }
  if (type === 'array') {
    const items = (subSchema.items as JsonSchema | undefined) ?? {};
    if (normalizeType(items) === 'string') {
      const valid = pool.filter(v => satisfiesStringConstraints(v, items));
      if (valid.length === 0) return null;
      const minItems = (subSchema.minItems as number | undefined) ?? 0;
      const declaredMax = subSchema.maxItems as number | undefined;
      // Capped at valid-pool size — `fc.constantFrom` can repeat, but
      // the schema usually asks for distinct IDs, so we keep the array
      // length ≤ valid-pool.
      const maxItems = Math.min(declaredMax ?? valid.length, valid.length);
      return fc.array(fc.constantFrom(...valid), {
        minLength: minItems,
        maxLength: Math.max(minItems, maxItems),
      });
    }
  }
  return null;
}

function satisfiesStringConstraints(value: string, schema: JsonSchema): boolean {
  if (typeof value !== 'string') return false;
  const minLength = schema.minLength as number | undefined;
  const maxLength = schema.maxLength as number | undefined;
  if (minLength !== undefined && value.length < minLength) return false;
  if (maxLength !== undefined && value.length > maxLength) return false;
  const pattern = schema.pattern as string | undefined;
  if (pattern) {
    try {
      if (!new RegExp(pattern).test(value)) return false;
    } catch {
      // Bad regex in the schema — err on the side of letting the pool
      // value through rather than silently dropping every fixture.
    }
  }
  return true;
}
