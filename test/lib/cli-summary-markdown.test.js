// Unit coverage for the markdown writers used by `--summary-file` and the
// $GITHUB_STEP_SUMMARY auto-activation path (issue adcp-client#1527). The
// helpers are extracted to `bin/adcp-storyboard-summary.js` so they can be
// imported without spawning the CLI.
//
// Each renderer has three regimes that must stay correct:
//   - `failures: undefined`     — happens for crash-path / partial results
//   - `failures: []`            — passing run, no per-step rows
//   - `failures: [...]`         — at least one row, table must render
//
// Plus the cell-escape contract: `|` and newlines inside reasons must not
// break the table layout.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildComplianceSummaryMarkdown,
  buildStoryboardSummaryMarkdown,
  escapeMarkdownCell,
} = require('../../bin/adcp-storyboard-summary.js');

// ----------------------------------------------------------------------------
// buildComplianceSummaryMarkdown — `comply()` / ComplianceResult shape
// ----------------------------------------------------------------------------

test('compliance summary: passing result with no failures field omits the table', () => {
  const md = buildComplianceSummaryMarkdown(
    {
      overall_status: 'passing',
      summary: { steps_passed: 8, steps_failed: 0, steps_skipped: 1, steps_not_selected: 2 },
    },
    'https://agent.example.com'
  );

  assert.match(md, /^# Storyboard run: https:\/\/agent\.example\.com$/m);
  assert.match(md, /\*\*Overall:\*\* passing — 8 passed \/ 0 failed \/ 1 skipped \/ 2 not selected/);
  assert.doesNotMatch(md, /## Failures/);
  assert.doesNotMatch(md, /No per-step failure details/);
});

test('compliance summary: renders skip and not-selected reason counts', () => {
  const md = buildComplianceSummaryMarkdown(
    {
      overall_status: 'passing',
      summary: {
        steps_passed: 8,
        steps_failed: 0,
        steps_skipped: 1,
        steps_not_selected: 2,
        skipped_by_reason: { missing_tool: 1 },
        not_selected_by_reason: { explicit_scope_excluded: 2 },
      },
    },
    'https://agent.example.com'
  );

  assert.match(md, /\*\*Not selected:\*\* explicit_scope_excluded=2/);
  assert.match(md, /\*\*Skipped:\*\* missing_tool=1/);
});

test('compliance summary: failing result with undefined failures emits placeholder', () => {
  // Crash-path / partial-eval shapes leave `failures` undefined. The
  // renderer must signal "no detail available" rather than render an empty
  // table or pretend the run was clean.
  const md = buildComplianceSummaryMarkdown(
    {
      overall_status: 'failing',
      summary: { steps_passed: 2, steps_failed: 3, steps_skipped: 0 },
    },
    'https://agent.example.com'
  );

  assert.match(md, /\*\*Overall:\*\* failing — 2 passed \/ 3 failed \/ 0 skipped/);
  assert.match(md, /_No per-step failure details available\._/);
  assert.doesNotMatch(md, /## Failures/);
});

test('compliance summary: empty failures array on non-passing run still emits placeholder', () => {
  const md = buildComplianceSummaryMarkdown(
    {
      overall_status: 'partial',
      summary: { steps_passed: 1, steps_failed: 0, steps_skipped: 4 },
      failures: [],
    },
    'https://agent.example.com'
  );

  assert.match(md, /_No per-step failure details available\._/);
  assert.doesNotMatch(md, /## Failures/);
});

test('compliance summary: populated failures render a Markdown table', () => {
  const md = buildComplianceSummaryMarkdown(
    {
      overall_status: 'failing',
      summary: { steps_passed: 1, steps_failed: 2, steps_skipped: 0 },
      failures: [
        { storyboard_id: 'sb-1', step_id: 'step-a', error: 'boom' },
        { storyboard_id: 'sb-2', step_id: 'step-b', validation: { description: 'schema mismatch' } },
      ],
    },
    'https://agent.example.com'
  );

  assert.match(md, /## Failures/);
  assert.match(md, /\| Storyboard \| Step \| Reason \|/);
  assert.match(md, /\|---\|---\|---\|/);
  assert.match(md, /\| sb-1 \| step-a \| boom \|/);
  assert.match(md, /\| sb-2 \| step-b \| schema mismatch \|/);
});

test('compliance summary: surfaces specialisms when present on the agent profile', () => {
  const md = buildComplianceSummaryMarkdown(
    {
      overall_status: 'passing',
      summary: { steps_passed: 5, steps_failed: 0, steps_skipped: 0 },
      agent_profile: { specialisms: ['sales-non-guaranteed', 'creative-template'] },
    },
    'https://agent.example.com'
  );

  assert.match(md, /\*\*Specialisms:\*\* sales-non-guaranteed, creative-template/);
});

// ----------------------------------------------------------------------------
// buildStoryboardSummaryMarkdown — runStoryboard()/StoryboardResult shape
// ----------------------------------------------------------------------------

test('storyboard summary: empty results array still renders a header + overall line', () => {
  const md = buildStoryboardSummaryMarkdown([], 'https://agent.example.com', true);

  assert.match(md, /^# Storyboard run: https:\/\/agent\.example\.com$/m);
  assert.match(md, /\*\*Overall:\*\* passed — 0 passed \/ 0 failed \/ 0 skipped/);
  assert.doesNotMatch(md, /## Failures/);
});

test('storyboard summary: agentUrl falsy → falls back to "local agent"', () => {
  // When `--local-agent` runs the storyboard, there is no remote URL.
  const md = buildStoryboardSummaryMarkdown([], '', true);
  assert.match(md, /^# Storyboard run: local agent$/m);
});

test('storyboard summary: passing storyboard with no failed steps omits the table', () => {
  const md = buildStoryboardSummaryMarkdown(
    [
      {
        storyboard_id: 'sb-1',
        passed_count: 3,
        failed_count: 0,
        skipped_count: 0,
        phases: [{ steps: [{ id: 'step-1', passed: true, skipped: false }] }],
      },
    ],
    'https://agent.example.com',
    true
  );

  assert.match(md, /\*\*Overall:\*\* passed — 3 passed \/ 0 failed \/ 0 skipped/);
  assert.doesNotMatch(md, /## Failures/);
});

test('storyboard summary: failed step with validations[] joins descriptions with "; "', () => {
  const md = buildStoryboardSummaryMarkdown(
    [
      {
        storyboard_id: 'sb-1',
        passed_count: 0,
        failed_count: 1,
        skipped_count: 0,
        phases: [
          {
            steps: [
              {
                id: 'step-a',
                passed: false,
                skipped: false,
                validations: [
                  { passed: true, description: 'first ok' },
                  { passed: false, description: 'second broke' },
                  { passed: false, error: 'third blew up' },
                ],
              },
            ],
          },
        ],
      },
    ],
    'https://agent.example.com',
    false
  );

  assert.match(md, /\*\*Overall:\*\* failed — 0 passed \/ 1 failed \/ 0 skipped/);
  assert.match(md, /## Failures/);
  assert.match(md, /\| sb-1 \| step-a \| second broke; third blew up \|/);
});

test('storyboard summary: failed step without validations falls back to step.error', () => {
  const md = buildStoryboardSummaryMarkdown(
    [
      {
        storyboard_id: 'sb-1',
        passed_count: 0,
        failed_count: 1,
        skipped_count: 0,
        phases: [{ steps: [{ id: 'step-a', passed: false, skipped: false, error: 'transport reset' }] }],
      },
    ],
    'https://agent.example.com',
    false
  );

  assert.match(md, /\| sb-1 \| step-a \| transport reset \|/);
});

test('storyboard summary: skipped steps are excluded from the failure table', () => {
  const md = buildStoryboardSummaryMarkdown(
    [
      {
        storyboard_id: 'sb-1',
        passed_count: 1,
        failed_count: 0,
        skipped_count: 1,
        phases: [
          {
            steps: [
              { id: 'step-a', passed: true, skipped: false },
              { id: 'step-b', passed: false, skipped: true }, // skipped, not a failure
            ],
          },
        ],
      },
    ],
    'https://agent.example.com',
    true
  );

  assert.doesNotMatch(md, /## Failures/);
  assert.doesNotMatch(md, /step-b/);
});

test('storyboard summary: missing passed_count / failed_count default to 0 (no NaN propagation)', () => {
  const md = buildStoryboardSummaryMarkdown([{ storyboard_id: 'sb-1', phases: [] }], 'https://agent.example.com', true);

  assert.match(md, /0 passed \/ 0 failed \/ 0 skipped/);
  assert.doesNotMatch(md, /NaN/);
});

// ----------------------------------------------------------------------------
// escapeMarkdownCell — pipe + newline escaping
// ----------------------------------------------------------------------------

test('escapeMarkdownCell: pipes are backslash-escaped so they do not split cells', () => {
  assert.strictEqual(escapeMarkdownCell('a | b | c'), 'a \\| b \\| c');
});

test('escapeMarkdownCell: newlines collapse to spaces so a multi-line reason stays on one row', () => {
  assert.strictEqual(escapeMarkdownCell('first line\nsecond line'), 'first line second line');
});

test('escapeMarkdownCell: null / undefined coerce to empty string', () => {
  assert.strictEqual(escapeMarkdownCell(null), '');
  assert.strictEqual(escapeMarkdownCell(undefined), '');
});

test('escapeMarkdownCell: non-string values stringify', () => {
  assert.strictEqual(escapeMarkdownCell(42), '42');
});
