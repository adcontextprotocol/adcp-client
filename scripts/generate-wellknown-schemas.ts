#!/usr/bin/env tsx

/**
 * Generate Zod schemas from well-known JSON Schema files (brand.json, adagents.json).
 *
 * These are the /.well-known/ document formats that the existing TS→Zod pipeline
 * doesn't cover (it only handles tool request/response types). Uses the same
 * json-schema-to-zod dep and dereferencing strategy as generate-zod-schemas.ts.
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import path from 'path';
import { removeMinItemsConstraints } from './schema-utils';

const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/types/wellknown-schemas.generated.ts');

/** Well-known schemas to generate. Key = file name, value = exported Zod const name. */
const WELLKNOWN_SCHEMAS: Record<string, string> = {
  'brand.json': 'BrandJsonSchema',
  'adagents.json': 'AdagentsJsonSchema',
};

function getLatestCacheDir(): string {
  if (!existsSync(SCHEMA_CACHE_DIR)) {
    throw new Error('Schema cache directory not found. Run "npm run sync-schemas" first.');
  }
  const versions = readdirSync(SCHEMA_CACHE_DIR)
    .filter(f => statSync(path.join(SCHEMA_CACHE_DIR, f)).isDirectory())
    .sort()
    .reverse();
  if (versions.length === 0) {
    throw new Error('No cached schema versions found.');
  }
  return path.join(SCHEMA_CACHE_DIR, versions[0]);
}

function loadCachedSchema(schemaRef: string): any {
  const latestCacheDir = getLatestCacheDir();
  let relativePath = schemaRef;
  if (relativePath.startsWith('/schemas/')) {
    relativePath = relativePath.substring('/schemas/'.length);
    const firstSlash = relativePath.indexOf('/');
    if (firstSlash > 0) {
      relativePath = relativePath.substring(firstSlash + 1);
    }
  }
  const schemaPath = path.resolve(latestCacheDir, relativePath);
  // Guard against path traversal via crafted $ref values
  if (!schemaPath.startsWith(path.resolve(latestCacheDir) + path.sep)) {
    console.warn(`  ⚠️  Schema ref escapes cache directory: ${schemaRef}`);
    return null;
  }
  if (!existsSync(schemaPath)) {
    console.warn(`  ⚠️  Schema not found: ${schemaPath}`);
    return null;
  }
  return JSON.parse(readFileSync(schemaPath, 'utf8'));
}

/**
 * Fully dereference a JSON Schema — inline both external $refs (file paths)
 * and local $refs (#/definitions/...). json-schema-to-zod doesn't resolve
 * either kind reliably, so we do it ourselves.
 */
function dereferenceSchema(schema: any, rootSchema: any, visited: Set<string> = new Set()): any {
  if (typeof schema !== 'object' || schema === null) return schema;

  if (schema.$ref && typeof schema.$ref === 'string') {
    const refPath = schema.$ref;

    // Cycle detection: if we've already seen this ref in the current chain, bail
    if (visited.has(refPath)) {
      console.warn(`  ⚠️  Circular $ref: ${refPath}`);
      return { type: 'object', additionalProperties: true };
    }
    const childVisited = new Set(visited);
    childVisited.add(refPath);

    // Local definition refs (#/definitions/foo)
    if (refPath.startsWith('#/definitions/')) {
      const defName = refPath.substring('#/definitions/'.length);
      const def = rootSchema?.definitions?.[defName];
      if (!def) {
        console.warn(`  ⚠️  Missing local definition: ${refPath}`);
        return { type: 'object', additionalProperties: true };
      }
      const dereferenced = dereferenceSchema(def, rootSchema, childVisited);
      const { $ref, ...rest } = schema;
      return Object.keys(rest).length > 0 ? { ...dereferenced, ...rest } : dereferenced;
    }

    // External refs
    const resolved = loadCachedSchema(refPath);
    if (!resolved) {
      console.warn(`  ⚠️  Unresolved $ref: ${refPath}`);
      return { type: 'object', additionalProperties: true };
    }

    // External schemas are their own root
    const dereferenced = dereferenceSchema(resolved, resolved, childVisited);
    const { $ref, ...rest } = schema;
    return Object.keys(rest).length > 0 ? { ...dereferenced, ...rest } : dereferenced;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => dereferenceSchema(item, rootSchema, visited));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    // Skip the definitions block itself — we inline refs as we encounter them
    if (key === 'definitions') continue;
    result[key] = dereferenceSchema(value, rootSchema, visited);
  }
  return result;
}

/**
 * Convert all `oneOf` to `anyOf` in a JSON Schema tree.
 *
 * json-schema-to-zod emits `z.any().superRefine(...)` for `oneOf` using Zod v3
 * APIs that are incompatible with Zod v4. It handles `anyOf` as `z.union()`.
 * The semantic difference (exactly-one vs at-least-one) is immaterial for
 * runtime validation — z.union tries schemas in order and accepts the first match.
 */
function oneOfToAnyOf(schema: any): any {
  if (typeof schema !== 'object' || schema === null) return schema;
  if (Array.isArray(schema)) return schema.map(oneOfToAnyOf);

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'oneOf') {
      result['anyOf'] = oneOfToAnyOf(value);
    } else {
      result[key] = oneOfToAnyOf(value);
    }
  }
  return result;
}

/**
 * Post-process generated Zod code for Zod v4 compatibility.
 *
 * json-schema-to-zod targets Zod v3. Fix known incompatibilities:
 * - .datetime({ offset: true }) → .datetime() (v4 accepts offsets by default)
 * - .unique() → removed (not available in Zod v4 arrays)
 * - duplicate import lines
 */
function postProcess(code: string): string {
  let result = code;
  // Remove duplicate imports
  result = result.replace(/^import \{ z \} from ["']zod["'];?\n*/gm, '');
  // .datetime({ offset: true }) → .datetime()
  result = result.replace(/\.datetime\(\{[^}]*\}\)/g, '.datetime()');
  // .unique() is not in Zod v4
  result = result.replace(/\.unique\(\)/g, '');
  // z.record(valueSchema) → z.record(z.string(), valueSchema) (Zod v4 requires key schema)
  result = result.replace(/z\.record\((?!z\.string\(\)\s*,)/g, 'z.record(z.string(), ');
  return result;
}

function convertSchemaToZod(schema: any, name: string): string {
  const dereferenced = dereferenceSchema(schema, schema);
  const relaxed = removeMinItemsConstraints(dereferenced);
  const normalized = oneOfToAnyOf(relaxed);
  const code = jsonSchemaToZod(normalized, { name, module: 'esm' });
  return postProcess(code);
}

function writeIfChanged(filePath: string, content: string): boolean {
  const strip = (s: string) => s.replace(/\/\/ Generated at: .*\n/, '');
  if (existsSync(filePath) && strip(readFileSync(filePath, 'utf8')) === strip(content)) {
    return false;
  }
  writeFileSync(filePath, content);
  return true;
}

async function main() {
  console.log('🔄 Generating Zod schemas for well-known files…');
  const cacheDir = getLatestCacheDir();

  let output = `// Generated Zod schemas for AdCP well-known files (brand.json, adagents.json)
// Generated at: ${new Date().toISOString()}
// Source: schemas/cache/latest/*.json → json-schema-to-zod
//
// DO NOT EDIT — regenerate with: npm run generate-wellknown-schemas

import { z } from 'zod';

`;

  for (const [fileName, zodName] of Object.entries(WELLKNOWN_SCHEMAS)) {
    const schemaPath = path.join(cacheDir, fileName);
    if (!existsSync(schemaPath)) {
      console.error(`❌ ${fileName} not found in ${cacheDir}`);
      process.exit(1);
    }

    console.log(`  📥 ${fileName} → ${zodName}`);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const code = convertSchemaToZod(schema, zodName);
    output += `// ---- ${fileName} ----\n${code}\n`;
    output += `export type ${zodName.replace('Schema', '')} = z.infer<typeof ${zodName}>;\n\n`;
    console.log(`  ✅ ${zodName}`);
  }

  const changed = writeIfChanged(OUTPUT_FILE, output);
  console.log(changed ? `✅ Wrote ${OUTPUT_FILE}` : `✅ ${OUTPUT_FILE} is up to date`);
}

main().catch(err => {
  console.error('❌', err);
  process.exit(1);
});
