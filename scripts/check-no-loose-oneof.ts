#!/usr/bin/env tsx
/**
 * Codegen strictness guard. Closes #1380.
 *
 * Walks generated `.d.ts` files (the bundled subset that ships in the npm
 * package) and fails the build if any union-derived type emits an arm
 * shaped exactly `{ [k: string]: unknown | undefined }` — the canonical
 * symptom of an `oneOf` branch with `required + not.required` clauses
 * collapsing under `json-schema-to-typescript` without per-arm `properties`.
 *
 * `tightenMutualExclusionOneOf` in `scripts/generate-types.ts` (#1325)
 * fixes this at codegen time by inlining parent `properties` into each
 * arm. This script is the regression guard: if a future spec change
 * adds a new `oneOf` with the same loose shape and the preprocessor
 * doesn't catch it, this check fires before the `.generated.ts` lands.
 *
 * What's flagged:
 *   - Union arms (`A | B | C`) where one arm is a bare type literal
 *     containing only `{ [k: string]: unknown | undefined }`.
 *
 * What's allowed:
 *   - Top-level type aliases that ARE the bare blob (e.g. `type
 *     ForecastRange = { [k: string]: unknown | undefined }`) — these
 *     model legitimate freeform spec fields.
 *   - Nested property types (`field?: { [k: string]: unknown | undefined }`)
 *     — same rationale, these are `additionalProperties: true` on a
 *     known field.
 *   - Intersection arms (`Typed & { [k: string]: unknown | undefined }`)
 *     — the typed object owns the shape; the index signature widens
 *     for `additionalProperties: true`.
 *
 * Allowlist mechanism: explicit set of fully-qualified type names below
 * for cases we've audited and accepted. Empty today; populate per-PR
 * with rationale if a legitimate union variant ever genuinely needs
 * the bare blob shape (we don't expect any — file an issue first).
 */

import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_FILES_TO_SCAN = ['src/lib/types/core.generated.ts', 'src/lib/types/tools.generated.ts'];

/**
 * `ADCP_LOOSE_ONEOF_FILES` (test hook): comma-separated list overriding
 * the files scanned. The regression test in
 * `test/check-no-loose-oneof.test.js` uses this to point the scanner at
 * a fixture file shaped like the bug pattern. Production callers (CI,
 * pre-push) leave it unset.
 */
const FILES_TO_SCAN = process.env.ADCP_LOOSE_ONEOF_FILES
  ? process.env.ADCP_LOOSE_ONEOF_FILES.split(',').filter(Boolean)
  : DEFAULT_FILES_TO_SCAN;

/**
 * Type names whose union variants are intentionally a bare blob.
 * Empty today. If you need to add an entry, file an issue first
 * explaining why the union arm cannot carry typed `properties` at
 * codegen time.
 */
const ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

interface Violation {
  file: string;
  line: number;
  typeName: string;
  variantIndex: number;
}

function isBareBlobLiteral(node: ts.TypeNode): boolean {
  if (!ts.isTypeLiteralNode(node)) return false;
  if (node.members.length !== 1) return false;
  const member = node.members[0];
  if (!ts.isIndexSignatureDeclaration(member)) return false;
  // `[k: string]: unknown | undefined` — the value type is a union of
  // `unknown` and `undefined`. Match exactly to avoid false positives on
  // typed index signatures (`[k: string]: ForecastRange | undefined`,
  // `[k: string]: boolean | undefined`).
  const valueType = member.type;
  if (!valueType || !ts.isUnionTypeNode(valueType)) return false;
  if (valueType.types.length !== 2) return false;
  const hasUnknown = valueType.types.some(t => t.kind === ts.SyntaxKind.UnknownKeyword);
  const hasUndefined = valueType.types.some(t => t.kind === ts.SyntaxKind.UndefinedKeyword);
  return hasUnknown && hasUndefined;
}

function checkAlias(stmt: ts.TypeAliasDeclaration, file: string, source: ts.SourceFile, violations: Violation[]): void {
  const typeName = stmt.name.text;
  if (ALLOWLIST.has(typeName)) return;
  const type = stmt.type;
  // Only flag union-arm violations. A bare blob as the entire alias
  // (e.g. `type ForecastRange = { [k: string]: unknown | undefined }`)
  // is the documented freeform-field pattern.
  if (!ts.isUnionTypeNode(type)) return;
  type.types.forEach((variant, idx) => {
    if (isBareBlobLiteral(variant)) {
      const { line } = source.getLineAndCharacterOfPosition(variant.getStart(source));
      violations.push({ file, line: line + 1, typeName, variantIndex: idx });
    }
  });
}

function checkInterface(
  stmt: ts.InterfaceDeclaration,
  file: string,
  source: ts.SourceFile,
  violations: Violation[]
): void {
  // Properties whose type is a union — same check.
  const typeName = stmt.name.text;
  if (ALLOWLIST.has(typeName)) return;
  for (const member of stmt.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    if (!ts.isUnionTypeNode(member.type)) continue;
    member.type.types.forEach((variant, idx) => {
      if (isBareBlobLiteral(variant)) {
        const { line } = source.getLineAndCharacterOfPosition(variant.getStart(source));
        const propName = ts.isIdentifier(member.name) ? member.name.text : '?';
        violations.push({
          file,
          line: line + 1,
          typeName: `${typeName}.${propName}`,
          variantIndex: idx,
        });
      }
    });
  }
}

function scanFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const text = fs.readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);

  source.forEachChild(stmt => {
    if (ts.isTypeAliasDeclaration(stmt)) {
      checkAlias(stmt, path.relative(process.cwd(), filePath), source, violations);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      checkInterface(stmt, path.relative(process.cwd(), filePath), source, violations);
    }
  });

  return violations;
}

function main(): void {
  const all: Violation[] = [];
  for (const f of FILES_TO_SCAN) {
    const abs = path.resolve(process.cwd(), f);
    if (!fs.existsSync(abs)) {
      console.error(`[check-no-loose-oneof] missing file: ${f}`);
      process.exit(2);
    }
    all.push(...scanFile(abs));
  }
  if (all.length === 0) {
    console.log('✅ No loose oneOf arms detected in generated types.');
    return;
  }
  console.error('❌ Loose oneOf arms detected — `tightenMutualExclusionOneOf` did not narrow these:');
  for (const v of all) {
    console.error(`   ${v.file}:${v.line}  ${v.typeName}  [variant ${v.variantIndex}]`);
  }
  console.error('');
  console.error('  These types resolve to `{ [k: string]: unknown | undefined }` as a union arm.');
  console.error('  Adopters consuming the union under `--strict --noUncheckedIndexedAccess` will see');
  console.error('  typed builders fail to satisfy the loose arm. See #1325 for the codegen tightening');
  console.error('  pattern; extend `tightenMutualExclusionOneOf` to cover this case, or file an issue');
  console.error('  before adding the type name to the ALLOWLIST in this script.');
  process.exit(1);
}

main();
