/**
 * Drift guard: every numbered-suffix `Foo1` export in `core.generated.ts`
 * must either come from `applyKnownJstsAliases`'s alias rewrite (a one-liner
 * `export type Foo1 = Foo;`) or be a known false-positive of the
 * `^[A-Z][A-Za-z]+1\b` pattern.
 *
 * Why this exists: AdCP 3.0.4 brought `core/assets/asset-union.json` (adcp#3462)
 * but the spec bundler still inlines the union at both `creative-asset.json`
 * and `creative-manifest.json` call sites. `json-schema-to-typescript` sees
 * two identically-titled shapes and emits Foo/Foo1 — and on the second pass
 * it under-resolves the body, dropping the `asset_type` discriminator that
 * the first pass preserved. The post-process pass `applyKnownJstsAliases`
 * (scripts/generate-types.ts) rewrites each known `*Asset1` artifact as a
 * `@deprecated` alias to its base. The list is hardcoded — without this
 * drift guard, a future spec change introducing a 7th `*Asset1` artifact
 * would slip through silently and ship a strictly-weaker public type.
 *
 * Tracked: adcp-client#1264.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const CORE_GENERATED_PATH = path.join(__dirname, '../../src/lib/types/core.generated.ts');

describe('Codegen drift guard: numbered Foo1 exports must be aliased', () => {
  it('every Foo1 export in core.generated.ts is a one-liner alias to Foo', () => {
    const src = readFileSync(CORE_GENERATED_PATH, 'utf8');
    const lines = src.split('\n');

    // Match every `export type Foo1 = ...` or `export interface Foo1 { ... }`
    // where Foo1 ends in a digit. Capture the line number for diagnostics.
    const offenders = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^export (type|interface) ([A-Z][A-Za-z]+\d+)\b(.*)$/);
      if (!m) continue;
      const [, kind, name, rest] = m;
      // The acceptable shape is exactly: `export type FOO1 = BAR;` (single line, no body).
      // Anything else (multi-line union/intersection, interface block) means the alias
      // pass missed it.
      const isOneLineAlias = kind === 'type' && /^\s*=\s*[A-Z][A-Za-z0-9_]*\s*;\s*$/.test(rest);
      if (!isOneLineAlias) {
        offenders.push({ line: i + 1, name, snippet: line });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Found ${offenders.length} numbered-suffix export(s) in core.generated.ts that are not ` +
        `one-liner aliases. These are jsts under-resolution artifacts that need entries in ` +
        `JSTS_UNDER_RESOLUTION_ALIASES (scripts/generate-types.ts) so consumers get the ` +
        `correctly-discriminated shape:\n` +
        offenders.map(o => `  ${CORE_GENERATED_PATH}:${o.line}  ${o.snippet}`).join('\n')
    );
  });
});
