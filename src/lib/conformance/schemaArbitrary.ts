import fc from 'fast-check';

type JsonSchema = Record<string, unknown> & { type?: string | string[] };

/**
 * Converts a draft-07 JSON Schema into a fast-check arbitrary that
 * produces schema-valid values. Covers the subset of JSON Schema used
 * by AdCP bundled request schemas. Unsupported constructs fall through
 * to a permissive arbitrary rather than throwing, so the fuzzer keeps
 * running on the remainder of the schema.
 */
export function schemaToArbitrary(schema: JsonSchema): fc.Arbitrary<unknown> {
  if (!schema || typeof schema !== 'object') return fc.anything();

  if ('const' in schema) return fc.constant(schema.const);
  if (Array.isArray(schema.enum)) return fc.constantFrom(...(schema.enum as unknown[]));

  // Composite-shape oneOf: the whole value is one of the branches.
  // Only replaces the dispatch when the outer schema has no standalone
  // `properties` — otherwise oneOf is a side-constraint we generate past.
  if (Array.isArray(schema.oneOf) && !hasOwnProperties(schema)) {
    return fc.oneof(...schema.oneOf.map(s => schemaToArbitrary(s as JsonSchema)));
  }
  if (Array.isArray(schema.anyOf) && !hasOwnProperties(schema)) {
    return fc.oneof(...schema.anyOf.map(s => schemaToArbitrary(s as JsonSchema)));
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
      return arrayArb(schema);
    case 'object':
      return objectArb(schema);
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

function arrayArb(schema: JsonSchema): fc.Arbitrary<unknown[]> {
  const items = (schema.items as JsonSchema | undefined) ?? {};
  const minItems = (schema.minItems as number | undefined) ?? 0;
  const maxItems = (schema.maxItems as number | undefined) ?? Math.max(minItems, 3);
  const unique = schema.uniqueItems === true;
  if (unique) {
    return fc.uniqueArray(schemaToArbitrary(items), {
      minLength: minItems,
      maxLength: maxItems,
      selector: x => JSON.stringify(x),
    });
  }
  return fc.array(schemaToArbitrary(items), { minLength: minItems, maxLength: maxItems });
}

interface ObjectShape {
  properties: Record<string, JsonSchema>;
  required: Set<string>;
  additionalProperties: boolean | JsonSchema;
}

function objectArb(schema: JsonSchema): fc.Arbitrary<Record<string, unknown>> {
  const shape = readObjectShape(schema);
  const anyOfRequired = collectAnyOfRequired(schema);
  const propertySpec = buildPropertyRecordSpec(shape);
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

  if (dependencies.length === 0) return base;
  return base.map(value => enforceDependencies(value, dependencies));
}

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

function buildPropertyRecordSpec(shape: ObjectShape): Record<string, fc.Arbitrary<unknown>> {
  const spec: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [key, subSchema] of Object.entries(shape.properties)) {
    spec[key] = schemaToArbitrary(subSchema);
  }
  // Honor additionalProperties: false by not emitting keys outside the declared set.
  // Additional-property generation (when the schema allows) is deferred — the
  // stateless tier schemas don't rely on that branch being exercised.
  void shape.additionalProperties;
  return spec;
}
