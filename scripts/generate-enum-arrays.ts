#!/usr/bin/env tsx

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Generate const-array enum exports from the named string-literal unions
 * in `core.generated.ts` and `tools.generated.ts`.
 *
 * For every `export type Name = 'a' | 'b' | 'c';` (single-line or multi-line),
 * emit `export const NameValues = ['a', 'b', 'c'] as const;` so adapters can
 * import authoritative enum values without re-deriving them from Zod schemas
 * or duplicating the literal list in their own validation code.
 *
 * Inline anonymous unions inside interfaces (e.g., image asset
 * `formats?: ('jpg' | ...)[]`) are not exported here — they don't have a
 * stable name in the generated TypeScript.
 */

const CORE_SOURCE_FILE = path.join(__dirname, '../src/lib/types/core.generated.ts');
const TOOLS_SOURCE_FILE = path.join(__dirname, '../src/lib/types/tools.generated.ts');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/types/enums.generated.ts');

interface ExtractedEnum {
  name: string;
  values: string[];
  source: 'core' | 'tools';
}

/**
 * Match every `export type Name = <body>;` declaration in the given source.
 * The body is captured non-greedily up to the first `;` at end of line.
 *
 * The non-greedy match can land inside an object/interface literal (e.g.,
 * `export type Foo = { bar: string; ... };` would match at `bar: string;`),
 * but `parseStringLiteralUnion` rejects bodies that aren't pure literal
 * unions, so the false match is silently skipped. The regex's `m` flag
 * means subsequent `^export type` matches still anchor on real declaration
 * starts at line beginnings.
 */
const DECL_REGEX = /^export type ([A-Z][A-Za-z0-9_]*) =\s*([\s\S]*?);$/gm;

function parseStringLiteralUnion(body: string): string[] | null {
  const cleaned = body.trim().replace(/^\|\s*/, '');
  const tokens = cleaned
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (tokens.length === 0) return null;
  const literals: string[] = [];
  for (const tok of tokens) {
    const m = /^'([^']*)'$/.exec(tok);
    if (!m) return null;
    literals.push(m[1]);
  }
  return literals;
}

function extractFromSource(source: string, label: 'core' | 'tools'): ExtractedEnum[] {
  const result: ExtractedEnum[] = [];
  let m: RegExpExecArray | null;
  DECL_REGEX.lastIndex = 0;
  while ((m = DECL_REGEX.exec(source)) !== null) {
    const name = m[1];
    const body = m[2];
    const values = parseStringLiteralUnion(body);
    if (values) result.push({ name, values, source: label });
  }
  return result;
}

function renderOutput(enums: ExtractedEnum[]): string {
  // Intentionally no `// Generated at:` timestamp in the file body. Other
  // generated files in this repo carry one, but those predate this script
  // and pay diff noise on every regeneration. Git log + the
  // `.generated.ts` suffix are sufficient signal that this file is
  // tool-output. If we ever need a "last regenerated" stamp, add it as a
  // separate workflow comment that the codegen rewrites independently.
  const header = `// Generated const-array enum exports for AdCP string-literal unions
// Sources:
//   - core.generated.ts (core types)
//   - tools.generated.ts (tool types)
//
// Every \`export type Name = 'a' | 'b' | 'c'\` in the generated TypeScript
// has a corresponding \`export const NameValues = ['a', 'b', 'c'] as const\`
// here. Use these when you need to enumerate, filter, or validate against
// the spec's literal sets — e.g.:
//
//   import { MediaChannelValues } from '@adcp/sdk/types';
//   const channels = new Set<string>(MediaChannelValues);
//   if (!channels.has(input)) throw new Error('unknown channel');

`;

  // Sort: core first, then tools; then alphabetical by name within each.
  const ordered = [...enums].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'core' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  let body = '';
  let lastSource: 'core' | 'tools' | null = null;
  for (const e of ordered) {
    if (e.source !== lastSource) {
      body += `// ====== ${e.source.toUpperCase()} ENUMS ======\n\n`;
      lastSource = e.source;
    }
    // JSON.stringify produces a TS-valid double-quoted string literal with
    // every special char (backslash, quote, control chars, surrogates)
    // escaped correctly. Using a hand-rolled `'...'` template with a
    // single-quote replace is incomplete — it doesn't escape backslashes,
    // so a value like `it\'s` would render as `'it\\'s'` which is two
    // tokens. Spec enums today are all simple alphanumerics so the bug
    // never fires, but JSON.stringify is the boring correct choice and
    // future-proofs against any spec value that ever contains punctuation.
    const literals = e.values.map(v => JSON.stringify(v)).join(', ');
    body += `export const ${e.name}Values = [${literals}] as const;\n`;
  }

  return header + body;
}

function writeFileIfChanged(filePath: string, newContent: string): boolean {
  // No timestamp in the rendered output, so byte-equality is the right
  // check. Skipping the write avoids spurious mtime churn that other
  // build steps key off.
  if (existsSync(filePath)) {
    if (readFileSync(filePath, 'utf8') === newContent) return false;
  }
  writeFileSync(filePath, newContent);
  return true;
}

function main(): void {
  console.log('🔄 Generating const-array enum exports...');

  if (!existsSync(CORE_SOURCE_FILE) || !existsSync(TOOLS_SOURCE_FILE)) {
    console.error('❌ Source files missing — run `npm run generate-types` first.');
    process.exit(1);
  }

  const core = readFileSync(CORE_SOURCE_FILE, 'utf8');
  const tools = readFileSync(TOOLS_SOURCE_FILE, 'utf8');

  // Dedupe by name. json-schema-to-typescript re-emits core enums in
  // tools.generated.ts when tool schemas reference them — same name, same
  // values. Keep the first occurrence (core wins) and assert that
  // subsequent declarations carry identical literals; mismatched values
  // would mean two different enums shipped under the same name, which we
  // refuse to silently merge.
  const seen = new Map<string, ExtractedEnum>();
  for (const e of [...extractFromSource(core, 'core'), ...extractFromSource(tools, 'tools')]) {
    const prior = seen.get(e.name);
    if (!prior) {
      seen.set(e.name, e);
      continue;
    }
    const same = prior.values.length === e.values.length && prior.values.every((v, i) => v === e.values[i]);
    if (!same) {
      throw new Error(
        `generate-enum-arrays: enum "${e.name}" has divergent values across sources. ` +
          `core/tools must agree. Got [${prior.values.join(', ')}] vs [${e.values.join(', ')}].`
      );
    }
  }
  const enums = [...seen.values()];

  // Guardrail: AdCP 3.0 GA produces ~120 named string-literal enums via
  // the codegen pipeline. A floor of 100 catches partial drift (e.g., the
  // regex stops matching multi-line declarations and we slip from 122 to
  // 80) instead of only catching catastrophic regex failure. Bump the
  // floor whenever the spec adds a wave of new enums.
  if (enums.length < 100) {
    throw new Error(
      `generate-enum-arrays: extracted only ${enums.length} enums — expected at least 100. ` +
        'The DECL_REGEX or generated TypeScript layout may have changed.'
    );
  }

  const output = renderOutput(enums);
  const changed = writeFileIfChanged(OUTPUT_FILE, output);

  if (changed) {
    console.log(`✅ Generated enum arrays: ${OUTPUT_FILE}`);
  } else {
    console.log(`✅ Enum arrays are up to date: ${OUTPUT_FILE}`);
  }
  console.log(`📊 Exported ${enums.length} enum arrays`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  }
}

export { main as generateEnumArrays };
