#!/usr/bin/env tsx

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Generate const-array enum exports from the named string-literal unions
 * in `core.generated.ts` and `tools.generated.ts`.
 *
 * For every `export type Name = 'a' | 'b' | 'c';` (single-line or multi-line),
 * emit `export const NameValues = ['a', 'b', 'c'] as const;` so adapters can
 * import authoritative enum values without re-deriving them from Zod schemas
 * or duplicating the literal list in their own validation code.
 * String-open unions retain an array of their finite literal members; such an
 * array is not an exhaustive validator for the union's additional strings.
 *
 * Inline anonymous unions inside interfaces (e.g., image asset
 * `formats?: ('jpg' | ...)[]`) are not exported here — they don't have a
 * stable name in the generated TypeScript.
 */

const CORE_SOURCE_FILE = path.join(__dirname, '../src/lib/types/core.generated.ts');
const TOOLS_SOURCE_FILE = path.join(__dirname, '../src/lib/types/tools.generated.ts');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/types/enums.generated.ts');
const ADCP_VERSION_FILE = path.join(__dirname, '../ADCP_VERSION');

const BACKWARD_COMPAT_ENUM_VALUE_ALIASES: Array<{
  oldName: string;
  newName: string;
  reason: string;
}> = [
  {
    oldName: 'SignalCatalogType',
    newName: 'SignalAvailabilityType',
    reason: 'AdCP 3.1 renamed SignalCatalogType to SignalAvailabilityType.',
  },
];

interface ExtractedEnum {
  name: string;
  values: string[];
  source: 'core' | 'tools';
}

function unwrapParentheses(node: ts.TypeNode): ts.TypeNode {
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  return node;
}

/** The unconstrained object marker jsts emits for a pattern-only schema. */
function isOpenObjectMarker(node: ts.TypeLiteralNode): boolean {
  if (node.members.length === 0) return true;
  if (node.members.length !== 1) return false;
  const member = node.members[0];
  if (!member || !ts.isIndexSignatureDeclaration(member) || member.parameters.length !== 1 || !member.type)
    return false;
  if (member.parameters[0]?.type?.kind !== ts.SyntaxKind.StringKeyword) return false;
  const value = unwrapParentheses(member.type);
  const branches = ts.isUnionTypeNode(value) ? value.types : [value];
  return (
    branches.some(branch => branch.kind === ts.SyntaxKind.UnknownKeyword) &&
    branches.every(
      branch => branch.kind === ts.SyntaxKind.UnknownKeyword || branch.kind === ts.SyntaxKind.UndefinedKeyword
    )
  );
}

/**
 * Keep explicit string literals while permitting open string branches. Using
 * the TypeScript AST handles jsts's nested parentheses, leading union bars,
 * and escaped literals without mistaking object properties for enum members.
 * Other mixed unions remain excluded.
 */
function stringLiteralMembers(node: ts.TypeNode, constrainedToString = false): string[] | null {
  node = unwrapParentheses(node);
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return [node.literal.text];
  if (node.kind === ts.SyntaxKind.StringKeyword || ts.isTemplateLiteralTypeNode(node)) return [];
  if (ts.isUnionTypeNode(node)) {
    const values: string[] = [];
    for (const branch of node.types) {
      const literals = stringLiteralMembers(branch, constrainedToString);
      if (literals === null) return null;
      values.push(...literals);
    }
    return values;
  }
  if (ts.isIntersectionTypeNode(node)) {
    // A string schema with enum + pattern can compile to
    // (("fixed" | ...) | { [k: string]: unknown }) & string. The normal
    // generator cleanup may reduce the open marker to {}. Only accept that
    // marker when the intersection explicitly constrains the result to string.
    const branches = node.types.map(unwrapParentheses);
    const remaining = branches.filter(branch => branch.kind !== ts.SyntaxKind.StringKeyword);
    if (remaining.length === 1 && remaining.length < branches.length) {
      return stringLiteralMembers(remaining[0]!, true);
    }
  }
  if (constrainedToString && ts.isTypeLiteralNode(node) && isOpenObjectMarker(node)) return [];
  return null;
}

export function extractFromSource(source: string, label: 'core' | 'tools'): ExtractedEnum[] {
  const result: ExtractedEnum[] = [];
  const file = ts.createSourceFile(`${label}.ts`, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.typeParameters?.length) continue;
    if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const name = statement.name.text;
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) continue;
    const values = stringLiteralMembers(statement.type);
    if (values?.length) result.push({ name, values, source: label });
  }
  return result;
}

interface RequestSigningErrorMetadata {
  recovery: 'transient' | 'correctable' | 'terminal';
  suggestion: string;
}

function loadRequestSigningErrorMetadata(): Record<string, RequestSigningErrorMetadata> {
  const version = readFileSync(ADCP_VERSION_FILE, 'utf8').trim();
  const schemaPath = path.join(__dirname, `../schemas/cache/${version}/enums/request-signing-error-code.json`);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    enum?: string[];
    enumMetadata?: Record<string, unknown>;
  };
  const metadata = schema.enumMetadata ?? {};
  return Object.fromEntries(
    (schema.enum ?? []).map(code => {
      const entry = metadata[code] as Partial<RequestSigningErrorMetadata> | undefined;
      if (
        !entry ||
        !['transient', 'correctable', 'terminal'].includes(entry.recovery ?? '') ||
        typeof entry.suggestion !== 'string'
      ) {
        throw new Error(`request-signing-error-code enumMetadata is missing recovery/suggestion for ${code}`);
      }
      return [code, { recovery: entry.recovery!, suggestion: entry.suggestion }];
    })
  );
}

function renderOutput(
  enums: ExtractedEnum[],
  requestSigningMetadata: Record<string, RequestSigningErrorMetadata>
): string {
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
// here. Arrays for unions with open string branches contain only the declared
// literals; use the corresponding schema to validate additional strings.
// Use these arrays to enumerate the spec's literal sets — e.g.:
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
    for (const alias of BACKWARD_COMPAT_ENUM_VALUE_ALIASES) {
      if (alias.newName !== e.name) continue;
      body += `/** @deprecated ${alias.reason} */\n`;
      body += `export const ${alias.oldName}Values = ${alias.newName}Values;\n`;
    }
  }

  body += `\n/** Normative recovery metadata from request-signing-error-code.json. */\n`;
  body += `const requestSigningErrorCodeMetadata = ${JSON.stringify(requestSigningMetadata, null, 2)} as const satisfies Record<(typeof RequestSigningErrorCodeValues)[number], { recovery: 'transient' | 'correctable' | 'terminal'; suggestion: string }>;\n`;
  body += `for (const metadata of Object.values(requestSigningErrorCodeMetadata)) Object.freeze(metadata);\n`;
  body += `export const RequestSigningErrorCodeMetadata = Object.freeze(requestSigningErrorCodeMetadata);\n`;

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
        'The enum extraction or generated TypeScript layout may have changed.'
    );
  }

  const output = renderOutput(enums, loadRequestSigningErrorMetadata());
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
