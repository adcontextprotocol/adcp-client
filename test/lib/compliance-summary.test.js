/**
 * Tests for the narrow compliance-summary artifact and its renderers.
 *
 * The summary is the schema-stable contract for downstream tooling
 * (badges, Slack bots, dashboards). The full ComplianceResult shape
 * evolves with the protocol; this contract should not.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  buildComplianceSummary,
  buildCrashSummary,
  formatComplianceSummaryText,
  formatComplianceSummaryMarkdown,
} = require('../../dist/lib/testing/compliance/index.js');

function passingResult() {
  return {
    agent_url: 'https://agent.example/mcp',
    agent_profile: { name: 'Agent', tools: [] },
    overall_status: 'passing',
    tracks: [],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: 1,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_silent: 0,
      headline: 'ok',
      steps_passed: 5,
      steps_failed: 0,
      steps_skipped: 0,
    },
    observations: [],
    failures: [],
    storyboards_executed: ['x'],
    tested_at: '2026-01-01T00:00:00Z',
    total_duration_ms: 1000,
  };
}

function failingResult() {
  return {
    ...passingResult(),
    overall_status: 'failing',
    summary: {
      tracks_passed: 1,
      tracks_failed: 1,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_silent: 0,
      headline: 'fail',
      steps_passed: 4,
      steps_failed: 2,
      steps_skipped: 1,
    },
    failures: [
      {
        track: 'media_buy',
        storyboard_id: 'sales_proposal_finalize',
        step_id: 'proposal_finalize',
        step_title: 'Finalize',
        task: 'create_media_buy',
        error: 'missing pricing.cpm',
        fix_command: 'adcp ...',
      },
      {
        track: 'audiences',
        storyboard_id: 'audience_sync',
        step_id: 'sync_audiences',
        step_title: 'Sync',
        task: 'sync_audiences',
        validation: { check: 'schema', description: 'account.id required', json_pointer: '/account/id' },
        fix_command: 'adcp ...',
      },
    ],
  };
}

describe('buildComplianceSummary', () => {
  test('passing run produces zero failures', () => {
    const s = buildComplianceSummary(passingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.strictEqual(s.failed, 0);
    assert.deepStrictEqual(s.failures, []);
    assert.strictEqual(s.overall_status, 'passing');
    assert.strictEqual(s.passed, 5);
  });

  test('failing run flattens failures into the contract shape', () => {
    const s = buildComplianceSummary(failingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.strictEqual(s.failures.length, 2);
    assert.deepStrictEqual(Object.keys(s.failures[0]).sort(), [
      'reason',
      'reason_kind',
      'step_id',
      'storyboard_id',
      'track',
    ]);
    assert.match(s.failures[0].reason, /missing pricing\.cpm/);
    assert.strictEqual(s.failures[0].reason_kind, 'error');
    assert.match(s.failures[1].reason, /account\.id required/);
    assert.match(s.failures[1].reason, /\/account\/id/);
    assert.strictEqual(s.failures[1].reason_kind, 'validation');
  });

  test('schema_version is stable at 1', () => {
    const s = buildComplianceSummary(passingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.strictEqual(s.schema_version, 1);
  });

  test('includes agent_url + sdk_version + adcp_version for paste-friendliness', () => {
    const s = buildComplianceSummary(passingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.strictEqual(s.agent_url, 'https://agent.example/mcp');
    assert.strictEqual(s.sdk_version, '6.9.0');
    assert.strictEqual(s.adcp_version, '3.0.6');
  });
});

describe('formatComplianceSummaryText', () => {
  test('passing run uses STORYBOARD-OK marker', () => {
    const s = buildComplianceSummary(passingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const text = formatComplianceSummaryText(s);
    assert.match(text, /STORYBOARD-OK/);
    assert.doesNotMatch(text, /STORYBOARD-FAIL/);
  });

  test('failing run uses greppable STORYBOARD-FAIL marker (kebab, no spaces)', () => {
    const s = buildComplianceSummary(failingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const text = formatComplianceSummaryText(s);
    assert.match(text, /STORYBOARD-FAIL 2 step\(s\)/);
    assert.match(text, /sales_proposal_finalize\/proposal_finalize/);
    assert.match(text, /audience_sync\/sync_audiences/);
  });

  test('unreachable run with zero failures still renders STORYBOARD-FAIL (no silent CI pass)', () => {
    const result = passingResult();
    result.overall_status = 'unreachable';
    result.summary = { ...result.summary, steps_passed: 0 };
    result.failures = [];
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const text = formatComplianceSummaryText(s);
    assert.match(text, /STORYBOARD-FAIL run ended unreachable/);
  });

  test('partial run renders STORYBOARD-PARTIAL — distinct from OK and FAIL', () => {
    const result = passingResult();
    result.overall_status = 'partial';
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const text = formatComplianceSummaryText(s);
    assert.match(text, /STORYBOARD-PARTIAL/);
    assert.doesNotMatch(text, /STORYBOARD-FAIL/);
    assert.doesNotMatch(text, /STORYBOARD-OK/);
  });

  test('always names the agent and sdk version', () => {
    const s = buildComplianceSummary(failingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const text = formatComplianceSummaryText(s);
    assert.match(text, /https:\/\/agent\.example\/mcp/);
    assert.match(text, /@adcp\/sdk 6\.9\.0/);
    assert.match(text, /AdCP 3\.0\.6/);
  });
});

describe('formatComplianceSummaryMarkdown', () => {
  test('failing run renders a markdown table for $GITHUB_STEP_SUMMARY', () => {
    const s = buildComplianceSummary(failingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const md = formatComplianceSummaryMarkdown(s);
    assert.match(md, /^## ❌ Storyboard run: 2 failure\(s\)/);
    assert.match(md, /\| Track \| Storyboard \| Step \| Reason \|/);
    assert.match(md, /\| `media_buy` \| `sales_proposal_finalize` \| `proposal_finalize` \|/);
  });

  test('passing run renders a passing heading and no failure table', () => {
    const s = buildComplianceSummary(passingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const md = formatComplianceSummaryMarkdown(s);
    assert.match(md, /^## ✅ Storyboard run passed/);
    assert.doesNotMatch(md, /\| Track \| Storyboard/);
  });

  test('escapes pipe characters in failure reasons so the table stays valid', () => {
    const result = failingResult();
    result.failures[0].error = 'pipe | break | table';
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const md = formatComplianceSummaryMarkdown(s);
    assert.match(md, /pipe \\\| break \\\| table/);
  });

  test('escapes backslashes before pipes so adversarial reason strings cannot break the table', () => {
    // CodeQL flagged the original implementation: `\|` in input combined with
    // a naive `|` → `\|` replacement produced `\\|` (literal backslash + raw
    // pipe), splitting the row. The fix is to escape backslashes first.
    const result = failingResult();
    result.failures[0].error = 'sneaky \\| literal';
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const md = formatComplianceSummaryMarkdown(s);
    assert.match(md, /sneaky \\\\\\\| literal/);
  });
});

function resultWithSkips() {
  const base = passingResult();
  return {
    ...base,
    overall_status: 'partial',
    summary: {
      ...base.summary,
      steps_skipped: 3,
    },
    tracks: [
      {
        track: 'media_buy',
        status: 'skip',
        label: 'Media Buy',
        observations: [],
        duration_ms: 0,
        scenarios: [
          {
            agent_url: 'https://agent.example/mcp',
            scenario: 'refine_products/setup',
            overall_passed: true,
            summary: 'ok',
            total_duration_ms: 0,
            tested_at: base.tested_at,
            steps: [
              {
                step: 'sync_accounts',
                task: 'sync_accounts',
                passed: true,
                skipped: true,
                skip_reason: 'missing_tool',
                duration_ms: 0,
                warnings: ['Agent did not advertise tool "sync_accounts"; agent tools: [get_adcp_capabilities].'],
              },
              {
                step: 'list_accounts',
                task: 'list_accounts',
                passed: true,
                skipped: true,
                skip_reason: 'missing_tool',
                duration_ms: 0,
                warnings: ['Agent did not advertise tool "list_accounts"; agent tools: [get_adcp_capabilities].'],
              },
            ],
          },
          {
            agent_url: 'https://agent.example/mcp',
            scenario: 'create_buy/deterministic',
            overall_passed: true,
            summary: 'ok',
            total_duration_ms: 0,
            tested_at: base.tested_at,
            steps: [
              {
                step: 'seed',
                task: 'comply_test_controller',
                passed: true,
                skipped: true,
                skip_reason: 'missing_test_controller',
                duration_ms: 0,
                warnings: ['Skipped: deterministic_testing phase requires comply_test_controller, which the agent did not advertise.'],
              },
            ],
          },
        ],
        skipped_scenarios: [],
      },
    ],
  };
}

describe('buildComplianceSummary — skip causes', () => {
  test('no skip_causes field when steps_skipped is zero', () => {
    const s = buildComplianceSummary(passingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.strictEqual(s.skip_causes, undefined);
  });

  test('aggregates missing_tool causes by tool name', () => {
    const result = resultWithSkips();
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.ok(s.skip_causes);
    const missingSync = s.skip_causes.find(c => c.cause === 'missing_tool: sync_accounts');
    assert.ok(missingSync, 'missing_tool: sync_accounts should be present');
    assert.strictEqual(missingSync.count, 1);
    assert.deepStrictEqual(missingSync.affected, ['refine_products/setup']);
  });

  test('aggregates missing_test_controller as its own cause', () => {
    const result = resultWithSkips();
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.ok(s.skip_causes);
    const mtc = s.skip_causes.find(c => c.cause === 'missing_test_controller');
    assert.ok(mtc, 'missing_test_controller should be present');
    assert.strictEqual(mtc.count, 1);
    assert.ok(mtc.detail.includes('comply_test_controller'));
  });

  test('excludes non-actionable skip reasons (peer_branch_taken, not_applicable)', () => {
    const base = passingResult();
    const result = {
      ...base,
      tracks: [
        {
          track: 'media_buy',
          status: 'skip',
          label: 'Media Buy',
          observations: [],
          duration_ms: 0,
          scenarios: [
            {
              agent_url: 'https://agent.example/mcp',
              scenario: 'foo/bar',
              overall_passed: true,
              summary: 'ok',
              total_duration_ms: 0,
              tested_at: base.tested_at,
              steps: [
                {
                  step: 'peer-skip',
                  passed: true,
                  skipped: true,
                  skip_reason: 'peer_branch_taken',
                  duration_ms: 0,
                },
                {
                  step: 'na-skip',
                  passed: true,
                  skipped: true,
                  skip_reason: 'not_applicable',
                  duration_ms: 0,
                },
              ],
            },
          ],
          skipped_scenarios: [],
        },
      ],
    };
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.strictEqual(s.skip_causes, undefined);
  });

  test('sorts causes by count descending', () => {
    const base = passingResult();
    const result = {
      ...base,
      tracks: [
        {
          track: 'media_buy',
          status: 'skip',
          label: 'Media Buy',
          observations: [],
          duration_ms: 0,
          scenarios: [
            {
              agent_url: 'https://agent.example/mcp',
              scenario: 'a/setup',
              overall_passed: true,
              summary: 'ok',
              total_duration_ms: 0,
              tested_at: base.tested_at,
              steps: [
                { step: 's1', passed: true, skipped: true, skip_reason: 'missing_test_controller', duration_ms: 0, warnings: ['Skipped: deterministic_testing phase requires comply_test_controller, which the agent did not advertise.'] },
                { step: 's2', passed: true, skipped: true, skip_reason: 'missing_test_controller', duration_ms: 0, warnings: ['Skipped: deterministic_testing phase requires comply_test_controller, which the agent did not advertise.'] },
                { step: 's3', passed: true, skipped: true, skip_reason: 'missing_tool', duration_ms: 0, warnings: ['Agent did not advertise tool "sync_accounts"; agent tools: [].'] },
              ],
            },
          ],
          skipped_scenarios: [],
        },
      ],
    };
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    assert.ok(s.skip_causes);
    assert.strictEqual(s.skip_causes[0].cause, 'missing_test_controller');
    assert.strictEqual(s.skip_causes[0].count, 2);
    assert.strictEqual(s.skip_causes[1].cause, 'missing_tool: sync_accounts');
    assert.strictEqual(s.skip_causes[1].count, 1);
  });
});

describe('formatComplianceSummaryText — skip causes', () => {
  test('renders Skip causes block when causes are present', () => {
    const result = resultWithSkips();
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const text = formatComplianceSummaryText(s);
    assert.match(text, /Skip causes:/);
    assert.match(text, /missing_tool: sync_accounts/);
    assert.match(text, /missing_test_controller/);
    assert.match(text, /Affected:/);
  });

  test('no Skip causes block when skips are zero', () => {
    const s = buildComplianceSummary(passingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const text = formatComplianceSummaryText(s);
    assert.doesNotMatch(text, /Skip causes:/);
  });

  test('truncates Affected list beyond SKIP_CAUSE_AFFECTED_LIMIT', () => {
    const base = passingResult();
    const scenarios = Array.from({ length: 8 }, (_, i) => ({
      agent_url: 'https://agent.example/mcp',
      scenario: `storyboard_${i}/setup`,
      overall_passed: true,
      summary: 'ok',
      total_duration_ms: 0,
      tested_at: base.tested_at,
      steps: [
        {
          step: 'seed',
          passed: true,
          skipped: true,
          skip_reason: 'missing_test_controller',
          duration_ms: 0,
          warnings: ['Skipped: deterministic_testing phase requires comply_test_controller, which the agent did not advertise.'],
        },
      ],
    }));
    const result = {
      ...base,
      tracks: [
        {
          track: 'media_buy',
          status: 'skip',
          label: 'Media Buy',
          observations: [],
          duration_ms: 0,
          scenarios,
          skipped_scenarios: [],
        },
      ],
    };
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const text = formatComplianceSummaryText(s);
    assert.match(text, /… 3 more/);
  });
});

describe('formatComplianceSummaryMarkdown — skip causes', () => {
  test('renders <details> block for skip causes', () => {
    const result = resultWithSkips();
    const s = buildComplianceSummary(result, { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const md = formatComplianceSummaryMarkdown(s);
    assert.match(md, /<details>/);
    assert.match(md, /Skip causes/);
    assert.match(md, /missing_tool: sync_accounts/);
    assert.match(md, /<\/details>/);
  });

  test('no skip causes block when causes absent', () => {
    const s = buildComplianceSummary(passingResult(), { sdkVersion: '6.9.0', adcpVersion: '3.0.6' });
    const md = formatComplianceSummaryMarkdown(s);
    assert.doesNotMatch(md, /<details>/);
  });
});

describe('buildCrashSummary', () => {
  test('produces a schema_version-1 artifact when comply() throws', () => {
    const summary = buildCrashSummary({
      sdkVersion: '6.9.0',
      adcpVersion: '3.0.6',
      agentUrl: 'https://broken.example/mcp',
      error: new Error('ECONNREFUSED'),
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 42,
    });
    assert.strictEqual(summary.schema_version, 1);
    assert.strictEqual(summary.overall_status, 'unreachable');
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.failures.length, 1);
    assert.strictEqual(summary.failures[0].storyboard_id, 'pre-flight');
    assert.strictEqual(summary.failures[0].reason_kind, 'error');
    assert.match(summary.failures[0].reason, /ECONNREFUSED/);
  });

  test('crash summary renders STORYBOARD-FAIL via the same text formatter', () => {
    const summary = buildCrashSummary({
      sdkVersion: '6.9.0',
      adcpVersion: '3.0.6',
      agentUrl: 'https://broken.example/mcp',
      error: 'capabilities parse error',
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 0,
    });
    const text = formatComplianceSummaryText(summary);
    assert.match(text, /STORYBOARD-FAIL/);
    assert.match(text, /pre-flight\/comply/);
    assert.match(text, /capabilities parse error/);
  });
});
