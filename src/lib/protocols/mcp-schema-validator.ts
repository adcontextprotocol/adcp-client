import { createHash } from 'node:crypto';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator as ModernAjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { AjvJsonSchemaValidator as LegacyAjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

const MAX_CACHED_SCHEMAS = 256;
const MAX_CACHED_SCHEMA_BYTES = 64 * 1024 ** 2;

/** Content-keyed LRU shared by MCP clients, including schemas without an $id. */
export class CachedJsonSchemaValidator implements jsonSchemaValidator {
  private readonly compiled = new Map<string, { validator: JsonSchemaValidator<unknown>; bytes: number }>();
  private cachedBytes = 0;

  constructor(
    private readonly createProvider: (schema: JsonSchemaType, factored: boolean) => jsonSchemaValidator,
    private readonly maxEntries = MAX_CACHED_SCHEMAS,
    private readonly maxBytes = MAX_CACHED_SCHEMA_BYTES
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Schema cache capacity must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('Schema cache byte budget must be a positive safe integer');
    }
  }

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    // Key order can cause an extra compile, but never reuse a different schema.
    const serialized = JSON.stringify(schema);
    const key = createHash('sha256').update(serialized).digest('hex');
    const cached = this.compiled.get(key);
    if (cached) {
      this.compiled.delete(key);
      this.compiled.set(key, cached);
      return cached.validator as JsonSchemaValidator<T>;
    }

    // Give each entry its own compiler. A shared Ajv would retain schemas after
    // LRU eviction and could reuse the wrong schema when sellers share an $id.
    // The official provider retains its normal dialect and format behavior.
    // Compile the hashed snapshot: callers can mutate schemas returned by
    // listTools(), and Ajv retains references to some schema values (e.g. enums).
    let snapshot = JSON.parse(serialized) as JsonSchemaType;
    let factored = false;
    // Small schemas need no factoring. Load the compactor only when discovery
    // supplies a large document, keeping ordinary client imports lightweight.
    if (Buffer.byteLength(serialized) >= 64 * 1024) {
      const { compactMcpSchemaForValidation } =
        require('../validation/compact-schema') as typeof import('../validation/compact-schema');
      const prepared = compactMcpSchemaForValidation(snapshot as Record<string, unknown>) as JsonSchemaType;
      factored = prepared !== snapshot;
      snapshot = prepared;
    }
    const validator = this.createProvider(snapshot, factored).getValidator<T>(snapshot);
    const bytes = Buffer.byteLength(serialized);
    // Oversized schemas still validate normally, but do not displace the cache
    // or stay pinned after the client's validator is released. This budget
    // bounds retained schema bytes, not the engine-dependent generated code.
    if (bytes > this.maxBytes) return validator;
    this.compiled.set(key, { validator, bytes });
    this.cachedBytes += bytes;
    while (this.compiled.size > this.maxEntries || this.cachedBytes > this.maxBytes) {
      const oldest = this.compiled.keys().next().value;
      if (oldest === undefined) break;
      this.cachedBytes -= this.compiled.get(oldest)!.bytes;
      this.compiled.delete(oldest);
    }
    return validator;
  }
}

// Keep the v1 draft-07 default separate from v2's dialect-aware validation.
function createAjv(dialect: 'draft-7' | '2019-09' | '2020-12') {
  // Use the official providers' documented custom-Ajv extension. Preserve their
  // validation and format options, changing only reference code generation.
  const { default: Ajv } = (
    dialect === '2020-12' ? require('ajv/dist/2020') : dialect === '2019-09' ? require('ajv/dist/2019') : require('ajv')
  ) as typeof import('ajv');
  const { default: addFormats } = require('ajv-formats') as typeof import('ajv-formats');
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
    inlineRefs: false,
  });
  addFormats(ajv);
  return ajv;
}

export const sharedLegacyJsonSchemaValidator = new CachedJsonSchemaValidator((_schema, factored) =>
  factored ? new LegacyAjvJsonSchemaValidator(createAjv('draft-7')) : new LegacyAjvJsonSchemaValidator()
);
export const sharedModernJsonSchemaValidator = new CachedJsonSchemaValidator((schema, factored) => {
  // Unsupported graphs and small documents retain the exact official engine,
  // including the modern SDK's bundled Ajv version and its URI edge behavior.
  if (!factored) return new ModernAjvJsonSchemaValidator();
  const declared = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : undefined;
  if (declared === undefined || /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema$/.test(declared))
    return new ModernAjvJsonSchemaValidator(createAjv('2020-12'));
  if (/^https?:\/\/json-schema\.org\/draft\/2019-09\/schema$/.test(declared))
    return new ModernAjvJsonSchemaValidator(createAjv('2019-09'));
  if (/^https?:\/\/json-schema\.org\/draft-0[67]\/schema$/.test(declared))
    return new ModernAjvJsonSchemaValidator(createAjv('draft-7'));
  // Let the official provider reject unknown dialects with its normal error.
  return new ModernAjvJsonSchemaValidator();
});
