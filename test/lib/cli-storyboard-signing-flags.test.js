/**
 * `adcp storyboard run` request-signing flags (adcontextprotocol/adcp-client#2956).
 *
 * Fast half: argument semantics and output wording, asserted against the
 * shared `bin/adcp-storyboard-summary.js` seam plus one help-text spawn.
 * The end-to-end threading runs live in
 * `cli-storyboard-signing-threading.test.js` (slow group) so neither file
 * approaches the 60s per-file CI ceiling.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  parseRequestSigningFlags,
  formatStepSkipLines,
  formatStepVerdictLines,
} = require('../../bin/adcp-storyboard-summary.js');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

/** Drive the pure parser the CLI uses, from an argv array. */
function parseFlags(argv, knownVectorIds = null) {
  const readFlag = flag => {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
    const eq = argv.find(a => a.startsWith(`${flag}=`));
    return eq ? eq.slice(flag.length + 1) : null;
  };
  const hasFlag = flag => argv.includes(flag) || argv.some(a => a.startsWith(`${flag}=`));
  const readInlineValue = flag => {
    const eq = argv.find(a => a.startsWith(`${flag}=`));
    return eq ? eq.slice(flag.length + 1) : null;
  };
  return parseRequestSigningFlags(readFlag, hasFlag, { readInlineValue, knownVectorIds });
}

test('--signing-transport rejects an unknown value instead of silently falling back', () => {
  const parsed = parseFlags(['--signing-transport', 'a2a']);

  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.error, /--signing-transport must be one of raw\|mcp/);
});

test('--signing-transport accepts both framings, in either flag form', () => {
  assert.deepStrictEqual(parseFlags(['--signing-transport', 'raw']).options, {
    request_signing: { transport: 'raw' },
  });
  assert.deepStrictEqual(parseFlags(['--signing-transport=mcp']).options, {
    request_signing: { transport: 'mcp' },
  });
});

test('--signing-skip-vectors requires a value and parses the CSV', () => {
  assert.match(parseFlags(['--signing-skip-vectors']).error, /--signing-skip-vectors requires a value/);
  assert.match(parseFlags(['--signing-skip-vectors', ',,']).error, /at least one vector id/);
  assert.deepStrictEqual(parseFlags(['--signing-skip-vectors', 'a, b ,c']).options, {
    request_signing: { skipVectors: ['a', 'b', 'c'] },
  });
});

test('--signing-skip-rate-abuse is a boolean opt-out, and no flags means no options at all', () => {
  assert.deepStrictEqual(parseFlags(['--signing-skip-rate-abuse']).options, {
    request_signing: { skipRateAbuse: true },
  });
  assert.strictEqual(parseFlags([]).options, null, 'existing runs must be byte-identical without the flags');
});

test('--signing-skip-rate-abuse=false is rejected rather than read as "on"', () => {
  // The flag is presence-based, so `=false` used to skip the very vector the
  // operator was asking to run — the inverse of the request, silently.
  const inline = parseFlags(['--signing-skip-rate-abuse=false']);
  assert.strictEqual(inline.ok, false);
  assert.match(inline.error, /--signing-skip-rate-abuse takes no value \(got "false"\)/);
  assert.match(inline.error, /Pass the bare flag/);

  assert.strictEqual(parseFlags(['--signing-skip-rate-abuse', 'true']).ok, false, 'spaced boolean literal too');

  // A following positional is still a positional, not a rejected value.
  assert.deepStrictEqual(parseFlags(['--signing-skip-rate-abuse', 'signed_requests']).options, {
    request_signing: { skipRateAbuse: true },
  });
});

test('--signing-skip-vectors rejects an unknown id, with the nearest real ids', () => {
  // A mistyped id matches no vector, so the grader skips nothing and the
  // operator waits out the full run — including the cap+1 flood — to find
  // out.
  const known = ['001-no-signature-header', '007-missing-content-digest', '020-rate-abuse'];

  const typo = parseFlags(['--signing-skip-vectors', '007'], known);
  assert.strictEqual(typo.ok, false);
  assert.match(typo.error, /unknown vector id "007"/);
  assert.match(typo.error, /did you mean: 007-missing-content-digest\?/);

  const mixed = parseFlags(['--signing-skip-vectors', '020-rate-abuse,nope'], known);
  assert.strictEqual(mixed.ok, false);
  assert.match(mixed.error, /unknown vector id "nope"/);

  assert.deepStrictEqual(parseFlags(['--signing-skip-vectors', '020-rate-abuse'], known).options, {
    request_signing: { skipVectors: ['020-rate-abuse'] },
  });
  // No id list available (compliance cache unreadable) → no validation, and
  // the run is not blocked on a nicety.
  assert.strictEqual(parseFlags(['--signing-skip-vectors', '007']).ok, true);
});

test('the CLI surfaces a rejected flag as exit 2 with the usage message', () => {
  const result = spawnSync(process.execPath, [CLI, 'storyboard', 'run', 'test-mcp', '--signing-transport', 'a2a'], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /--signing-transport must be one of raw\|mcp/);
});

test('the CLI rejects a valued boolean flag and an unknown vector id at exit 2', () => {
  const valued = spawnSync(
    process.execPath,
    [CLI, 'storyboard', 'run', 'test-mcp', '--signing-skip-rate-abuse=false'],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.strictEqual(valued.status, 2, `expected exit 2, got ${valued.status}. stderr: ${valued.stderr}`);
  assert.match(valued.stderr, /--signing-skip-rate-abuse takes no value/);

  const unknownVector = spawnSync(
    process.execPath,
    [CLI, 'storyboard', 'run', 'test-mcp', 'signed_requests', '--signing-skip-vectors', 'no-such-vector'],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.strictEqual(
    unknownVector.status,
    2,
    `expected exit 2, got ${unknownVector.status}. stderr: ${unknownVector.stderr}`
  );
  assert.match(unknownVector.stderr, /unknown vector id "no-such-vector"/);
});

test('storyboard run --help documents the signing flags and their distinction from --transport', () => {
  const result = spawnSync(process.execPath, [CLI, 'storyboard', '--help'], { encoding: 'utf8', timeout: 30_000 });

  const help = `${result.stdout}${result.stderr}`;
  assert.match(help, /--signing-transport raw\|mcp/);
  assert.match(help, /--signing-skip-vectors IDS/);
  assert.match(help, /--signing-skip-rate-abuse/);
  assert.match(help, /NOT the same as\s+--transport\/--protocol/);
  assert.match(help, /signing_transport_unavailable/, 'help must use the reason the JSON and guides use');
});

test('a coverage gap renders as COVERAGE UNAVAILABLE with its remedy; an inapplicable step does not', () => {
  // The wording is the point: a run that prints `0 passed, N skipped` and
  // nothing else reads as a clean pass. The A2A vector gap canonicalizes to
  // `not_applicable` with the sub-reason token as `skip.detail` (the output
  // contract's registered shape), the human remedy rides on the probe
  // result, and the row still has to look different from an ordinary skip.

  const gap = formatStepSkipLines({
    skipped: true,
    skip_reason: 'signing_transport_unavailable',
    skip: { reason: 'not_applicable', detail: 'signing_transport_unavailable' },
    response: {
      status: 0,
      error: 'Coverage unavailable: … Remedy: grade the MCP binding, or set `--signing-transport`.',
    },
  });
  assert.deepStrictEqual(gap, [
    '   COVERAGE UNAVAILABLE (not_applicable / signing_transport_unavailable)',
    '   Coverage unavailable: … Remedy: grade the MCP binding, or set `--signing-transport`.',
  ]);

  const operatorSkip = formatStepSkipLines({
    skipped: true,
    skip_reason: 'operator_skip',
    skip: { reason: 'unsatisfied_contract', detail: 'Step was excluded by request_signing.skipVectors.' },
  });
  assert.strictEqual(operatorSkip[0], '   Skipped (unsatisfied_contract / operator_skip)');

  const notApplicable = formatStepSkipLines({
    skipped: true,
    skip_reason: 'not_applicable',
    skip: { reason: 'not_applicable', detail: 'Agent did not declare this specialism.' },
  });
  assert.strictEqual(notApplicable[0], '   Skipped (not_applicable)');

  assert.deepStrictEqual(formatStepSkipLines({ skipped: false, passed: true }), [], 'a graded step prints nothing');
  assert.deepStrictEqual(
    formatStepSkipLines(
      { skipped: true, skip_reason: 'capability_prerequisite_unavailable', skip: { reason: 'not_applicable' } },
      { handledReasons: new Set(['capability_prerequisite_unavailable']) }
    ),
    [],
    'reasons the caller already phrased are not printed twice'
  );

  const hostile = formatStepSkipLines({
    skipped: true,
    skip_reason: 'operator_skip',
    skip: { reason: 'unsatisfied_contract', detail: 'line\u001b[2Jcleared' },
  });
  assert.match(hostile[1], /line\\u001b\[2Jcleared/, 'agent-supplied text cannot rewrite the terminal');
});

test('a single-step run renders an unavailable step as not verified, never as Passed', () => {
  // `adcp storyboard step` prints one verdict line. A skipped step carries
  // `passed: true`, so the bare verdict rendered a coverage gap as a green
  // "Passed" (adcp-client#2954).
  const unavailable = formatStepVerdictLines(
    {
      skipped: true,
      passed: true,
      skip_reason: 'signing_transport_unavailable',
      skip: { reason: 'not_applicable', detail: 'signing_transport_unavailable' },
      response: { status: 0, error: 'Coverage unavailable: … Remedy: grade the MCP binding.' },
    },
    { durationMs: 12 }
  );

  assert.match(unavailable[0], /Not verified \(12ms\)/);
  assert.ok(
    unavailable.every(line => !line.includes('Passed')),
    `an ungraded step must not render as Passed: ${unavailable.join(' | ')}`
  );
  assert.match(unavailable[1], /COVERAGE UNAVAILABLE \(not_applicable \/ signing_transport_unavailable\)/);
  assert.match(unavailable[2], /Remedy/);

  const operatorSkip = formatStepVerdictLines(
    { skipped: true, passed: true, skip_reason: 'operator_skip', skip: { reason: 'unsatisfied_contract' } },
    { durationMs: 3 }
  );
  assert.match(operatorSkip[0], /Skipped \(3ms\)/);

  assert.deepStrictEqual(formatStepVerdictLines({ passed: true }, { durationMs: 5 }), ['✅ Passed (5ms)']);
  assert.deepStrictEqual(formatStepVerdictLines({ passed: false }, { durationMs: 5 }), ['❌ Failed (5ms)']);
});
