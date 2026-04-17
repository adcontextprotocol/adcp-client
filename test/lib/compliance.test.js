/**
 * Unit tests for the compliance assessment module
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  comply,
  computeOverallStatus,
  formatComplianceResults,
  formatComplianceResultsJSON,
  SAMPLE_BRIEFS,
  getBriefById,
  getBriefsByVertical,
} = require('../../dist/lib/testing/compliance/index.js');

// ============================================================
// Sample Brief Library
// ============================================================

describe('SAMPLE_BRIEFS', () => {
  test('contains at least 5 briefs', () => {
    assert.ok(SAMPLE_BRIEFS.length >= 5, `Expected 5+ briefs, got ${SAMPLE_BRIEFS.length}`);
  });

  test('every brief has required fields', () => {
    for (const brief of SAMPLE_BRIEFS) {
      assert.ok(brief.id, `Brief missing id`);
      assert.ok(brief.name, `Brief ${brief.id} missing name`);
      assert.ok(brief.vertical, `Brief ${brief.id} missing vertical`);
      assert.ok(brief.brief, `Brief ${brief.id} missing brief text`);
      assert.ok(brief.evaluation_hints, `Brief ${brief.id} missing evaluation_hints`);
    }
  });

  test('brief IDs are unique', () => {
    const ids = SAMPLE_BRIEFS.map(b => b.id);
    const unique = new Set(ids);
    assert.strictEqual(ids.length, unique.size, 'Brief IDs must be unique');
  });

  test('covers multiple verticals', () => {
    const verticals = new Set(SAMPLE_BRIEFS.map(b => b.vertical));
    assert.ok(verticals.size >= 4, `Expected 4+ verticals, got ${verticals.size}`);
  });

  test('includes briefs with expected_channels', () => {
    const withChannels = SAMPLE_BRIEFS.filter(b => b.expected_channels?.length);
    assert.ok(withChannels.length >= 3, 'At least 3 briefs should specify expected_channels');
  });

  test('includes briefs with budget_context', () => {
    const withBudget = SAMPLE_BRIEFS.filter(b => b.budget_context);
    assert.ok(withBudget.length >= 5, 'At least 5 briefs should specify budget_context');
  });
});

describe('getBriefById', () => {
  test('returns a brief by ID', () => {
    const brief = getBriefById('luxury_auto_ev');
    assert.ok(brief, 'Should find luxury_auto_ev');
    assert.strictEqual(brief.name, 'Luxury Auto EV Launch');
  });

  test('returns undefined for unknown ID', () => {
    assert.strictEqual(getBriefById('nonexistent'), undefined);
  });
});

describe('getBriefsByVertical', () => {
  test('returns briefs matching vertical (case insensitive)', () => {
    const results = getBriefsByVertical('auto');
    assert.ok(results.length >= 1, 'Should find at least 1 automotive brief');
  });

  test('returns empty for unknown vertical', () => {
    const results = getBriefsByVertical('zzzunknownzzz');
    assert.strictEqual(results.length, 0);
  });
});

// ============================================================
// Compliance Result Formatting
// ============================================================

const mockResult = {
  agent_url: 'https://example.com/mcp',
  agent_profile: { name: 'Test Agent', tools: ['get_products', 'create_media_buy'] },
  overall_status: 'partial',
  tracks: [
    {
      track: 'core',
      status: 'pass',
      label: 'Core Protocol',
      scenarios: [
        {
          scenario: 'health_check',
          overall_passed: true,
          steps: [],
          summary: 'Passed',
          total_duration_ms: 100,
        },
      ],
      skipped_scenarios: [],
      observations: [],
      duration_ms: 100,
    },
    {
      track: 'products',
      status: 'fail',
      label: 'Product Discovery',
      scenarios: [
        {
          scenario: 'pricing_edge_cases',
          overall_passed: false,
          steps: [{ step: 'Check pricing', passed: false, duration_ms: 50, error: 'No pricing options' }],
          summary: 'Failed',
          total_duration_ms: 50,
        },
      ],
      skipped_scenarios: [],
      observations: [],
      duration_ms: 50,
    },
    {
      track: 'signals',
      status: 'skip',
      label: 'Signals',
      scenarios: [],
      skipped_scenarios: ['signals_flow'],
      observations: [],
      duration_ms: 0,
    },
  ],
  tested_tracks: [
    {
      track: 'core',
      status: 'pass',
      label: 'Core Protocol',
      scenarios: [],
      skipped_scenarios: [],
      observations: [],
      duration_ms: 100,
    },
    {
      track: 'products',
      status: 'fail',
      label: 'Product Discovery',
      scenarios: [],
      skipped_scenarios: [],
      observations: [],
      duration_ms: 50,
    },
  ],
  skipped_tracks: [{ track: 'signals', label: 'Signals', reason: 'No storyboards produced results for this track' }],
  summary: {
    tracks_passed: 1,
    tracks_failed: 1,
    tracks_skipped: 1,
    tracks_partial: 0,
    headline: '1 passing, 1 failing',
  },
  observations: [{ category: 'completeness', severity: 'warning', message: 'Missing fields' }],
  storyboards_executed: ['capability_discovery', 'schema_validation'],
  tested_at: new Date().toISOString(),
  total_duration_ms: 150,
};

describe('formatComplianceResults', () => {
  test('includes agent name and URL', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('https://example.com/mcp'), 'Should include agent URL');
    assert.ok(output.includes('Test Agent'), 'Should include agent name');
  });

  test('shows track statuses', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('Core Protocol'), 'Should include core track');
    assert.ok(output.includes('Product Discovery'), 'Should include products track');
    assert.ok(output.includes('not applicable'), 'Should show skipped tracks');
  });

  test('shows failed step details', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('No pricing options'), 'Should show error details');
  });

  test('shows advisory observations', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('Missing fields'), 'Should show observations');
  });

  test('shows summary headline', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('1 passing, 1 failing'), 'Should show headline');
  });
});

// ============================================================
// computeOverallStatus
// ============================================================

describe('computeOverallStatus', () => {
  test('returns passing when all tracks pass', () => {
    assert.strictEqual(
      computeOverallStatus({ tracks_passed: 3, tracks_failed: 0, tracks_skipped: 2, tracks_partial: 0, headline: '' }),
      'passing'
    );
  });

  test('returns failing when all attempted tracks fail', () => {
    assert.strictEqual(
      computeOverallStatus({ tracks_passed: 0, tracks_failed: 2, tracks_skipped: 1, tracks_partial: 0, headline: '' }),
      'failing'
    );
  });

  test('returns partial when mix of pass and fail', () => {
    assert.strictEqual(
      computeOverallStatus({ tracks_passed: 1, tracks_failed: 1, tracks_skipped: 0, tracks_partial: 0, headline: '' }),
      'partial'
    );
  });

  test('returns partial when some tracks are partial', () => {
    assert.strictEqual(
      computeOverallStatus({ tracks_passed: 1, tracks_failed: 0, tracks_skipped: 0, tracks_partial: 1, headline: '' }),
      'partial'
    );
  });

  test('returns partial when no tracks attempted (all skipped)', () => {
    assert.strictEqual(
      computeOverallStatus({ tracks_passed: 0, tracks_failed: 0, tracks_skipped: 5, tracks_partial: 0, headline: '' }),
      'partial'
    );
  });
});

// ============================================================
// Track partitioning
// ============================================================

describe('track partitioning', () => {
  test('tested_tracks contains only pass/fail/partial tracks', () => {
    for (const t of mockResult.tested_tracks) {
      assert.ok(['pass', 'fail', 'partial'].includes(t.status));
    }
  });

  test('skipped_tracks has track, label, and reason', () => {
    for (const t of mockResult.skipped_tracks) {
      assert.ok(t.track);
      assert.ok(t.label);
      assert.ok(t.reason);
    }
  });

  test('tested_tracks + skipped_tracks cover all non-terminal tracks', () => {
    const total = mockResult.tested_tracks.length + mockResult.skipped_tracks.length;
    assert.strictEqual(total, mockResult.tracks.length);
  });
});

describe('formatComplianceResultsJSON', () => {
  test('returns valid JSON', () => {
    const mock = {
      agent_url: 'https://example.com',
      tracks: [],
      summary: { headline: 'test' },
      observations: [],
    };
    const json = formatComplianceResultsJSON(mock);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.agent_url, 'https://example.com');
  });
});
