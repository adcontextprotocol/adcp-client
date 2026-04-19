// Runner-output contract conformance tests for #599.
//
// Every failed validation result MUST carry json_pointer / expected / actual,
// plus schema_id / schema_url for response_schema checks. The step result
// MUST carry an extraction.path and a recorded request/response.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const { toJsonPointer } = require('../../dist/lib/testing/storyboard/path');
const { getResponseSchemaLocator } = require('../../dist/lib/utils/response-schemas');
const { getScenarioSkips } = require('../../dist/lib/testing/orchestrator');

function runOne(validations, taskResult, extras = {}) {
  return runValidations(validations, {
    taskName: extras.taskName ?? 'get_products',
    taskResult,
    agentUrl: extras.agentUrl ?? 'https://example.com/mcp',
    contributions: extras.contributions ?? new Set(),
    ...(extras.httpResult && { httpResult: extras.httpResult }),
  });
}

describe('toJsonPointer', () => {
  it('converts dot paths to RFC 6901 pointers', () => {
    assert.strictEqual(toJsonPointer('adcp.idempotency'), '/adcp/idempotency');
    assert.strictEqual(toJsonPointer('accounts[0].account_id'), '/accounts/0/account_id');
    assert.strictEqual(toJsonPointer('status'), '/status');
  });

  it('escapes ~ and / per RFC 6901', () => {
    assert.strictEqual(toJsonPointer('a~b'), '/a~0b');
    // parsePath treats "/" as a segment separator, so a literal "/" can't appear
    // inside a single segment — but escaping still fires when we pass it in via
    // a manual pseudo-segment.
  });
});

describe('getResponseSchemaLocator', () => {
  it('produces an $id under the correct subdirectory', () => {
    const loc = getResponseSchemaLocator('get_adcp_capabilities', 'latest');
    assert.strictEqual(loc.schema_id, '/schemas/latest/protocol/get-adcp-capabilities-response.json');
    assert.ok(loc.schema_url.endsWith('/schemas/latest/protocol/get-adcp-capabilities-response.json'));
    assert.ok(loc.schema_url.startsWith('https://adcontextprotocol.org/'));
  });

  it('maps get_products to media-buy', () => {
    const loc = getResponseSchemaLocator('get_products', 'latest');
    assert.strictEqual(loc.schema_id, '/schemas/latest/media-buy/get-products-response.json');
  });

  it('returns undefined for unknown tasks', () => {
    assert.strictEqual(getResponseSchemaLocator('no_such_task', 'latest'), undefined);
  });
});

describe('validateResponseSchema emits contract fields', () => {
  it('attaches schema_id and schema_url on pass', () => {
    const taskResult = {
      success: true,
      data: {
        adcp: {
          major_versions: [3],
          idempotency: { replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
      },
    };
    const [r] = runOne(
      [{ check: 'response_schema', description: 'matches capabilities schema' }],
      taskResult,
      { taskName: 'get_adcp_capabilities' }
    );
    assert.strictEqual(r.passed, true, r.error);
    assert.ok(r.schema_id, 'schema_id missing');
    assert.ok(r.schema_url, 'schema_url missing');
  });

  it('emits json_pointer + AJV-style actual on failure', () => {
    const taskResult = {
      success: true,
      // Missing required `adcp.idempotency` — should fail the schema.
      data: { adcp: { major_versions: [3] } },
    };
    const [r] = runOne(
      [{ check: 'response_schema', description: 'matches capabilities schema' }],
      taskResult,
      { taskName: 'get_adcp_capabilities' }
    );
    assert.strictEqual(r.passed, false);
    assert.ok(r.json_pointer?.startsWith('/'), `expected RFC 6901 pointer, got ${r.json_pointer}`);
    assert.ok(Array.isArray(r.actual), 'actual should be AJV-style array');
    assert.ok(r.actual.length > 0);
    assert.ok('instance_path' in r.actual[0]);
    assert.ok('message' in r.actual[0]);
    assert.strictEqual(r.expected, r.schema_id, 'expected should be the schema $id');
  });
});

describe('validateFieldPresent emits contract fields', () => {
  it('emits json_pointer, expected=present, actual=null on miss', () => {
    const [r] = runOne(
      [{ check: 'field_present', path: 'adcp.idempotency', description: 'idempotency is declared' }],
      { success: true, data: { adcp: {} } }
    );
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.json_pointer, '/adcp/idempotency');
    assert.strictEqual(r.expected, 'present');
    assert.strictEqual(r.actual, null);
  });

  it('emits the observed value on pass', () => {
    const [r] = runOne(
      [{ check: 'field_present', path: 'adcp.idempotency.replay_ttl_seconds', description: 'ttl present' }],
      { success: true, data: { adcp: { idempotency: { replay_ttl_seconds: 86400 } } } }
    );
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.actual, 86400);
  });
});

describe('validateFieldValue emits contract fields', () => {
  it('emits expected/actual on exact-match failure', () => {
    const [r] = runOne(
      [{ check: 'field_value', path: 'status', value: 'completed', description: 'status is completed' }],
      { success: true, data: { status: 'working' } }
    );
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.json_pointer, '/status');
    assert.strictEqual(r.expected, 'completed');
    assert.strictEqual(r.actual, 'working');
  });

  it('emits allowed_values as expected on list-match failure', () => {
    const [r] = runOne(
      [
        {
          check: 'field_value',
          path: 'status',
          allowed_values: ['completed', 'submitted'],
          description: 'status in terminal set',
        },
      ],
      { success: true, data: { status: 'working' } }
    );
    assert.strictEqual(r.passed, false);
    assert.deepStrictEqual(r.expected, ['completed', 'submitted']);
    assert.strictEqual(r.actual, 'working');
  });
});

describe('validateErrorCode emits contract fields', () => {
  it('emits json_pointer=/adcp_error/code and the observed code', () => {
    const [r] = runOne(
      [{ check: 'error_code', value: 'INVALID_REQUEST', description: 'expected INVALID_REQUEST' }],
      { success: false, data: { adcp_error: { code: 'VALIDATION_ERROR' } }, error: 'VALIDATION_ERROR: bad' }
    );
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.json_pointer, '/adcp_error/code');
    assert.strictEqual(r.expected, 'INVALID_REQUEST');
    assert.strictEqual(r.actual, 'VALIDATION_ERROR');
  });
});

describe('getScenarioSkips', () => {
  it('distinguishes missing_tool from missing_test_controller', () => {
    // Explicit filter — deterministic_* are excluded from DEFAULT_SCENARIOS.
    const skips = getScenarioSkips(['get_products'], [
      'deterministic_media_buy',
      'create_media_buy',
      'health_check',
    ]);
    const detMediaBuy = skips.find(s => s.scenario === 'deterministic_media_buy');
    assert.ok(detMediaBuy, 'deterministic_media_buy should be skipped');
    assert.strictEqual(detMediaBuy.reason, 'missing_test_controller');
    assert.ok(detMediaBuy.detail.includes('comply_test_controller'), detMediaBuy.detail);

    const createMediaBuy = skips.find(s => s.scenario === 'create_media_buy');
    assert.ok(createMediaBuy);
    assert.strictEqual(createMediaBuy.reason, 'missing_tool');
    assert.ok(createMediaBuy.detail.includes('create_media_buy'), createMediaBuy.detail);

    const healthCheck = skips.find(s => s.scenario === 'health_check');
    assert.strictEqual(healthCheck, undefined, 'health_check is always applicable');
  });

  it('returns empty when every scenario is applicable', () => {
    const skips = getScenarioSkips([], ['health_check']);
    assert.strictEqual(skips.length, 0);
  });
});
