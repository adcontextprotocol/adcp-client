#!/usr/bin/env tsx

import { generate } from 'ts-to-zod';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Generate Zod v4 schemas from TypeScript types
 * Uses ts-to-zod to convert our generated TypeScript types to Zod schemas
 *
 * This script generates schemas for ALL types in the source files.
 * Previously we used a whitelist approach, but that was fragile and caused
 * missing dependency bugs. Generating everything is simpler and more reliable.
 */

const CORE_SOURCE_FILE = path.join(__dirname, '../src/lib/types/core.generated.ts');
const TOOLS_SOURCE_FILE = path.join(__dirname, '../src/lib/types/tools.generated.ts');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/types/schemas.generated.ts');

/**
 * Post-process generated Zod schemas to convert .optional() to .nullish() globally.
 * This is needed because real-world API responses often send explicit null values for optional
 * fields, but ts-to-zod generates .optional() which only accepts undefined.
 * Using .nullish() accepts both undefined and null.
 *
 * Many JSON serializers (Python, Java, etc.) default to sending null for absent optional fields,
 * so treating "optional" as "can be undefined OR null" is the pragmatic approach.
 */
function postProcessForNullish(content: string): string {
  // Replace .optional() with .nullish() globally, except when preceded by .never()
  // z.never().optional() must stay as-is: it means "this field must not be provided",
  // and converting to .nullish() would allow null values through, weakening that constraint.
  return content.replace(/(?<!\.never\(\))\.optional\(\)/g, '.nullish()');
}

/**
 * Post-process generated Zod schemas to fix imports from "undefined".
 *
 * ts-to-zod generates `import { type X } from "undefined"` for recursive types
 * when passed combined source text instead of real file paths. The TypeScript type
 * is needed for the z.ZodSchema<X> annotation on z.lazy() schemas. Since all tool
 * types live in tools.generated.ts (same directory as the output), replace the
 * broken import with the correct relative path.
 */
function postProcessUndefinedImports(content: string): string {
  return content.replace(/from "undefined"/g, 'from "./tools.generated"');
}

/**
 * Post-process generated Zod schemas to loosen explicit type annotations on lazy schemas.
 *
 * ts-to-zod generates `export const XSchema: z.ZodSchema<X> = z.lazy(() => ...)` for
 * recursive types. After our .nullish() post-processing the inferred type no longer
 * matches the strict TypeScript type X (optional fields become `T | null | undefined`
 * instead of `T | undefined`). Replace the annotation with `z.ZodTypeAny` to avoid
 * the incompatibility while still breaking the circular reference TypeScript needs.
 *
 * Note: `[^>]+` assumes the type parameter is a simple identifier with no nested generics
 * (e.g., `z.ZodSchema<Foo>` not `z.ZodSchema<Map<string, Foo>>`). ts-to-zod only ever
 * generates simple identifiers here in practice.
 */
function postProcessLazyTypeAnnotations(content: string): string {
  const result = content.replace(/: z\.ZodSchema<[^>]+>/g, ': z.ZodTypeAny');
  // Guard: if any broken annotation remains, fail fast rather than silently produce
  // a TypeScript error that's hard to trace back to this post-processing step.
  if (result.includes('from "undefined"') || result.includes(': z.ZodSchema<')) {
    throw new Error(
      'postProcessLazyTypeAnnotations: unresolved z.ZodSchema<> annotation or "undefined" import in output. ' +
        'A recursive type may have a nested generic parameter — update the regex.'
    );
  }
  return result;
}

/**
 * Post-process generated Zod schemas to convert tuple patterns to arrays.
 *
 * ts-to-zod converts TypeScript arrays with @minItems JSDoc annotations to Zod tuples:
 *   z.tuple([z.string()]).rest(z.string())
 *
 * This requires at least one element, but agents in the wild return empty arrays.
 * Convert these patterns to simple arrays that allow empty arrays:
 *   z.array(z.string())
 *
 * This is more lenient than the JSON Schema spec (which requires minItems: 1),
 * but necessary for real-world interoperability.
 *
 * LIMITATIONS: This regex handles simple patterns like z.tuple([z.string()]).rest(z.string())
 * but may not handle complex nested schemas with brackets (e.g., z.object({ ... })).
 * The [^\]]+ pattern stops at the first closing bracket, which works for primitive types
 * and simple references. If edge cases with nested objects appear, consider using an AST parser.
 */
function postProcessTuplesToArrays(content: string): string {
  // Match patterns like: z.tuple([SomeSchema]).rest(SomeSchema)
  // and convert to: z.array(SomeSchema)
  // The pattern captures the inner schema type and uses a backreference to ensure they match
  return content.replace(/z\.tuple\(\[([^\]]+)\]\)\.rest\(\1\)/g, 'z.array($1)');
}

/**
 * Post-process generated Zod schemas to add .passthrough() to all z.object() calls,
 * including deeply nested inline objects.
 *
 * By default, Zod object schemas strip unknown keys during parsing. This causes real-world
 * agent responses with extra/platform-specific fields to lose those fields after validation.
 * Adding .passthrough() preserves unknown keys while still validating known fields.
 *
 * This uses balanced-parenthesis scanning. The body of each z.object() is accumulated and
 * recursively post-processed before emitting, so nested inline z.object() calls also
 * receive .passthrough().
 *
 * LIMITATION: The depth counter does not account for string literals or comments containing
 * bare parentheses. This is safe for ts-to-zod output, which only places parentheses inside
 * function-call syntax, never inside string values. If that assumption ever breaks, switch
 * to an AST-based approach.
 */
function postProcessForPassthrough(content: string): string {
  const MARKER = 'z.object(';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      result += MARKER;
      i += MARKER.length;

      // Accumulate the body of z.object(...) by tracking balanced parens.
      // We start with depth=1 (the opening `(` has already been consumed).
      let depth = 1;
      let body = '';
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          depth--;
          if (depth === 0) {
            // Recursively process the body so nested z.object() calls also get .passthrough()
            result += postProcessForPassthrough(body);
            result += ').passthrough()';
            i++;
            break;
          }
        }
        body += ch;
        i++;
      }
    } else {
      result += content[i];
      i++;
    }
  }

  return result;
}

/**
 * Post-process generated Zod schemas to remove z.undefined() from unions.
 *
 * ts-to-zod generates unions like z.union([z.unknown(), z.undefined()]) for TypeScript's
 * Record<string, unknown>, and z.union([z.boolean(), z.undefined()]) for Record<string,
 * boolean | undefined>. z.undefined() cannot be represented in JSON Schema, causing
 * Zod v4's toJSONSchema() to throw "Undefined cannot be represented in JSON Schema".
 * This breaks MCP SDK tool registration (tools/list fails).
 *
 * The fix:
 * - z.union([z.unknown(), z.undefined()]) → z.unknown()
 * - z.union([z.SomeType(), z.undefined()]) → z.SomeType()  (the parent's .nullish()
 *   already handles optionality, and records inherently allow missing keys)
 */
function postProcessUndefinedUnions(content: string): string {
  // First: z.union([z.unknown(), z.undefined()]) → z.unknown()
  let result = content.replace(
    /z\.union\(\[z\.unknown\(\), z\.undefined\(\)\]\)/g,
    'z.unknown()'
  );
  // Then: remove z.undefined() as a union member anywhere it appears.
  // Handles both simple cases like z.union([z.boolean(), z.undefined()])
  // and complex nested cases like z.union([z.object({...}).passthrough(), z.undefined()])
  // by removing the ", z.undefined()" tail from inside unions.
  result = result.replace(/, z\.undefined\(\)/g, '');
  return result;
}

/**
 * Post-process generated Zod schemas to resolve intersection types that lack .shape.
 *
 * The MCP SDK requires z.object().shape for tool input registration via server.tool().
 * ts-to-zod produces .and() intersections from TypeScript's & operator, which breaks
 * .shape access. Three patterns need fixing:
 *
 * 1. z.object({...}).passthrough().and(z.record(z.string(), z.unknown()))
 *    Redundant: .passthrough() already preserves unknown keys.
 *    Fix: Strip the .and(z.record(...)) suffix.
 *
 * 2. z.record(z.string(), ...).and(z.object({...}).passthrough())
 *    The z.object() has all typed fields; z.record() just allows extras.
 *    Fix: Replace entire expression with the z.object() content.
 *
 * 3. z.object({...}).passthrough().and(z.union([...z.never()...]))
 *    Discriminated union constraints (conditional field validation).
 *    Fix: Strip the .and(z.union(...)) suffix. The base object already
 *    has all fields; the union only adds conditional validation using z.never().
 */
function postProcessIntersections(content: string): string {
  let result = content;

  // Pass 1: Strip `.and(z.record(z.string(), z.unknown()))` — redundant with .passthrough()
  result = result.replace(/\.and\(z\.record\(z\.string\(\), z\.unknown\(\)\)\)/g, '');

  // Pass 2: Replace `z.record(...).and(CONTENT)` with CONTENT
  // Transforms z.record(z.string(), z.unknown()).and(z.object({...}).passthrough())
  // into just z.object({...}).passthrough()
  result = unwrapRecordIntersections(result);

  // Pass 3: Strip `.and(z.union([...]))` where content contains z.never()
  // These are discriminated union constraints that only add conditional validation
  result = stripNeverUnionIntersections(result);

  return result;
}

/**
 * Replace `z.record(...).and(CONTENT)` with just CONTENT.
 *
 * TypeScript types like `{ [k: string]: unknown } & { typed_fields }` produce
 * z.record().and(z.object()) in Zod. Since z.object().passthrough() already
 * preserves unknown keys, the z.record() wrapper is redundant.
 *
 * Uses balanced-parenthesis scanning to handle nested schemas correctly.
 */
function unwrapRecordIntersections(content: string): string {
  const MARKER = 'z.record(';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      const recordStart = i;
      i += MARKER.length;

      // Scan balanced parens to find end of z.record(...)
      let depth = 1;
      const recordBodyStart = i;
      while (i < content.length && depth > 0) {
        if (content[i] === '"' || content[i] === "'") {
          const quote = content[i]; i++;
          while (i < content.length && content[i] !== quote) {
            if (content[i] === '\\') i++;
            i++;
          }
          if (i < content.length) i++; // closing quote
          continue;
        }
        if (content[i] === '(') depth++;
        else if (content[i] === ')') depth--;
        i++;
      }
      const recordBody = content.substring(recordBodyStart, i - 1);

      // Only unwrap z.record(z.string(), z.unknown()) — the additionalProperties pattern.
      // Keep other z.record() types (e.g. z.record(z.string(), z.number())) as-is.
      const isRedundantRecord = recordBody.trim() === 'z.string(), z.unknown()';

      // Check if followed by .and(
      if (isRedundantRecord && content.startsWith('.and(', i)) {
        i += '.and('.length;

        // Scan balanced parens to extract .and() content
        depth = 1;
        let andContent = '';
        while (i < content.length && depth > 0) {
          if (content[i] === '"' || content[i] === "'") {
            const quote = content[i]; andContent += content[i]; i++;
            while (i < content.length && content[i] !== quote) {
              if (content[i] === '\\') { andContent += content[i]; i++; }
              andContent += content[i]; i++;
            }
            if (i < content.length) { andContent += content[i]; i++; }
            continue;
          }
          if (content[i] === '(') depth++;
          else if (content[i] === ')') {
            depth--;
            if (depth === 0) {
              i++; // skip closing )
              break;
            }
          }
          andContent += content[i];
          i++;
        }

        // Replace z.record(...).and(CONTENT) with just CONTENT
        result += andContent;
      } else {
        // z.record(...) not followed by .and( — keep as-is
        result += content.substring(recordStart, i);
      }
    } else {
      result += content[i];
      i++;
    }
  }

  return result;
}

/**
 * Strip `.and(z.union([...]))` where the union body contains z.never().
 *
 * TypeScript discriminated unions like:
 *   { base_fields } & ({ buying_mode: 'brief'; refine?: never } | ...)
 * produce .and(z.union([z.object({ buying_mode: ..., refine: z.never() })])) in Zod.
 *
 * These constraints are useful for runtime validation but break .shape access.
 * The base z.object() already contains all fields with correct types; the union
 * only adds conditional field presence rules better communicated in tool descriptions.
 */
function stripNeverUnionIntersections(content: string): string {
  const MARKER = '.and(z.union([';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      const andStart = i;
      i += '.and('.length; // position at z.union([

      // Scan balanced parens to find end of .and(...)
      let depth = 1;
      let andContent = '';
      while (i < content.length && depth > 0) {
        if (content[i] === '"' || content[i] === "'") {
          const quote = content[i]; andContent += content[i]; i++;
          while (i < content.length && content[i] !== quote) {
            if (content[i] === '\\') { andContent += content[i]; i++; }
            andContent += content[i]; i++;
          }
          if (i < content.length) { andContent += content[i]; i++; }
          continue;
        }
        if (content[i] === '(') depth++;
        else if (content[i] === ')') {
          depth--;
          if (depth === 0) {
            i++; // skip closing )
            break;
          }
        }
        andContent += content[i];
        i++;
      }

      // Only strip if the union contains z.never() (discriminated constraints)
      if (andContent.includes('z.never()')) {
        // Strip entire .and(z.union([...]))
      } else {
        // Keep it — not a discriminated union constraint
        result += content.substring(andStart, i);
      }
    } else {
      result += content[i];
      i++;
    }
  }

  return result;
}

// Write file only if content differs (excluding timestamp)
function writeFileIfChanged(filePath: string, newContent: string): boolean {
  const contentWithoutTimestamp = (content: string) => {
    return content.replace(/\/\/ Generated at: .*?\n/, '// Generated at: [TIMESTAMP]\n');
  };

  let hasChanged = true;
  if (existsSync(filePath)) {
    const existingContent = readFileSync(filePath, 'utf8');
    const existingWithoutTimestamp = contentWithoutTimestamp(existingContent);
    const newWithoutTimestamp = contentWithoutTimestamp(newContent);

    if (existingWithoutTimestamp === newWithoutTimestamp) {
      hasChanged = false;
    }
  }

  if (hasChanged) {
    writeFileSync(filePath, newContent);
  }

  return hasChanged;
}

async function generateZodSchemas() {
  console.log('🔄 Generating Zod v4 schemas from TypeScript types...');
  console.log(`📥 Core source: ${CORE_SOURCE_FILE}`);
  console.log(`📥 Tools source: ${TOOLS_SOURCE_FILE}`);
  console.log(`📤 Output: ${OUTPUT_FILE}`);

  if (!existsSync(CORE_SOURCE_FILE)) {
    console.error(`❌ Core source file not found: ${CORE_SOURCE_FILE}`);
    console.error('   Please run "npm run generate-types" first.');
    process.exit(1);
  }

  if (!existsSync(TOOLS_SOURCE_FILE)) {
    console.error(`❌ Tools source file not found: ${TOOLS_SOURCE_FILE}`);
    console.error('   Please run "npm run generate-types" first.');
    process.exit(1);
  }

  try {
    // Read the TypeScript sources
    const coreContent = readFileSync(CORE_SOURCE_FILE, 'utf8');
    const toolsContent = readFileSync(TOOLS_SOURCE_FILE, 'utf8');

    // Merge both sources so cross-file type dependencies can be resolved
    const combinedSource = `${coreContent}\n\n// ====== TOOL TYPES ======\n\n${toolsContent}`;

    console.log('📦 Generating Zod schemas for all types...');

    // Generate schemas for ALL types - no filter needed
    // This ensures all dependencies are available and avoids missing schema bugs
    const result = generate({
      sourceText: combinedSource,
      skipParseJSDoc: false,
      getSchemaName: name => `${name}Schema`,
    });

    // Check for generation errors and log warnings
    // Note: Some complex discriminated unions may fail Zod generation but still have valid TypeScript types
    // This is acceptable - TypeScript provides compile-time validation, Zod provides runtime validation
    if (result.errors.length > 0) {
      console.warn('⚠️  Some schemas could not be generated (this is non-fatal):');
      result.errors.forEach(error => console.warn(`   ${error}`));
      console.warn('\n💡 These schemas use complex discriminated unions not supported by ts-to-zod.');
      console.warn('   TypeScript types are still enforced at compile-time.');
      console.warn('   Runtime validation will fall back to TypeScript type checking.\n');
    }

    // Get the generated Zod schemas
    let zodSchemas = result.getZodSchemasFile();

    // Post-process: Convert .optional() to .nullish() for PackageSchema fields
    // This is needed because real-world API responses (e.g., Yahoo webhook) send explicit
    // null values for optional fields, but ts-to-zod generates .optional() which only
    // accepts undefined, not null. Using .nullish() accepts both undefined and null.
    zodSchemas = postProcessForNullish(zodSchemas);

    // Post-process: Fix broken imports from "undefined" (recursive types with z.lazy())
    zodSchemas = postProcessUndefinedImports(zodSchemas);

    // Post-process: Loosen z.ZodSchema<X> annotations on lazy schemas to z.ZodTypeAny
    // Our .nullish() post-processing makes the inferred type incompatible with the strict
    // TypeScript type annotation. ZodTypeAny avoids this while still breaking circular refs.
    zodSchemas = postProcessLazyTypeAnnotations(zodSchemas);

    // Post-process: Convert tuple patterns to arrays to allow empty arrays
    // ts-to-zod converts @minItems 1 to z.tuple([]).rest() which requires at least one element,
    // but agents in the wild return empty arrays. This relaxes validation for interoperability.
    zodSchemas = postProcessTuplesToArrays(zodSchemas);

    // Post-process: Add .passthrough() to all z.object() schemas so unknown keys are preserved.
    // Agents may return extra/platform-specific fields not in the schema. Without passthrough,
    // Zod strips those fields, causing data loss for consumers who need them.
    zodSchemas = postProcessForPassthrough(zodSchemas);

    // Post-process: Replace z.union([z.unknown(), z.undefined()]) with z.unknown().
    // ts-to-zod generates this union for TypeScript's Record<string, unknown>, but
    // z.undefined() cannot be converted to JSON Schema (it has no representation).
    // z.unknown() already accepts undefined at runtime, so this is semantically identical.
    // Without this fix, 73+ schemas fail MCP SDK's tools/list JSON Schema conversion.
    zodSchemas = postProcessUndefinedUnions(zodSchemas);

    // Post-process: Resolve .and() intersections so all schemas have .shape.
    // ts-to-zod produces z.record().and(z.object()) and z.object().and(z.union())
    // from TypeScript intersection types. These break MCP SDK's server.tool()
    // which requires schema.shape for JSON Schema generation.
    zodSchemas = postProcessIntersections(zodSchemas);

    // Create header with metadata
    const header = `// Generated Zod v4 schemas from TypeScript types
// Generated at: ${new Date().toISOString()}
// Sources:
//   - ${path.basename(CORE_SOURCE_FILE)} (core types)
//   - ${path.basename(TOOLS_SOURCE_FILE)} (tool types)
//
// These schemas provide runtime validation for AdCP data structures
// Generated using ts-to-zod from TypeScript type definitions

`;

    const finalContent = header + zodSchemas;

    // Write the output
    const changed = writeFileIfChanged(OUTPUT_FILE, finalContent);

    if (changed) {
      console.log(`✅ Generated Zod schemas: ${OUTPUT_FILE}`);
    } else {
      console.log(`✅ Zod schemas are up to date: ${OUTPUT_FILE}`);
    }

    // Count schemas from output (each 'export const' is a schema)
    const schemaCount = (zodSchemas.match(/export const/g) || []).length;
    console.log(`📊 Generated ${schemaCount} Zod v4 schemas`);
    console.log('✨ Done!');
  } catch (error) {
    console.error('❌ Failed to generate Zod schemas:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  generateZodSchemas().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

export { generateZodSchemas };
