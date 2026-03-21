/**
 * Unit tests for the compliance assessment module
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  // Comply
  comply,
  formatComplianceResults,
  formatComplianceResultsJSON,
  // Brief library
  SAMPLE_BRIEFS,
  getBriefById,
  getBriefsByVertical,
  // Platform profiles
  getPlatformProfile,
  getAllPlatformTypes,
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
// Platform Profiles
// ============================================================

describe('getAllPlatformTypes', () => {
  test('returns all platform types with id and label', () => {
    const types = getAllPlatformTypes();
    assert.ok(types.length >= 15, `Expected at least 15 types, got ${types.length}`);
    for (const entry of types) {
      assert.ok(entry.id, `Entry missing id`);
      assert.ok(entry.label, `Entry missing label for ${entry.id}`);
    }
  });

  test('includes all sales platform types', () => {
    const types = getAllPlatformTypes();
    const typeIds = types.map(t => t.id);
    const salesTypes = [
      'display_ad_server',
      'video_ad_server',
      'social_platform',
      'pmax_platform',
      'dsp',
      'retail_media',
      'search_platform',
      'audio_platform',
    ];
    for (const st of salesTypes) {
      assert.ok(typeIds.includes(st), `Missing sales type: ${st}`);
    }
  });

  test('includes all creative agent types', () => {
    const types = getAllPlatformTypes();
    const typeIds = types.map(t => t.id);
    const creativeTypes = ['creative_transformer', 'creative_library', 'creative_ad_server'];
    for (const ct of creativeTypes) {
      assert.ok(typeIds.includes(ct), `Missing creative type: ${ct}`);
    }
  });

  test('includes SI and AI-native types', () => {
    const types = getAllPlatformTypes();
    const typeIds = types.map(t => t.id);
    assert.ok(typeIds.includes('si_platform'), 'Missing si_platform');
    assert.ok(typeIds.includes('ai_ad_network'), 'Missing ai_ad_network');
    assert.ok(typeIds.includes('ai_platform'), 'Missing ai_platform');
    assert.ok(typeIds.includes('generative_dsp'), 'Missing generative_dsp');
  });
});

describe('getPlatformProfile', () => {
  test('returns profile for each type', () => {
    const types = getAllPlatformTypes();
    for (const { id } of types) {
      const profile = getPlatformProfile(id);
      assert.ok(profile, `No profile for ${id}`);
      assert.strictEqual(profile.type, id);
      assert.ok(profile.label, `${id} missing label`);
      assert.ok(profile.expected_tracks.length > 0, `${id} has no expected tracks`);
      assert.ok(profile.expected_tracks.includes('core'), `${id} expected_tracks should include core`);
      assert.ok(profile.expected_tools.length > 0, `${id} has no expected tools`);
      assert.ok(typeof profile.checkCoherence === 'function', `${id} missing checkCoherence`);
    }
  });
});

describe('getPlatformProfile — error handling', () => {
  test('throws for unknown platform type', () => {
    assert.throws(() => getPlatformProfile('not_a_real_type'), /Unknown platform type: not_a_real_type/);
  });

  test('throws for prototype pollution attempt', () => {
    assert.throws(() => getPlatformProfile('__proto__'), /Unknown platform type: __proto__/);
  });
});

describe('checkCoherence', () => {
  test('returns empty findings for matching social_platform agent', () => {
    const profile = getPlatformProfile('social_platform');
    const agent = {
      name: 'Social Agent',
      tools: ['get_products', 'create_media_buy', 'list_creative_formats', 'sync_audiences', 'sync_creatives'],
    };
    const findings = profile.checkCoherence(agent);
    // Should only have the channel suggestion (which is always present for platforms with expected_channels)
    const nonSuggestions = findings.filter(f => f.severity !== 'suggestion');
    assert.strictEqual(
      nonSuggestions.length,
      0,
      `Unexpected non-suggestion findings: ${JSON.stringify(nonSuggestions)}`
    );
  });

  test('returns findings for social_platform agent missing sync_audiences', () => {
    const profile = getPlatformProfile('social_platform');
    const agent = {
      name: 'Incomplete Social Agent',
      tools: ['get_products', 'create_media_buy'],
    };
    const findings = profile.checkCoherence(agent);
    const audienceFinding = findings.find(f => f.expected.includes('sync_audiences'));
    assert.ok(audienceFinding, 'Should flag missing sync_audiences');
    assert.strictEqual(audienceFinding.severity, 'warning');
  });

  test('returns findings for creative_transformer missing build_creative', () => {
    const profile = getPlatformProfile('creative_transformer');
    const agent = {
      name: 'Incomplete Transformer',
      tools: ['preview_creative', 'list_creative_formats'],
    };
    const findings = profile.checkCoherence(agent);
    const buildFinding = findings.find(f => f.expected.includes('build_creative'));
    assert.ok(buildFinding, 'Should flag missing build_creative');
  });

  test('creative_transformer warns about stateful tools', () => {
    const profile = getPlatformProfile('creative_transformer');
    const agent = {
      name: 'Confused Transformer',
      tools: ['build_creative', 'preview_creative', 'list_creative_formats', 'sync_creatives', 'list_creatives'],
    };
    const findings = profile.checkCoherence(agent);
    const statefulFinding = findings.find(f => f.expected.includes('Stateless'));
    assert.ok(statefulFinding, 'Should flag stateful tools on a transformer');
    assert.strictEqual(statefulFinding.severity, 'suggestion');
  });

  test('creative_library warns about build_creative', () => {
    const profile = getPlatformProfile('creative_library');
    const agent = {
      name: 'Library With Build',
      tools: ['preview_creative', 'list_creative_formats', 'build_creative'],
    };
    const findings = profile.checkCoherence(agent);
    const buildFinding = findings.find(f => f.expected.includes('no creative generation'));
    assert.ok(buildFinding, 'Should flag build_creative on a library');
  });

  test('ai_ad_network flags missing SI tools', () => {
    const profile = getPlatformProfile('ai_ad_network');
    const agent = {
      name: 'AI Network Without SI',
      tools: ['get_products', 'create_media_buy'],
    };
    const findings = profile.checkCoherence(agent);
    const siFinding = findings.find(f => f.expected.includes('si_initiate_session'));
    assert.ok(siFinding, 'Should flag missing SI tools');
  });

  test('generative_dsp flags missing build_creative', () => {
    const profile = getPlatformProfile('generative_dsp');
    const agent = {
      name: 'DSP Without Gen',
      tools: ['get_products', 'create_media_buy', 'get_media_buy_delivery'],
    };
    const findings = profile.checkCoherence(agent);
    const genFinding = findings.find(f => f.expected.includes('build_creative'));
    assert.ok(genFinding, 'Should flag missing build_creative on generative DSP');
  });
});

// ============================================================
// Compliance Result Formatting
// ============================================================

describe('formatComplianceResults', () => {
  const mockResult = {
    agent_url: 'https://example.com/mcp',
    agent_profile: { name: 'Test Agent', tools: ['get_products', 'create_media_buy'] },
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
            dry_run: true,
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
            dry_run: true,
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
    summary: {
      tracks_passed: 1,
      tracks_failed: 1,
      tracks_skipped: 1,
      tracks_partial: 0,
      tracks_expected: 0,
      headline: '1 passing, 1 failing',
    },
    observations: [{ category: 'completeness', severity: 'warning', message: 'Missing fields' }],
    tested_at: new Date().toISOString(),
    total_duration_ms: 150,
    dry_run: true,
  };

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

  test('shows expected tracks with platform coherence', () => {
    const resultWithPlatform = {
      ...mockResult,
      tracks: [
        ...mockResult.tracks,
        {
          track: 'audiences',
          status: 'expected',
          label: 'Audience Management',
          scenarios: [],
          skipped_scenarios: ['sync_audiences'],
          observations: [],
          duration_ms: 0,
        },
      ],
      platform_coherence: {
        platform_type: 'social_platform',
        label: 'Social Platform',
        expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting', 'audiences'],
        missing_tracks: ['audiences'],
        findings: [
          {
            expected: 'Agent has sync_audiences',
            actual: 'sync_audiences not found in tool list',
            guidance: 'Social platforms need sync_audiences.',
            severity: 'warning',
          },
        ],
        coherent: false,
      },
    };
    const output = formatComplianceResults(resultWithPlatform);
    assert.ok(output.includes('expected for Social Platform'), 'Should show expected status');
    assert.ok(output.includes('Platform Coherence'), 'Should show coherence section');
    assert.ok(output.includes('sync_audiences'), 'Should show missing tool');
    assert.ok(output.includes('Platform:'), 'Should show platform in header');
  });

  test('no platform coherence section without platform_type', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(!output.includes('Platform Coherence'), 'Should not show coherence without platform_type');
    assert.ok(!output.includes('Platform:'), 'Should not show platform in header');
  });
});

describe('formatComplianceResultsJSON', () => {
  test('returns valid JSON', () => {
    const mockResult = {
      agent_url: 'https://example.com',
      tracks: [],
      summary: { headline: 'test' },
      observations: [],
    };
    const json = formatComplianceResultsJSON(mockResult);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.agent_url, 'https://example.com');
  });
});
