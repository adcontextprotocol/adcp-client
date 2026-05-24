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
/**
 * Schemas that hit TS7056. Each entry maps the schema name to the typed
 * surface its `z.ZodType<TS>` annotation should carry — without the typed
 * parameter, callers that destructure `params` get `unknown`, breaking
 * downstream inference.
 *
 * Existing entries (`AdCPAsyncResponseDataSchema`, `MCPWebhookPayloadSchema`)
 * use bare `z.ZodType` because they're validation-only — adopters consume
 * the output through `.parse()`'s type-narrowing, not inference. Newer
 * entries from the 3.1.0-beta.2 pin flip carry a TS type because internal
 * call sites destructure their output.
 */
/**
 * Schemas that hit TS7056. Entries can carry an optional `tsType` (the
 * Output/Input TS type for `z.ZodType<T, T>`) and an optional `objectShape`
 * flag — when true, the schema is annotated as `z.ZodObject<...>` instead
 * of `z.ZodType<...>` so call sites that need ZodObject methods (like
 * `withOptionalAccount(...)` which constrains to `z.ZodObject<any>`)
 * keep working.
 */
const TS7056_SCHEMAS: Array<{ name: string; tsType?: string; objectShape?: boolean }> = [
  { name: 'AdCPAsyncResponseDataSchema' },
  { name: 'MCPWebhookPayloadSchema' },
  // 3.1.0-beta.2 pin flip — `.and(z.union([...]))` compound patterns push
  // inferred types past TS7056's .d.ts serialization limit. Carry the TS
  // type so callers' `params` keep narrowing.
  { name: 'PreviewCreativeRequestSchema', tsType: 'PreviewCreativeRequest' },
  { name: 'UpdateMediaBuyRequestSchema', tsType: 'UpdateMediaBuyRequest' },
  { name: 'UpdateMediaBuyResponseSchema', tsType: 'UpdateMediaBuyResponse' },
  { name: 'BuildCreativeResponseSchema', tsType: 'BuildCreativeResponse' },
  { name: 'SyncEventSourcesResponseSchema', tsType: 'SyncEventSourcesResponse' },
];

function postProcessTS7056Annotations(content: string): string {
  let result = content;
  const typesToImport: string[] = [];
  for (const { name, tsType, objectShape } of TS7056_SCHEMAS) {
    const pattern = new RegExp(`export const ${name} = `);
    if (!pattern.test(result)) {
      throw new Error(
        `postProcessTS7056Annotations: expected to find "export const ${name} = " in generated output. ` +
          'The schema may have been renamed or removed — update TS7056_SCHEMAS.'
      );
    }
    // Object-shaped schemas (pure `z.object({...}).passthrough()`) are
    // annotated `z.ZodObject<any>` so call sites that constrain to
    // ZodObject (e.g. `withOptionalAccount<T extends z.ZodObject<any>>`)
    // keep working. The `any` shape parameter erases inner-field inference
    // — that's the trade-off TS7056 forces on us, and it's what these call
    // sites already accept for the in-bound `z.ZodObject<any>` constraint.
    //
    // Intersection-shaped schemas (`z.object().passthrough().and(z.union(...))`)
    // use the 2-type-param `z.ZodType<Output, Input>` form. `z.input<typeof X>`
    // resolves to the right shape, and `& Record<string, unknown>` reflects
    // the runtime passthrough so callers expecting `Record<string, unknown>`
    // keep their narrowing.
    let annotation: string;
    if (objectShape) {
      annotation = 'z.ZodObject<any>';
    } else if (tsType) {
      const widened = `${tsType} & Record<string, unknown>`;
      annotation = `z.ZodType<${widened}, ${widened}>`;
      typesToImport.push(tsType);
    } else {
      annotation = 'z.ZodType';
    }
    result = result.replace(pattern, `export const ${name}: ${annotation} = `);
  }
  // Inject `import type { ... } from './tools.generated'` for the typed-zod
  // entries. The compound schemas reference response types defined there.
  if (typesToImport.length > 0) {
    const importStatement = `import type { ${typesToImport.join(', ')} } from './tools.generated';\n`;
    result = result.replace(/import { z } from "zod";\n/, `import { z } from "zod";\n${importStatement}`);
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

type ObjectShape = Map<string, string>;

function normalizeSchemaExpression(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function skipQuotedOrRegexLiteral(content: string, start: number): number | undefined {
  const ch = content[start];
  if (ch === '"' || ch === "'" || ch === '`') {
    const quote = ch;
    let i = start + 1;
    while (i < content.length) {
      if (content[i] === '\\') {
        i += 2;
        continue;
      }
      if (content[i] === quote) return i + 1;
      i++;
    }
    return content.length;
  }

  if (ch !== '/') return undefined;

  let previous = start - 1;
  while (previous >= 0 && /\s/.test(content[previous])) previous--;
  if (previous >= 0 && !'([{,:='.includes(content[previous])) return undefined;

  let i = start + 1;
  let inCharacterClass = false;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === '[') inCharacterClass = true;
    else if (content[i] === ']') inCharacterClass = false;
    else if (content[i] === '/' && !inCharacterClass) {
      i++;
      while (i < content.length && /[a-z]/i.test(content[i])) i++;
      return i;
    }
    i++;
  }

  return undefined;
}

function scanBalanced(
  content: string,
  start: number,
  openChar: '(' | '{' | '[' = '(',
  closeChar: ')' | '}' | ']' = ')'
): { body: string; end: number } | undefined {
  if (content[start] !== openChar) return undefined;

  let depth = 1;
  let i = start + 1;
  let body = '';

  while (i < content.length && depth > 0) {
    const ch = content[i];
    const literalEnd = skipQuotedOrRegexLiteral(content, i);
    if (literalEnd !== undefined) {
      body += content.slice(i, literalEnd);
      i = literalEnd;
      continue;
    }

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }

    if (depth > 0) body += ch;
    i++;
  }

  return depth === 0 ? { body, end: i } : undefined;
}

function extractObjectLiteralBody(zObjectExpression: string): string | undefined {
  const trimmed = zObjectExpression.trim();
  if (!trimmed.startsWith('z.object(')) return undefined;

  const call = scanBalanced(trimmed, 'z.object'.length);
  if (!call) return undefined;

  if (!isPlainZodObjectTail(trimmed.slice(call.end))) return undefined;

  const arg = call.body.trim();
  if (!arg.startsWith('{')) return undefined;

  const objectLiteral = scanBalanced(arg, 0, '{', '}');
  return objectLiteral?.body;
}

function isPlainZodObjectTail(tail: string): boolean {
  let remaining = tail.trim();
  const objectPreservingMethods = ['.passthrough()', '.strict()', '.strip()'];

  while (remaining) {
    const method = objectPreservingMethods.find(value => remaining.startsWith(value));
    if (!method) return false;
    remaining = remaining.slice(method.length).trim();
  }

  return true;
}

function readPropertyKey(part: string): string | undefined {
  const trimmed = part.trim();
  if (!trimmed) return undefined;

  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0];
    let i = 1;
    let key = '';
    while (i < trimmed.length) {
      if (trimmed[i] === '\\') {
        key += trimmed[i];
        i++;
        if (i < trimmed.length) key += trimmed[i];
        i++;
        continue;
      }
      if (trimmed[i] === quote) break;
      key += trimmed[i];
      i++;
    }
    return key;
  }

  const match = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$-]*)\s*:/);
  return match?.[1];
}

function parseObjectShape(body: string): ObjectShape | undefined {
  const shape: ObjectShape = new Map();
  let depth = 0;
  let partStart = 0;

  const readPart = (end: number) => {
    const part = body.slice(partStart, end);
    const key = readPropertyKey(part);
    if (!key) return;

    let colonIndex = -1;
    let localDepth = 0;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      const literalEnd = skipQuotedOrRegexLiteral(part, i);
      if (literalEnd !== undefined) {
        i = literalEnd - 1;
        continue;
      }
      if (ch === '(' || ch === '{' || ch === '[') localDepth++;
      else if (ch === ')' || ch === '}' || ch === ']') localDepth--;
      else if (ch === ':' && localDepth === 0) {
        colonIndex = i;
        break;
      }
    }

    if (colonIndex >= 0) {
      shape.set(key, normalizeSchemaExpression(part.slice(colonIndex + 1)));
    }
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const literalEnd = skipQuotedOrRegexLiteral(body, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      readPart(i);
      partStart = i + 1;
    }
  }

  readPart(body.length);
  return shape;
}

function mergeShapes(left: ObjectShape, right: ObjectShape): ObjectShape {
  const merged = new Map(left);
  for (const [key, value] of right) {
    merged.set(key, value);
  }
  return merged;
}

function canSafelyMerge(left: ObjectShape, right: ObjectShape): boolean {
  for (const [key, rightValue] of right) {
    const leftValue = left.get(key);
    if (
      leftValue !== undefined &&
      leftValue !== rightValue &&
      leftValue !== `${rightValue}.optional()` &&
      leftValue !== `${rightValue}.nullish()`
    ) {
      return false;
    }
  }
  return true;
}

function extractSchemaExports(content: string): Map<string, string> {
  const schemas = new Map<string, string>();
  const exportRegex = /export const (\w+Schema)(?::[^=]+)? = /g;
  let match: RegExpExecArray | null;

  while ((match = exportRegex.exec(content))) {
    const name = match[1];
    const expressionStart = exportRegex.lastIndex;
    let depth = 0;
    let i = expressionStart;

    while (i < content.length) {
      const ch = content[i];
      const literalEnd = skipQuotedOrRegexLiteral(content, i);
      if (literalEnd !== undefined) {
        i = literalEnd - 1;
      } else if (ch === '(' || ch === '{' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
      } else if (ch === ';' && depth === 0) {
        schemas.set(name, content.slice(expressionStart, i));
        break;
      }
      i++;
    }

    exportRegex.lastIndex = i;
  }

  return schemas;
}

function schemaShapeForExpression(
  expression: string,
  schemaExpressions: Map<string, string>,
  cache: Map<string, ObjectShape | undefined>,
  visiting = new Set<string>()
): ObjectShape | undefined {
  const trimmed = expression.trim();

  const inlineBody = extractObjectLiteralBody(trimmed);
  if (inlineBody !== undefined) {
    return parseObjectShape(inlineBody);
  }

  const named = trimmed.match(/^(\w+Schema)$/)?.[1];
  if (named) {
    if (cache.has(named)) return cache.get(named);
    if (visiting.has(named)) return undefined;

    const namedExpression = schemaExpressions.get(named);
    if (!namedExpression) return undefined;

    visiting.add(named);
    const shape = schemaShapeForExpression(namedExpression, schemaExpressions, cache, visiting);
    visiting.delete(named);
    cache.set(named, shape);
    return shape;
  }

  return undefined;
}

function postProcessObjectIntersections(content: string): string {
  const schemaExpressions = extractSchemaExports(content);
  const shapeCache = new Map<string, ObjectShape | undefined>();
  const exportRegex = /export const (\w+Schema)(?::[^=]+)? = /g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = exportRegex.exec(content))) {
    const name = match[1];
    const expressionStart = exportRegex.lastIndex;
    const expression = schemaExpressions.get(name);
    if (!expression) continue;

    const expressionEnd = expressionStart + expression.length;
    const rewritten = rewriteTopLevelObjectAnds(expression, schemaExpressions, shapeCache);

    result += content.slice(lastIndex, expressionStart) + rewritten;
    lastIndex = expressionEnd;
    exportRegex.lastIndex = expressionEnd;
  }

  result += content.slice(lastIndex);

  let rewritten = result;
  while (true) {
    const next = rewriteNamedObjectAnds(rewritten);
    if (next === rewritten) return rewritten;
    rewritten = next;
  }
}

function rewriteTopLevelObjectAnds(
  expression: string,
  schemaExpressions: Map<string, string>,
  shapeCache: Map<string, ObjectShape | undefined>
): string {
  let result = '';
  let depth = 0;
  let i = 0;
  let currentShape: ObjectShape | undefined;
  let baseStart = 0;

  while (i < expression.length) {
    const ch = expression[i];
    const literalEnd = skipQuotedOrRegexLiteral(expression, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
    } else if (depth === 0 && expression.startsWith('.and(', i)) {
      if (!result) {
        const base = expression.slice(baseStart, i);
        result = base;
        currentShape = schemaShapeForExpression(base, schemaExpressions, shapeCache);
      }

      const arg = scanBalanced(expression, i + '.and'.length);
      if (!arg) break;

      const argShape = schemaShapeForExpression(arg.body, schemaExpressions, shapeCache);
      if (currentShape && argShape && canSafelyMerge(currentShape, argShape)) {
        result += `.merge(${arg.body})`;
        currentShape = mergeShapes(currentShape, argShape);
      } else {
        result += `.and(${arg.body})`;
        currentShape = undefined;
      }
      i = arg.end;
      baseStart = i;
      continue;
    }
    i++;
  }

  if (!result) return expression;
  result += expression.slice(baseStart);
  return result;
}

function rewriteNamedObjectAnds(content: string): string {
  const schemaExpressions = extractSchemaExports(content);
  const shapeCache = new Map<string, ObjectShape | undefined>();
  const namedAndRegex = /\b(\w+Schema)\.and\(/g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = namedAndRegex.exec(content))) {
    const schemaName = match[1];
    const openIndex = match.index + `${schemaName}.and`.length;
    const arg = scanBalanced(content, openIndex);
    if (!arg) continue;

    const leftShape = schemaShapeForExpression(schemaName, schemaExpressions, shapeCache);
    const rightShape = schemaShapeForExpression(arg.body, schemaExpressions, shapeCache);

    result += content.slice(lastIndex, match.index);
    if (leftShape && rightShape && canSafelyMerge(leftShape, rightShape)) {
      result += `${schemaName}.merge(${arg.body})`;
    } else {
      result += content.slice(match.index, arg.end);
    }

    lastIndex = arg.end;
    namedAndRegex.lastIndex = arg.end;
  }

  result += content.slice(lastIndex);
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

    // tools.generated.ts imports a handful of *AssetRequirements types from
    // core.generated.ts (injected by scripts/generate-types.ts so the standalone
    // file typechecks). Since we concatenate both sources for ts-to-zod, those
    // imports are redundant — worse, ts-to-zod treats imported names as external
    // and emits `z.any()` stubs even when the actual interfaces are present in
    // the combined source. Strip cross-file imports before merging.
    const toolsWithoutCrossImports = toolsContent.replace(
      /^import type \{[^}]*\} from ['"]\.\/core\.generated['"];?\n+/gm,
      ''
    );
    // Defensive: if the injector in scripts/generate-types.ts ever changes shape
    // (different specifier, single-line form, etc.), the strip would silently
    // no-op and we'd regress back to z.any() stubs. Fail loudly instead.
    if (toolsWithoutCrossImports.includes("from './core.generated'")) {
      throw new Error(
        "generate-zod-from-ts: cross-file `import type { ... } from './core.generated'` " +
          'survived the strip. Update the regex in this file or the injector in ' +
          'scripts/generate-types.ts — letting it through degrades the matching schemas to z.any().'
      );
    }

    // Merge both sources so cross-file type dependencies can be resolved
    const combinedSource = `${coreContent}\n\n// ====== TOOL TYPES ======\n\n${toolsWithoutCrossImports}`;

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

    // Post-process: Turn safe object/object intersections into ZodObject merges.
    // ts-to-zod emits `.and()` for TypeScript object intersections, but ZodIntersection
    // does not expose object helpers like .shape/.extend/.omit/.pick. This keeps the
    // intersected object validation when fields are disjoint or identical, and leaves
    // richer/conflicting intersections alone so future schema changes do not weaken checks.
    zodSchemas = postProcessObjectIntersections(zodSchemas);

    // Post-process: Replace z.union([z.unknown(), z.undefined()]) with z.unknown().
    // ts-to-zod generates this union for TypeScript's Record<string, unknown>, but
    // z.undefined() cannot be converted to JSON Schema (it has no representation).
    // z.unknown() already accepts undefined at runtime, so this is semantically identical.
    // Without this fix, 73+ schemas fail MCP SDK's tools/list JSON Schema conversion.
    zodSchemas = postProcessUndefinedUnions(zodSchemas);

    // Post-process: Add explicit z.ZodType annotations to schemas that trip TS7056.
    zodSchemas = postProcessTS7056Annotations(zodSchemas);

    // Defensive: ts-to-zod emits `const FooSchema = z.any();` stubs when it
    // can't resolve a referenced type — usually because a cross-file `import
    // type` declaration leaks past the upstream strip (see #1659). A `z.any()`
    // stub silently accepts any shape at runtime and erases the per-type Zod
    // contract downstream consumers rely on. Fail the build so the regression
    // surfaces here, not in a consumer's test suite.
    const anyStubs = [...zodSchemas.matchAll(/^const (\w+Schema) = z\.any\(\);$/gm)].map(m => m[1]);
    if (anyStubs.length > 0) {
      throw new Error(
        `generate-zod-from-ts: ${anyStubs.length} schema(s) degenerated to z.any() stubs:\n` +
          anyStubs.map(n => `  - ${n}`).join('\n') +
          '\nThis usually means a cross-file `import type` declaration leaked past the strip ' +
          'in this script. Check that the referenced TypeScript interfaces are inlined in ' +
          'the combined source, and update the strip regex if a new cross-file import was added.'
      );
    }

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

export const __test__ = { postProcessObjectIntersections };

export { generateZodSchemas };
