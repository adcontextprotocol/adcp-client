/**
 * Tests for adcp-client#1709 — Zod-reject error attribution.
 *
 * When the SDK's response unwrapper throws `ResponseSchemaValidationError`
 * (Zod schema rejected the agent's response), the storyboard runner MUST:
 *
 *  1. Synthesize a canonical `response_schema` ValidationResult with
 *     `passed: false` on `step.validations`.
 *  2. Prepend it so `extractFailures.find(v => !v.passed)` returns it
 *     before any step-scope invariant entry.
 *  3. Short-circuit step-scope invariants (e.g. `context.no_secret_echo`)
 *     so they don't run against a malformed payload. Each skipped invariant
 *     gets a marker entry naming the bypass reason.
 *
 * Without this attribution, the BidMachine misdiagnosis from adcp#4419
 * recurs: every Zod-reject surfaces as whichever step-scope invariant
 * happens to fire next (the canonical case: `context.no_secret_echo`),
 * masking the schema-validation root cause across many deploys.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/index.js');
const { ResponseSchemaValidationError } = require('../../dist/lib/utils/response-unwrapper.js');

/**
 * Build a minimal stub client that throws `ResponseSchemaValidationError`
 * on the first method call. Simulates the unwrap-layer Zod reject path
 * — the runner's step execution should attribute the failure correctly
 * regardless of what triggered the throw.
 */
function buildSchemaRejectingClient(toolName = 'get_products') {
  return {
    async executeTask(_taskName, _params) {
      throw new ResponseSchemaValidationError(
        toolName,
        [
          {
            code: 'unrecognized_keys',
            path: [],
            keys: ['authorization'],
            message: "Unrecognized key(s) in object: 'authorization'",
          },
        ],
        { authorization: 'present', products: [] },
        "Unrecognized key(s) in object: 'authorization'"
      );
    },
    async getProducts(_params) {
      throw new ResponseSchemaValidationError(
        toolName,
        [
          {
            code: 'unrecognized_keys',
            path: [],
            keys: ['authorization'],
            message: "Unrecognized key(s) in object: 'authorization'",
          },
        ],
        { authorization: 'present', products: [] },
        "Unrecognized key(s) in object: 'authorization'"
      );
    },
    async getAgentInfo() {
      return { name: 'Schema-rejecting stub', tools: [{ name: 'get_products' }] };
    },
  };
}

const stubProfile = {
  name: 'Schema-rejecting stub',
  tools: ['get_products'],
  raw_capabilities: {},
};

function buildStoryboard(overrides = {}) {
  return {
    id: 'schema_attribution_test',
    version: '1.0.0',
    title: 'Schema attribution test',
    category: 'test',
    summary: 'Verifies Zod-reject attribution per adcp-client#1709.',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p1',
        title: 'Phase 1',
        steps: [
          {
            id: 'fetch_products',
            title: 'Fetch products (expect schema reject)',
            task: 'get_products',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('adcp-client#1709 — Zod-reject error attribution', () => {
  test('synthesizes response_schema ValidationResult on the step when unwrapper rejects', async () => {
    const client = buildSchemaRejectingClient('get_products');
    const result = await runStoryboardStep('https://stub.example/mcp', buildStoryboard(), 'fetch_products', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    const schemaValidation = result.validations.find(v => v.check === 'response_schema');
    assert.ok(schemaValidation, 'response_schema validation must be present in step.validations');
    assert.equal(schemaValidation.passed, false);
    assert.match(schemaValidation.description, /get_products/);
    assert.match(schemaValidation.error, /authorization/, 'error message names the rejected field');
  });

  test('response_schema entry is FIRST in step.validations so extractFailures picks it', async () => {
    const client = buildSchemaRejectingClient('get_products');
    const result = await runStoryboardStep('https://stub.example/mcp', buildStoryboard(), 'fetch_products', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    const firstFailed = result.validations.find(v => !v.passed);
    assert.ok(firstFailed, 'expected at least one failed validation');
    assert.equal(
      firstFailed.check,
      'response_schema',
      'first failed validation must be response_schema, not a step-scope invariant ' +
        '(the BidMachine misdiagnosis from adcp#4419)'
    );
  });

  test('step-scope invariants are short-circuited with skip markers when schema rejects (full-pass)', async () => {
    // Step-scope invariants only run via `runStoryboard` (the full pass).
    // `runStoryboardStep` is stateless / LLM-friendly and intentionally
    // skips storyboard-level invariants by design. So we exercise the
    // short-circuit through the multi-step pass.
    const client = buildSchemaRejectingClient('get_products');
    const result = await runStoryboard('https://stub.example/mcp', buildStoryboard(), {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      agentTools: stubProfile.tools,
    });
    const step = result.phases[0]?.steps?.[0];
    assert.ok(step, 'step result present');

    // Invariants that ran SHOULD be marked skipped, not have a real
    // pass/fail verdict. The skip marker carries the invariant id in the
    // description so consumers see WHICH invariant was bypassed.
    const invariantSkips = step.validations.filter(
      v => v.check === 'assertion' && /skipped — response failed schema validation/.test(v.description ?? '')
    );
    assert.ok(
      invariantSkips.length > 0,
      `expected at least one invariant skip marker, got 0. ` +
        `validations: ${JSON.stringify(step.validations.map(v => ({ check: v.check, passed: v.passed, description: v.description })))}`
    );

    // No invariant should be marked as a real failure (passed: false with
    // a non-skip description). That's the regression #1709 guards.
    const realInvariantFailures = step.validations.filter(
      v =>
        v.check === 'assertion' &&
        v.passed === false &&
        !/skipped — response failed schema validation/.test(v.description ?? '')
    );
    assert.equal(
      realInvariantFailures.length,
      0,
      `step-scope invariants must not surface as real failures when schema rejected. ` +
        `got: ${JSON.stringify(realInvariantFailures.map(v => v.description))}`
    );
  });

  test('step.passed remains false (schema rejection is a real failure)', async () => {
    const client = buildSchemaRejectingClient('get_products');
    const result = await runStoryboardStep('https://stub.example/mcp', buildStoryboard(), 'fetch_products', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    assert.equal(result.passed, false, 'schema rejection must fail the step');
  });
});

describe('adcp-client#1709 — ResponseSchemaValidationError class shape', () => {
  test('carries toolName, issues, and data for diagnostic attribution', () => {
    const issues = [{ code: 'invalid_type', path: ['x'], message: 'expected string' }];
    const data = { x: 42 };
    const err = new ResponseSchemaValidationError('foo_tool', issues, data, 'expected string');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ResponseSchemaValidationError);
    assert.equal(err.name, 'ResponseSchemaValidationError');
    assert.equal(err.toolName, 'foo_tool');
    assert.deepEqual(err.issues, issues);
    assert.deepEqual(err.data, data);
    assert.match(err.message, /foo_tool/);
    assert.match(err.message, /expected string/);
  });

  test('name field is the literal string so cross-bundle detection works without instanceof', () => {
    const err = new ResponseSchemaValidationError('x', [], null, 'whatever');
    assert.equal(err.name, 'ResponseSchemaValidationError', 'stable for string-based detection');
  });
});
