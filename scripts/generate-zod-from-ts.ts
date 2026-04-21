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
 * Large union schemas exceed TypeScript's serialization limit (TS7056) when their inferred
 * type has to be written into a .d.ts file. The fix is to give them an explicit `z.ZodType`
 * annotation so TypeScript stops trying to serialize the inferred shape.
 *
 * ts-to-zod doesn't know which schemas will trip TS7056, so we patch the known offenders
 * after generation. If a new schema hits TS7056 in the future, add it to this list rather
 * than scattering annotations across the codebase.
 */
const TS7056_SCHEMAS = ['AdCPAsyncResponseDataSchema', 'MCPWebhookPayloadSchema'];

function postProcessTS7056Annotations(content: string): string {
  let result = content;
  for (const name of TS7056_SCHEMAS) {
    const pattern = new RegExp(`export const ${name} = `);
    if (!pattern.test(result)) {
      throw new Error(
        `postProcessTS7056Annotations: expected to find "export const ${name} = " in generated output. ` +
          'The schema may have been renamed or removed — update TS7056_SCHEMAS.'
      );
    }
    result = result.replace(pattern, `export const ${name}: z.ZodType = `);
  }
  return result;
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
 * Post-process generated Zod schemas to remove z.undefined() from unions.
 *
 * ts-to-zod generates z.undefined() in unions for TypeScript types like
 * `Record<string, boolean | undefined>` → `z.union([z.boolean(), z.undefined()])`.
 * z.undefined() has no JSON Schema representation, so toJSONSchema() throws.
 *
 * For two-member unions like `z.union([X, z.undefined()])`, unwrap to just `X`.
 * For multi-member unions, remove the z.undefined() member.
 *
 * This is safe because:
 * - In record values: absent keys already return undefined
 * - In .nullish() fields: undefined is already accepted
 * - z.unknown() already accepts undefined at runtime
 *
 * Uses balanced-bracket scanning to handle nested schemas like
 * z.union([z.object({...}).passthrough(), z.undefined()]).
 */
function postProcessUndefinedUnions(content: string): string {
  const MARKER = 'z.union([';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      // Scan forward to find the matching ])
      const start = i;
      i += MARKER.length;
      let depth = 1; // tracking [ ] balance
      let body = '';
      while (i < content.length && depth > 0) {
        const ch = content[i]!;
        if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) {
            // Check for closing ]) — the ] we just found plus )
            if (content[i + 1] === ')') {
              // body contains the union members
              // Recursively process the body so nested unions get cleaned first
              const processedBody = postProcessUndefinedUnions(body);
              // ts-to-zod always places z.undefined() as the last union member.
              // If that ever changes, this endsWith check will need to scan all members.
              if (processedBody.endsWith(', z.undefined()')) {
                const inner = processedBody.slice(0, -', z.undefined()'.length);
                // Check if there's only one remaining member (no top-level comma)
                // by scanning for commas at depth 0
                let commaCount = 0;
                let d = 0;
                for (const c of inner) {
                  if (c === '(' || c === '[' || c === '{') d++;
                  else if (c === ')' || c === ']' || c === '}') d--;
                  else if (c === ',' && d === 0) commaCount++;
                }
                if (commaCount === 0) {
                  // Two-member union: unwrap to just the first member
                  result += inner;
                } else {
                  // Multi-member union: keep union without z.undefined()
                  result += MARKER + inner + '])';
                }
                i += 2; // skip ])
                break;
              }
            }
            // Not our pattern — emit with recursively processed body
            result += MARKER + postProcessUndefinedUnions(body) + ']';
            i++; // skip ]
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
 * Post-process generated Zod schemas to strip .and(z.record(...)) intersections
 * from object schemas that already have .passthrough().
 *
 * ts-to-zod generates these for TypeScript types with index signatures like
 * `{ field: string } & { [k: string]: unknown }`. Since .passthrough() already
 * preserves unknown keys, the .and(z.record(...)) is redundant and creates
 * ZodIntersection types that lose .shape access (needed by MCP SDK for tool registration).
 *
 * Also handles z.record(...).and(z.object({...})) patterns (record-first intersections)
 * by extracting just the z.object() portion.
 */
function postProcessRecordIntersections(content: string): string {
  let result = content;

  // Pass 1: Strip `.and(z.record(z.string(), z.unknown()))` — redundant with .passthrough()
  result = result.replace(/\.and\(z\.record\(z\.string\(\), z\.unknown\(\)\)\)/g, '');

  // Pass 2: Replace `z.record(...).and(CONTENT)` with CONTENT (only for redundant records)
  result = unwrapRecordIntersections(result);

  // Pass 3: Strip `.and(z.union([...]))` where content contains z.never()
  result = stripNeverUnionIntersections(result);

  return result;
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
          const quote = content[i];
          i++;
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
            const quote = content[i];
            andContent += content[i];
            i++;
            while (i < content.length && content[i] !== quote) {
              if (content[i] === '\\') {
                andContent += content[i];
                i++;
              }
              andContent += content[i];
              i++;
            }
            if (i < content.length) {
              andContent += content[i];
              i++;
            }
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
          const quote = content[i];
          andContent += content[i];
          i++;
          while (i < content.length && content[i] !== quote) {
            if (content[i] === '\\') {
              andContent += content[i];
              i++;
            }
            andContent += content[i];
            i++;
          }
          if (i < content.length) {
            andContent += content[i];
            i++;
          }
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
    // Note: we intentionally keep .optional() (NOT .nullish()) so Zod schemas match
    // TypeScript types. Callers that need to accept null from external APIs should use
    // .nullish() at the call site, not globally in every schema.

    // Post-process: Fix broken imports from "undefined" (recursive types with z.lazy())
    zodSchemas = postProcessUndefinedImports(zodSchemas);

    // Post-process: Convert tuple patterns to arrays to allow empty arrays
    // ts-to-zod converts @minItems 1 to z.tuple([]).rest() which requires at least one element,
    // but agents in the wild return empty arrays. This relaxes validation for interoperability.
    zodSchemas = postProcessTuplesToArrays(zodSchemas);

    // Post-process: Replace z.union([z.unknown(), z.undefined()]) with z.unknown().
    // ts-to-zod generates the union for Record<string, unknown> types, but z.undefined()
    // has no JSON Schema representation, breaking MCP SDK's toJSONSchema() conversion.
    zodSchemas = postProcessUndefinedUnions(zodSchemas);

    // Post-process: Strip .and(z.record(z.string(), z.unknown())) from object schemas.
    // These intersections come from TypeScript index signatures and are redundant with
    // .passthrough(). They also create ZodIntersection types that lose .shape access.
    // Must run after postProcessUndefinedUnions (which normalizes the record value type).
    zodSchemas = postProcessRecordIntersections(zodSchemas);

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

    // Post-process: Add explicit z.ZodType annotations to schemas that trip TS7056.
    zodSchemas = postProcessTS7056Annotations(zodSchemas);

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
