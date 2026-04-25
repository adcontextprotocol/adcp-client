#!/usr/bin/env tsx

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Extract inline anonymous string-literal unions from named Zod schemas
 * and emit them as `${ParentSchemaName}_${PropertyPath}Values` const arrays.
 *
 * Companion to `generate-enum-arrays.ts` — that one extracts top-level
 * `export type Foo = 'a' | 'b'` declarations from `core.generated.ts` /
 * `tools.generated.ts`. This one extracts the inline anonymous unions
 * that don't have stable named types in the generated TypeScript:
 *
 *   formats?: ('jpg' | 'jpeg' | 'png' | 'gif' | 'webp' | ...)[];
 *
 * Adapters were re-declaring these literal sets locally as drift bait
 * (see adcp-client#932). With these exports, they import the
 * authoritative values directly:
 *
 *   import { ImageAssetRequirements_FormatsValues } from '@adcp/client/types';
 *   const formats = new Set<string>(ImageAssetRequirements_FormatsValues);
 *
 * Implementation note: walks the compiled Zod schemas via runtime
 * introspection (Zod 4 `_def`) rather than regex on the generated TS.
 * Cleaner and future-proofs against codegen output format changes —
 * the only failure mode is Zod itself renaming `_def`, which would
 * break the wider codebase first.
 */

// Read source `.ts` directly — tsx (this script's runtime) compiles
// it on the fly. Reading from `dist/lib/types/schemas.generated.js`
// would require a prior `build:lib`, which sequences before this
// script in the codegen chain (`generate-types` runs pre-build).
const SCHEMAS_SRC = path.join(__dirname, '../src/lib/types/schemas.generated.ts');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/types/inline-enums.generated.ts');

interface ExtractedInlineEnum {
  /** Export name we'll emit, e.g. `ImageAssetRequirements_FormatsValues`. */
  name: string;
  /** Origin: parent schema (without `Schema` suffix) and property name. */
  parentSchema: string;
  property: string;
  /** Whether the original union was wrapped in `z.array(...)`. Surfaces
   *  in the rendered comment so adapters know whether the spec
   *  position is "single value" or "array of values". */
  isArray: boolean;
  values: string[];
}

// Zod 4 internals — every schema instance carries `_def` with a
// `type` field that names the Zod kind. `unwrap` removes the
// `optional` / `nullable` / `nullish` / `default` / `readonly` /
// `catch` wrappers so the next descent (array element / union
// options) looks at the substantive shape.
//
// `pipe` is intentionally NOT in the set. `z.pipe(in, out)` chains
// transforms — the inner `in` schema may not match the wire shape
// after `out` runs, so unwrapping `pipe` and reading `in` would
// silently extract the wrong half for `string → enum` style
// transforms. The current `schemas.generated.ts` has zero
// `z.pipe(...)` constructions; if a future codegen change adds
// one, the extractor will bail at a non-`union` core (correct
// failure mode) rather than emit a wrong literal set, and the
// floor-of-90 guardrail catches the count collapse.
const UNWRAP_TYPES = new Set(['optional', 'nullable', 'nullish', 'default', 'readonly', 'catch']);

function getDef(schema: unknown): Record<string, unknown> | null {
  if (schema == null || typeof schema !== 'object') return null;
  const def = (schema as { _def?: unknown })._def;
  if (def == null || typeof def !== 'object') return null;
  return def as Record<string, unknown>;
}

function unwrap(schema: unknown): unknown {
  let cursor = schema;
  for (let i = 0; i < 20; i++) {
    const def = getDef(cursor);
    if (!def) return cursor;
    const type = def.type as string | undefined;
    if (!type || !UNWRAP_TYPES.has(type)) return cursor;
    const inner = def.innerType ?? def.in;
    if (inner == null) return cursor;
    cursor = inner;
  }
  // Bail if we somehow hit a depth limit — almost certainly a Zod
  // internal change. Fail loud rather than silently mishandling.
  throw new Error('unwrap: descended >20 levels without reaching a substantive type');
}

function extractStringLiteralUnion(schema: unknown): { values: string[]; isArray: boolean } | null {
  const core = unwrap(schema);
  const def = getDef(core);
  if (!def) return null;

  let unionCandidate: unknown = core;
  let isArray = false;
  if (def.type === 'array') {
    unionCandidate = unwrap(def.element);
    isArray = true;
  }

  const unionDef = getDef(unionCandidate);
  if (!unionDef || unionDef.type !== 'union') return null;
  const options = unionDef.options;
  if (!Array.isArray(options) || options.length === 0) return null;

  const literals: string[] = [];
  for (const opt of options) {
    const optCore = unwrap(opt);
    const optDef = getDef(optCore);
    if (!optDef || optDef.type !== 'literal') return null;
    // Zod 4 `z.literal('x')` stores values as an array (multi-literal
    // support); we accept any number of string members per option.
    const values = optDef.values;
    if (!Array.isArray(values)) return null;
    for (const v of values) {
      if (typeof v !== 'string') return null;
      literals.push(v);
    }
  }
  return literals.length > 0 ? { values: literals, isArray } : null;
}

interface NamedEnumGate {
  /** Identity-based set of named-enum schema instances. Cheap and exact
   *  when Zod re-uses the schema object on property access (the codegen
   *  default: `unit: DimensionUnitSchema.optional()` → the literal union
   *  inside `DimensionUnitSchema` is the same object reference both
   *  here and in the property's unwrap path). */
  byIdentity: Set<unknown>;
  /** Fingerprint-based fallback keyed by sorted-literal-tuple. Catches
   *  the case where Zod (or a future codegen change) clones a schema
   *  on property access — identity breaks but values match. Belt-and-
   *  suspenders against silent regressions to duplicate emission. */
  byFingerprint: Set<string>;
}

function fingerprintLiterals(values: string[]): string {
  // Sort to make order-insensitive; pipe-separator since literals
  // can't contain '|' in practice (none of the spec enums do).
  return [...values].sort().join('|');
}

function buildNamedEnumGate(allSchemas: Record<string, unknown>): NamedEnumGate {
  // Any named schema whose core is a string-literal union (or single
  // string literal) is already exported as a `${Name}Values` const by
  // `generate-enum-arrays.ts`. When an object property references one
  // of those by name (e.g. `unit: DimensionUnitSchema.optional()`),
  // we must NOT also emit `ImageAssetRequirements_UnitValues` — that
  // would duplicate authoritative values under a wrapped name and
  // create drift bait if a future spec change updates one but not
  // the other.
  //
  // The identity check is exact and fast in the common case; the
  // fingerprint check is the regression backstop for any future
  // codegen path that clones schemas.
  const byIdentity = new Set<unknown>();
  const byFingerprint = new Set<string>();
  for (const [name, schema] of Object.entries(allSchemas)) {
    if (!name.endsWith('Schema')) continue;
    const core = unwrap(schema);
    const def = getDef(core);
    if (!def) continue;
    if (def.type === 'union' || def.type === 'literal') {
      byIdentity.add(core);
      const extracted = extractStringLiteralUnion(schema);
      if (extracted) byFingerprint.add(fingerprintLiterals(extracted.values));
    }
  }
  return { byIdentity, byFingerprint };
}

function isNamedEnum(gate: NamedEnumGate, schema: unknown): boolean {
  if (gate.byIdentity.has(schema)) return true;
  const extracted = extractStringLiteralUnion(schema);
  if (!extracted) return false;
  return gate.byFingerprint.has(fingerprintLiterals(extracted.values));
}

function pascalCase(snake: string): string {
  return snake
    .split('_')
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function extractFromAllSchemas(): ExtractedInlineEnum[] {
  if (!existsSync(SCHEMAS_SRC)) {
    throw new Error(
      `generate-inline-enum-arrays: ${SCHEMAS_SRC} not found. ` +
        'Run `npm run generate-zod-schemas` (or `npm run generate-types` chain) first.'
    );
  }
  // tsx handles .ts compilation transparently in require().
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const allSchemas = require(SCHEMAS_SRC) as Record<string, unknown>;

  const namedEnumGate = buildNamedEnumGate(allSchemas);
  const result: ExtractedInlineEnum[] = [];

  for (const [exportName, schema] of Object.entries(allSchemas)) {
    if (!exportName.endsWith('Schema')) continue;
    const core = unwrap(schema);
    const def = getDef(core);
    if (!def || def.type !== 'object') continue;
    const shape = (core as { shape?: Record<string, unknown> }).shape;
    if (!shape || typeof shape !== 'object') continue;

    const parentName = exportName.replace(/Schema$/, '');

    for (const [propName, propSchema] of Object.entries(shape)) {
      // If the property's unwrapped core is itself a named enum
      // (referenced by symbol, e.g. `unit: DimensionUnitSchema...`),
      // skip — the named export already covers it. The gate checks
      // both object identity (the common case) and a literal-set
      // fingerprint (future-proof against codegen schema cloning).
      const propCore = unwrap(propSchema);
      if (isNamedEnum(namedEnumGate, propCore)) continue;
      // For arrays, also check if the element is a named enum.
      const propDef = getDef(propCore);
      if (propDef?.type === 'array') {
        const elementCore = unwrap(propDef.element);
        if (isNamedEnum(namedEnumGate, elementCore)) continue;
      }

      const extracted = extractStringLiteralUnion(propSchema);
      if (!extracted) continue;

      result.push({
        name: `${parentName}_${pascalCase(propName)}Values`,
        parentSchema: parentName,
        property: propName,
        isArray: extracted.isArray,
        values: extracted.values,
      });
    }
  }

  return result;
}

function renderOutput(items: ExtractedInlineEnum[]): string {
  // Stable sort: parent schema name, then property name. Keeps diff
  // noise minimal when the spec adds/removes single fields.
  const ordered = [...items].sort((a, b) => {
    if (a.parentSchema !== b.parentSchema) return a.parentSchema.localeCompare(b.parentSchema);
    return a.property.localeCompare(b.property);
  });

  const header = `// Generated inline-union value arrays for AdCP anonymous string-literal unions
// Sources: schemas.generated.ts (compiled Zod schemas, walked via runtime introspection)
//
// Every inline \`z.union([z.literal(...), ...])\` (or its array-wrapped form)
// inside a named object schema gets a corresponding
// \`export const \${ParentSchema}_\${PropertyName}Values = [...] as const\`
// here. Use these when you need to enumerate, filter, or validate against
// the spec's per-field literal sets without re-deriving from the parent
// schema — e.g.:
//
//   import { ImageAssetRequirements_FormatsValues } from '@adcp/client/types';
//   const formats = new Set<string>(ImageAssetRequirements_FormatsValues);
//   if (!formats.has(input)) throw new Error('unsupported image format');
//
// Property names referencing named enums (e.g. \`unit: DimensionUnitSchema\`)
// are intentionally skipped — use the matching \`\${TypeName}Values\` export
// from \`enums.generated.ts\` instead.

`;

  let body = '';
  let lastParent: string | null = null;
  for (const e of ordered) {
    if (e.parentSchema !== lastParent) {
      body += `\n// ====== ${e.parentSchema} ======\n\n`;
      lastParent = e.parentSchema;
    }
    const literals = e.values.map(v => JSON.stringify(v)).join(', ');
    const shapeNote = e.isArray ? 'array of' : 'single';
    body += `/** ${shapeNote} | ${e.parentSchema}.${e.property} */\n`;
    body += `export const ${e.name} = [${literals}] as const;\n`;
  }

  return header + body;
}

function writeFileIfChanged(filePath: string, newContent: string): boolean {
  if (existsSync(filePath)) {
    if (readFileSync(filePath, 'utf8') === newContent) return false;
  }
  writeFileSync(filePath, newContent);
  return true;
}

function main(): void {
  console.log('🔄 Generating inline-union value arrays...');

  const items = extractFromAllSchemas();

  // Guardrail: AdCP 3.0 GA produces ~104 inline string-literal unions
  // across asset-requirements (image/video/audio formats, codecs,
  // channels, frame-rate-types), account/billing schemas, catalog/
  // property helpers, and discriminated-error details. A floor of 90
  // catches partial regression — well below current 104 but high
  // enough that losing 10+ entries to a Zod-internal change or a
  // missed wrapper type fails fast. Bump whenever the spec adds a
  // significant wave of new inline enums.
  if (items.length < 90) {
    throw new Error(
      `generate-inline-enum-arrays: extracted only ${items.length} inline enums — expected at least 90. ` +
        'Either Zod 4 internal API changed (check `unwrap` and `_def` access) or the schema layout shifted.'
    );
  }

  const output = renderOutput(items);
  const changed = writeFileIfChanged(OUTPUT_FILE, output);

  if (changed) {
    console.log(`✅ Generated inline-union arrays: ${OUTPUT_FILE}`);
  } else {
    console.log(`✅ Inline-union arrays are up to date: ${OUTPUT_FILE}`);
  }
  console.log(`📊 Exported ${items.length} inline-union value arrays`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  }
}

export { main as generateInlineEnumArrays };
