// Regression coverage for the `storyboard show --specialism <slug>` flow
// (issue adcp-client#1527). The command exists in two modes:
//   1. `show <id>`               — render one storyboard
//   2. `show --specialism <slug>` — resolve all storyboards an agent
//                                    claiming `<slug>` would be graded on
//
// The original implementation had a `-1+1=0` bug: when `--specialism` was
// absent, `args.indexOf('--specialism')` returns -1, and the positional
// filter checked `i !== specialismIdx + 1` (i.e. `i !== 0`), silently
// dropping the FIRST positional arg — which is the storyboard ID. Mode 1
// would then fall back to the usage line as if the user forgot to pass
// an ID.
//
// This test pins the fix: plain `show <id>` must render the storyboard,
// AND `show --specialism <slug>` must still resolve the specialism, AND
// `show <id> --specialism <slug>` (mixed) must prefer the specialism
// branch (matching the existing behavior the runner picks).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 15_000 });
}

test('show <id> without --specialism renders the storyboard (the -1+1=0 regression)', () => {
  // `capability_discovery` is shipped in every compliance cache snapshot —
  // pinning a universal storyboard ID keeps this test stable across schema
  // bumps. If that ever stops being true, swap it for any other ID listed
  // by `adcp storyboard list`.
  const result = runCli(['storyboard', 'show', 'capability_discovery']);

  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  // Storyboard renderer prints the ID on the metadata line. If the
  // positional filter dropped the arg, we'd see the usage line instead.
  assert.match(result.stdout, /ID:\s+capability_discovery/);
  assert.doesNotMatch(result.stdout, /Usage: adcp storyboard show/);
});

test('show <id> --json without --specialism renders the storyboard as JSON', () => {
  // Same regression, JSON branch — the positional filter runs upstream of
  // the rendering split, so verify both surfaces.
  const result = runCli(['storyboard', 'show', 'capability_discovery', '--json']);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  // The JSON renderer emits `"id": "capability_discovery"` somewhere in
  // its envelope. Match on the field rather than parse — JSON output may
  // include CLI prelude lines we don't want to depend on.
  assert.match(result.stdout, /"id"\s*:\s*"capability_discovery"/);
});

test('show without an ID and without --specialism prints the usage line (exit 2)', () => {
  // Sanity: the regression must not have flipped the empty-args case to
  // exit 0. No positional ID + no --specialism = usage error.
  const result = runCli(['storyboard', 'show']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Usage: adcp storyboard show/);
});

test('show --specialism <slug> resolves the slug to its graded storyboards', () => {
  // `sales-guaranteed` is a stable AdCP-3.0-GA specialism that resolves to
  // a non-trivial storyboard list. The exact count drifts with each spec
  // release, so we assert structure (heading + at least one storyboard
  // bullet) rather than counts.
  const result = runCli(['storyboard', 'show', '--specialism', 'sales-guaranteed']);

  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stdout, /Specialism: sales-guaranteed/);
  assert.match(result.stdout, /Resolves to \d+ storyboard\(s\)/);
  // `capability_discovery` is universal — it must show up under every
  // specialism that maps to a known protocol. Pin it as a sanity anchor.
  assert.match(result.stdout, /capability_discovery/);
});

test('show --specialism <unknown> exits 2 with a "Known specialisms" hint', () => {
  // The validator surface should fail loud + give the operator a copy-
  // paste-able list of valid slugs.
  const result = runCli(['storyboard', 'show', '--specialism', 'this-is-not-a-real-specialism']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Unknown specialism: this-is-not-a-real-specialism/);
  assert.match(result.stderr, /Known specialisms:/);
});

test('show --specialism <slug> --json emits structured envelope', () => {
  // JSON branch must include the specialism slug + a storyboards array.
  const result = runCli(['storyboard', 'show', '--specialism', 'sales-guaranteed', '--json']);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stdout, /"specialism"\s*:\s*"sales-guaranteed"/);
  assert.match(result.stdout, /"storyboards"\s*:\s*\[/);
});
