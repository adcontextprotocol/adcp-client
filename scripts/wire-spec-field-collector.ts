import { existsSync, readFileSync } from 'fs';
import { resolveSchemaRefInCache } from './schema-cache-ref';

export interface RequestSchemaDocument {
  properties?: Record<string, unknown>;
  allOf?: unknown[];
  $ref?: string;
}

/**
 * Collect the effective top-level properties of an object schema.
 *
 * Only whole-document references are accepted. Treating a fragment reference
 * as the referenced document root could widen a public wire allowlist, so a
 * future bundle that needs fragments must first add exact JSON Pointer
 * resolution here.
 */
export function collectTopLevelFields(
  schema: RequestSchemaDocument,
  schemaDir: string,
  visitedDocuments: Set<string>
): Set<string> {
  const fields = new Set(Object.keys(schema.properties ?? {}));
  if (typeof schema.$ref === 'string') {
    if (schema.$ref.includes('#')) {
      throw new Error(
        `generate-wire-spec-fields: refusing fragment schema reference ${schema.$ref}; exact JSON Pointer resolution is required`
      );
    }
    const referencedPath = resolveSchemaRefInCache(schemaDir, schema.$ref);
    if (!referencedPath) {
      throw new Error(`generate-wire-spec-fields: refusing unsupported schema reference ${schema.$ref}`);
    }
    if (!existsSync(referencedPath)) {
      throw new Error(`generate-wire-spec-fields: schema reference is absent from verified cache: ${schema.$ref}`);
    }
    if (!visitedDocuments.has(referencedPath)) {
      visitedDocuments.add(referencedPath);
      const referenced = JSON.parse(readFileSync(referencedPath, 'utf8')) as RequestSchemaDocument;
      for (const field of collectTopLevelFields(referenced, schemaDir, visitedDocuments)) fields.add(field);
    }
  }
  for (const member of schema.allOf ?? []) {
    if (!member || typeof member !== 'object' || Array.isArray(member)) continue;
    for (const field of collectTopLevelFields(member as RequestSchemaDocument, schemaDir, visitedDocuments)) {
      fields.add(field);
    }
  }
  return fields;
}
