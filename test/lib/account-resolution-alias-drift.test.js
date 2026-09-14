// #1647 — `AccountStore.resolution` has exactly one spelling per mode.
//
// The PR that corrected `'derived'` prototyped `'upstream-managed'` as a
// spec-aligned alias and then removed it: `resolution` is SDK-local config,
// never a wire value, so a second spelling buys nothing on the wire while
// silently defeating adopter code written as `resolution === 'derived'` and
// inviting divergence from the Python SDK. `'account-id-namespace'` was
// rejected separately — it doesn't discriminate `'explicit'` from
// `'derived'`.
//
// That decision is easy to un-make by accident: a doc sentence saying an
// alias is "accepted" costs nothing to write and is wrong the moment it
// lands, because the union has no such member. This test pins the union and
// the prose to each other.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const REJECTED_SPELLINGS = ['upstream-managed', 'account-id-namespace'];

// Docs and source that describe the mode to adopters. `decisioning.type-checks.ts`
// is exempt: it names the rejected spellings under `@ts-expect-error`, which is
// exactly the assertion we want to keep.
const SEARCH_ROOTS = ['docs', 'skills', 'src/lib', 'examples'];
const EXEMPT = new Set(['src/lib/server/decisioning/decisioning.type-checks.ts', 'test']);
const TEXT_EXTENSIONS = ['.md', '.txt', '.ts', '.js', '.mjs'];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (EXEMPT.has(full)) continue;
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'cache') continue;
      yield* walk(full);
      continue;
    }
    if (TEXT_EXTENSIONS.some(ext => entry.endsWith(ext))) yield full;
  }
}

test("AccountResolutionMode declares 'explicit' | 'implicit' | 'derived' and nothing else", () => {
  const source = readFileSync('src/lib/server/decisioning/account.ts', 'utf8');
  const declaration = /export type AccountResolutionMode = ([^;]+);/.exec(source);
  assert.ok(declaration, 'AccountResolutionMode must be declared in account.ts');
  const members = declaration[1]
    .split('|')
    .map(part => part.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
    .sort();
  assert.deepEqual(members, ['derived', 'explicit', 'implicit']);
});

test('no doc or source file claims a rejected resolution spelling is accepted', () => {
  // A quoted rejected spelling is fine when the surrounding paragraph says
  // it is rejected — that's the decision record. It is NOT fine in a
  // paragraph that reads as an acceptance claim ("accepted as", "alias for",
  // "behaves identically"), which is the drift this pins down.
  const NEGATION =
    /\bnot an alias\b|\brejected\b|\bno alias\b|\bsingle (?:spelling|name)\b|one spelling|deliberately|ts-expect-error|wouldn't|would not|PlatformConfigError/i;
  const offenders = [];
  for (const root of SEARCH_ROOTS) {
    for (const file of walk(root)) {
      const contents = readFileSync(file, 'utf8');
      for (const paragraph of contents.split(/\n\s*\n/)) {
        const quotes = REJECTED_SPELLINGS.filter(
          spelling => paragraph.includes(`'${spelling}'`) || paragraph.includes(`"${spelling}"`)
        );
        if (quotes.length === 0) continue;
        if (NEGATION.test(paragraph)) continue;
        offenders.push(`${file}: ${quotes.join(', ')}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `resolution has one spelling per mode; these passages read as accepting a rejected alias:\n  ${offenders.join('\n  ')}`
  );
});
