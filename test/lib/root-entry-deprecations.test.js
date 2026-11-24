// The root entry (`@adcp/sdk`, `@adcp/sdk/client`) re-exports a lot of
// `./server` and `./testing` surface for backward compatibility (#3664). Each
// of those specifiers must stay tagged `@deprecated` pointing at the dedicated
// subpath, so IDEs steer adopters off the root before 18.0 removes them.
//
// Source guard: parses src/lib/index.ts, no build needed.
// Built-output guard: the tags must survive declaration emit (.d.ts and .d.mts).

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_SOURCE = path.join(ROOT, 'src', 'lib', 'index.ts');
const DIST_DTS = path.join(ROOT, 'dist', 'lib', 'index.d.ts');
const DIST_DMTS = path.join(ROOT, 'dist', 'lib', 'index.d.mts');

// Module specifier (as written in index.ts) -> required replacement subpath.
function subpathFor(moduleText) {
  if (moduleText === './server' || moduleText.startsWith('./server/')) return '@adcp/sdk/server';
  if (moduleText === './testing' || moduleText.startsWith('./testing/')) return '@adcp/sdk/testing';
  return undefined;
}

// Matches the tag text regardless of which subpath it names. Aliased
// specifiers (`ListOptions as StateListOptions`) name the original symbol:
// "Import `ListOptions` from ...".
const TAG_RE = /@deprecated\s+Import (?:`[^`]+` )?from `(@adcp\/sdk\/(?:server|testing))`/;
const TAG_RE_GLOBAL = new RegExp(TAG_RE.source, 'g');

function leadingComments(text, node) {
  return (ts.getLeadingCommentRanges(text, node.pos) ?? []).map(r => text.slice(r.pos, r.end));
}

function analyzeIndex() {
  const text = fs.readFileSync(INDEX_SOURCE, 'utf8');
  const sf = ts.createSourceFile(INDEX_SOURCE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tagged = [];
  const problems = [];

  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    const moduleText =
      stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : undefined;
    const required = moduleText ? subpathFor(moduleText) : undefined;
    const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;

    if (required && !stmt.exportClause) {
      problems.push(`index.ts:${line}: \`export * from '${moduleText}'\` bypasses per-specifier deprecation tags`);
      continue;
    }
    if (required && ts.isNamespaceExport(stmt.exportClause)) {
      problems.push(`index.ts:${line}: \`export * as ns from '${moduleText}'\` cannot carry per-specifier tags`);
      continue;
    }
    if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;

    for (const spec of stmt.exportClause.elements) {
      const specLine = sf.getLineAndCharacterOfPosition(spec.getStart(sf)).line + 1;
      const name = spec.name.text;
      const comments = leadingComments(text, spec);
      const match = comments.map(c => c.match(TAG_RE)).find(Boolean);
      if (required) {
        if (!match) {
          problems.push(`index.ts:${specLine}: \`${name}\` from '${moduleText}' lacks @deprecated naming ${required}`);
        } else if (match[1] !== required) {
          problems.push(
            `index.ts:${specLine}: \`${name}\` from '${moduleText}' names ${match[1]}, expected ${required}`
          );
        } else {
          tagged.push(name);
        }
      } else if (match) {
        problems.push(
          `index.ts:${specLine}: \`${name}\` (from ${moduleText ?? 'local'}) carries a server/testing deprecation but is not re-exported from one`
        );
      }
    }
  }
  return { tagged, problems };
}

describe('root entry server/testing re-export deprecations (#3664)', () => {
  const { tagged, problems } = analyzeIndex();

  test('every server/testing re-export specifier is tagged @deprecated with the matching subpath', () => {
    assert.ok(tagged.length > 0, 'expected to find tagged server/testing re-exports in src/lib/index.ts');
    assert.deepStrictEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test('tagged specifiers have unique names (no accidental duplicate export)', () => {
    assert.strictEqual(new Set(tagged).size, tagged.length);
  });

  for (const [label, file] of [
    ['index.d.ts', DIST_DTS],
    ['index.d.mts', DIST_DMTS],
  ]) {
    test(`built ${label} keeps every deprecation tag`, () => {
      assert.ok(fs.existsSync(file), `${file} missing; run npm run build:lib`);
      const emitted = fs.readFileSync(file, 'utf8').match(TAG_RE_GLOBAL) ?? [];
      assert.strictEqual(
        emitted.length,
        tagged.length,
        `${label} has ${emitted.length} server/testing deprecation tags, source has ${tagged.length}`
      );
    });
  }
});
