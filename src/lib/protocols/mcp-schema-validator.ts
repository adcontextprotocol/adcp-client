import { createHash } from 'node:crypto';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator as ModernAjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { AjvJsonSchemaValidator as LegacyAjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

const MAX_CACHED_SCHEMAS = 256;

/** Content-keyed LRU shared by MCP clients, including schemas without an $id. */
export class CachedJsonSchemaValidator implements jsonSchemaValidator {
  private readonly compiled = new Map<string, JsonSchemaValidator<unknown>>();

  constructor(
    private readonly createProvider: () => jsonSchemaValidator,
    private readonly maxEntries = MAX_CACHED_SCHEMAS
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Schema cache capacity must be a positive safe integer');
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
      return cached as JsonSchemaValidator<T>;
    }

    // Give each entry its own compiler. A shared Ajv would retain schemas after
    // LRU eviction and could reuse the wrong schema when sellers share an $id.
    // The official provider retains its normal dialect and format behavior.
    // Compile the hashed snapshot: callers can mutate schemas returned by
    // listTools(), and Ajv retains references to some schema values (e.g. enums).
    const validator = this.createProvider().getValidator<T>(JSON.parse(serialized));
    this.compiled.set(key, validator);
    if (this.compiled.size > this.maxEntries) {
      const oldest = this.compiled.keys().next().value;
      if (oldest !== undefined) this.compiled.delete(oldest);
    }
    return validator;
  }
}

// Keep the v1 draft-07 default separate from v2's dialect-aware validation.
export const sharedLegacyJsonSchemaValidator = new CachedJsonSchemaValidator(() => new LegacyAjvJsonSchemaValidator());
export const sharedModernJsonSchemaValidator = new CachedJsonSchemaValidator(() => new ModernAjvJsonSchemaValidator());
