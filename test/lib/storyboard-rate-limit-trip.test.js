const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');
const { registerAssertion } = require('../../dist/lib/testing/storyboard/assertions');
const { extractFailures } = require('../../dist/lib/testing/compliance/comply');
const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks');
const { formatStoryboardResultsAsJUnit } = require('../../dist/lib/testing/storyboard/junit');
const { ResponseTooLargeError, ValidationError } = require('../../dist/lib/errors');
const rootExports = require('../../dist/lib/index');
const testingExports = require('../../dist/lib/testing/index');
const {
  RateLimitTripObserver,
  validateRateLimitTripSpec,
} = require('../../dist/lib/testing/storyboard/rate-limit-trip');

function rateLimited(retryAfter = 0.001) {
  return {
    success: false,
    data: {
      adcp_error: {
        code: 'RATE_LIMITED',
        message: 'slow down',
        retry_after: retryAfter,
      },
    },
    error: 'RATE_LIMITED: slow down',
  };
}

function makeStoryboard(overrides = {}) {
  return {
    id: 'rate_limit_trip_storyboard',
    version: '1.0.0',
    title: 'Rate limit trip replay',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p1',
        title: 'phase 1',
        steps: [
          {
            id: 'trip',
            title: 'rate limit replay is not cached',
            task: 'expect_rate_limit_not_replayed',
            requires_contract: 'rate_limit_trip_runner',
            rate_limit_trip: {
              trip_target_task: 'create_media_buy',
              trip_target_sample_request: {
                buyer_ref: 'buyer-rate-limit-test',
                packages: [{ product_id: 'prod_1', budget: 1000 }],
              },
              max_attempts: 50,
              replay_max_wait_seconds: 1,
              ...overrides.rate_limit_trip,
            },
            validations: [
              {
                check: 'replay_not_cached_rate_limit',
                description: 'RATE_LIMITED is not cached as the idempotent replay response',
              },
            ],
            ...overrides.step,
          },
        ],
      },
    ],
  };
}

function runTripStep(client, storyboard = makeStoryboard(), options = {}) {
  return runStoryboardStep('https://stub.example/mcp', storyboard, 'trip', {
    protocol: 'mcp',
    _client: client,
    _profile: { name: 'stub', tools: ['create_media_buy'] },
    contracts: ['rate_limit_trip_runner'],
    allowLiveSideEffects: true,
    ...options,
  });
}

describe('RateLimitTripObserver', () => {
  test('public root and testing entrypoints export the observer surface', () => {
    assert.equal(rootExports.RateLimitTripObserver, RateLimitTripObserver);
    assert.equal(testingExports.RateLimitTripObserver, RateLimitTripObserver);
    assert.equal(rootExports.RATE_LIMIT_TRIP_CONTRACT, 'rate_limit_trip_runner');
    assert.equal(testingExports.RATE_LIMIT_TRIP_MAX_ATTEMPTS_MIN, 50);
  });

  test('validates the contract max_attempts bounds', () => {
    const error = validateRateLimitTripSpec({
      trip_target_task: 'create_media_buy',
      trip_target_sample_request: {},
      max_attempts: 49,
    });
    assert.match(error, /max_attempts must be in \[50, 500\]/);
  });

  test('runs trip plus clean replay on the public primitive', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        if (calls.length === 2) return rateLimited();
        return { success: true, data: { media_buy_id: `mb_${calls.length}` } };
      },
    };
    const observer = new RateLimitTripObserver(client, {
      keyMinter: () => `key_${calls.length + 1}`,
      sleep: async () => {},
      correlationPrefix: 'direct',
    });

    const result = await observer.run({
      trip_target_task: 'create_media_buy',
      trip_target_sample_request: { buyer_ref: 'buyer_1' },
      max_attempts: 50,
      replay_max_wait_seconds: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.body.rate_limited_request.idempotency_key, 'key_2');
    assert.equal(result.body.trip_response.error.code, 'RATE_LIMITED');
    assert.equal(result.body.replay_response.success, true);
    assert.equal(calls[1].idempotency_key, calls[2].idempotency_key);
    assert.notEqual(calls[0].idempotency_key, calls[1].idempotency_key);
    assert.equal(calls[2].context.correlation_id, 'direct#replay');
  });

  test('honors retry_after from errors[0].details on legacy envelopes', async () => {
    let calls = 0;
    const client = {
      executeTask: async () => {
        calls++;
        if (calls === 1) {
          return {
            success: false,
            data: {
              errors: [{ code: 'RATE_LIMITED', message: 'slow down', details: { retry_after: 0.001 } }],
            },
          };
        }
        return { success: true, data: { media_buy_id: 'mb_replay' } };
      },
    };
    const observer = new RateLimitTripObserver(client, {
      keyMinter: () => 'trip_key',
      sleep: async () => {},
    });

    const result = await observer.run({
      trip_target_task: 'create_media_buy',
      trip_target_sample_request: { buyer_ref: 'buyer_1' },
      max_attempts: 50,
      replay_max_wait_seconds: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.body.trip_response.error.details.retry_after, 0.001);
    assert.equal(result.body.replay_response.success, true);
  });

  test('fails fast when target returns a structured non-rate-limit AdCP error', async () => {
    let calls = 0;
    const client = {
      executeTask: async () => {
        calls++;
        return {
          success: false,
          data: {
            adcp_error: {
              code: 'VALIDATION_ERROR',
              message: 'packages[0].product_id is required',
            },
          },
          error: 'VALIDATION_ERROR: packages[0].product_id is required',
        };
      },
    };
    const observer = new RateLimitTripObserver(client, {
      keyMinter: () => `key_${calls + 1}`,
      sleep: async () => {},
    });

    const result = await observer.run({
      trip_target_task: 'create_media_buy',
      trip_target_sample_request: { buyer_ref: 'buyer_1' },
      max_attempts: 50,
      replay_max_wait_seconds: 1,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'rate_limit_trip_request_error');
    assert.equal(result.body.attempts, 1);
    assert.equal(result.body.trip_response.error.code, 'VALIDATION_ERROR');
    assert.equal(calls, 1);
  });

  test('ignores advisory errors on submitted task payloads', async () => {
    let calls = 0;
    const client = {
      executeTask: async () => {
        calls++;
        if (calls === 1) {
          return {
            success: true,
            data: {
              status: 'submitted',
              task_id: 'task-advisory',
              errors: [{ code: 'GOVERNANCE_OBSERVATION', message: 'queued with advisory' }],
            },
          };
        }
        if (calls === 2) return rateLimited();
        return { success: true, data: { media_buy_id: 'mb_replay' } };
      },
    };
    const observer = new RateLimitTripObserver(client, {
      keyMinter: () => `key_${calls + 1}`,
      sleep: async () => {},
    });

    const result = await observer.run({
      trip_target_task: 'create_media_buy',
      trip_target_sample_request: { buyer_ref: 'buyer_1' },
      max_attempts: 50,
      replay_max_wait_seconds: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.body.attempts, 2);
    assert.equal(result.body.trip_response.error.code, 'RATE_LIMITED');
    assert.equal(calls, 3);
  });
});

describe('storyboard rate_limit_trip_runner wiring', () => {
  test('missing contract skips before dispatch even when live side effects are authorized', async () => {
    let calls = 0;
    const client = {
      executeTask: async () => {
        calls += 1;
        throw new Error('should not dispatch without the contract');
      },
    };

    const result = await runStoryboardStep('https://stub.example/mcp', makeStoryboard(), 'trip', {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'stub', tools: ['create_media_buy'] },
      allowLiveSideEffects: true,
    });

    assert.equal(result.passed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'missing_test_kit_contract');
    assert.equal(result.skip.reason, 'unsatisfied_contract');
    assert.equal(calls, 0);
  });

  test('contract without live-side-effect authorization skips before dispatch', async () => {
    let calls = 0;
    const client = {
      executeTask: async () => {
        calls += 1;
        throw new Error('should not dispatch without explicit authorization');
      },
    };

    const result = await runStoryboardStep('https://stub.example/mcp', makeStoryboard(), 'trip', {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'stub', tools: ['create_media_buy'] },
      contracts: ['rate_limit_trip_runner'],
    });

    assert.equal(result.passed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'live_side_effect_opt_in_required');
    assert.equal(result.skip.reason, 'unsatisfied_contract');
    assert.match(result.skip.detail, /allowLiveSideEffects: true/);
    assert.equal(calls, 0);
  });

  test('the pseudo-task requires the exact contract even when storyboard metadata omits or misnames it', async () => {
    for (const scenario of [
      { label: 'omitted', step: { requires_contract: undefined }, contracts: [] },
      { label: 'mismatched', step: { requires_contract: 'other_runner' }, contracts: ['other_runner'] },
    ]) {
      let calls = 0;
      const client = {
        executeTask: async () => {
          calls += 1;
          throw new Error(`should not dispatch with ${scenario.label} contract metadata`);
        },
      };
      const result = await runStoryboardStep(
        'https://stub.example/mcp',
        makeStoryboard({ step: scenario.step }),
        'trip',
        {
          protocol: 'mcp',
          _client: client,
          _profile: { name: 'stub', tools: ['create_media_buy'] },
          contracts: scenario.contracts,
          allowLiveSideEffects: true,
        }
      );

      assert.equal(result.passed, true, scenario.label);
      assert.equal(result.skipped, true, scenario.label);
      assert.equal(result.skip_reason, 'missing_test_kit_contract', scenario.label);
      assert.equal(result.skip.reason, 'unsatisfied_contract', scenario.label);
      assert.match(result.skip.detail, /rate_limit_trip_runner/, scenario.label);
      assert.equal(calls, 0, scenario.label);
    }
  });

  test('contract plus live-side-effect authorization runs the observer and passes replay validation', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        if (calls.length === 2) return rateLimited();
        return { success: true, data: { media_buy_id: `mb_${calls.length}` } };
      },
    };

    const result = await runTripStep(client);

    assert.equal(result.passed, true);
    assert.equal(result.validations[0].passed, true);
    assert.equal(result.response.body.trip_response.error.code, 'RATE_LIMITED');
    assert.equal(result.response.body.replay_response.success, true);
    assert.equal(result.request.transport, 'mcp');
    assert.equal(result.request.operation, 'create_media_buy');
    assert.equal(result.request.payload.buyer_ref, 'buyer-rate-limit-test');
    assert.deepEqual(result.request.payload, calls[2], 'request record reflects the actual replay dispatch');
    assert.equal(result.response.status, undefined);
    assert.equal(result.response_record.transport, 'mcp');
    assert.equal(result.response_record.status, undefined);
    assert.equal(result.response_record.payload.target_task, 'create_media_buy');
    assert.equal(result.response_record.payload.target_transport, 'mcp');
    assert.deepEqual(result.response_record.payload.trip_request, calls[1]);
    assert.deepEqual(result.response_record.payload.replay_request, calls[2]);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].idempotency_key, calls[2].idempotency_key);
    assert.notEqual(calls[0].idempotency_key, calls[1].idempotency_key);
    assert.equal(calls[1].context.correlation_id, 'trip#trip-2');
    assert.equal(calls[2].context.correlation_id, 'trip#replay');
  });

  test('a2a run records target task transport without synthetic status', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        if (calls.length === 1) return rateLimited();
        return { success: true, data: { media_buy_id: 'mb_replay' } };
      },
    };

    const result = await runTripStep(client, makeStoryboard(), { protocol: 'a2a' });

    assert.equal(result.passed, true);
    assert.equal(result.request.transport, 'a2a');
    assert.equal(result.request.operation, 'create_media_buy');
    assert.deepEqual(result.request.payload, calls[1]);
    assert.equal(result.response.status, undefined);
    assert.equal(result.response_record.transport, 'a2a');
    assert.equal(result.response_record.status, undefined);
    assert.equal(result.response_record.payload.target_transport, 'a2a');
    assert.deepEqual(result.response_record.payload.trip_request, calls[0]);
    assert.deepEqual(result.response_record.payload.replay_request, calls[1]);
  });

  test('cached RATE_LIMITED replay fails replay_not_cached_rate_limit', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        return rateLimited();
      },
    };

    const result = await runTripStep(client);

    assert.equal(result.passed, false);
    assert.equal(result.validations[0].passed, false);
    assert.equal(result.validations[0].error, 'rate_limit_response_cached_as_replay');
    assert.equal(result.validations[0].actual, 'RATE_LIMITED');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].idempotency_key, calls[1].idempotency_key);
  });

  test('advisory RATE_LIMITED errors on submitted replay do not fail replay validation', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        if (calls.length === 1) return rateLimited();
        return {
          success: true,
          data: {
            status: 'submitted',
            task_id: 'task-advisory-replay',
            errors: [{ code: 'RATE_LIMITED', message: 'queued with advisory' }],
          },
        };
      },
    };

    const result = await runTripStep(client);

    assert.equal(result.passed, true);
    assert.equal(result.validations[0].passed, true);
    assert.equal(result.response_record.payload.replay_response.error, undefined);
    assert.equal(calls.length, 2);
  });

  test('no RATE_LIMITED emits the canonical not-applicable skip result without validations', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        return { success: true, data: { media_buy_id: `mb_${calls.length}` } };
      },
    };

    const result = await runTripStep(client);

    assert.equal(result.passed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'rate_limit_not_triggered');
    assert.equal(result.skip.reason, 'not_applicable');
    assert.equal(result.skip.detail, 'rate_limit_not_triggered');
    assert.deepEqual(result.validations, []);
    assert.match(result.response.error, /No RATE_LIMITED response observed/);
    assert.equal(calls.length, 50);
    assert.equal(new Set(calls.map(c => c.idempotency_key)).size, 50);
    assert.deepEqual(result.request.payload, calls[49]);
    assert.equal(result.response_record.payload.trip_request.context.correlation_id, 'trip#trip-50');
  });

  test('full storyboard run preserves the exhaustion skip and aggregate counters', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        return { success: true, data: { media_buy_id: `mb_${calls.length}` } };
      },
    };

    const result = await runStoryboard('https://stub.example/mcp', makeStoryboard(), {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'stub', tools: ['create_media_buy'] },
      agentTools: ['create_media_buy'],
      contracts: ['rate_limit_trip_runner'],
      allowLiveSideEffects: true,
    });
    const step = result.phases[0].steps[0];

    assert.equal(step.passed, true);
    assert.equal(step.skipped, true);
    assert.equal(step.skip.reason, 'not_applicable');
    assert.equal(step.skip.detail, 'rate_limit_not_triggered');
    assert.deepEqual(step.validations, []);
    assert.equal(result.overall_passed, true);
    assert.equal(result.passed_count, 0);
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 1);
    assert.ok(result.assertions.length > 0, 'step assertions still execute for the skipped probe');
    assert.ok(result.assertions.every(assertion => assertion.passed));
    assert.equal(calls.length, 50);
  });

  test('full run surfaces a failing assertion without changing the exhaustion skip tuple', async () => {
    const assertionId = 'test.rate_limit_exhaustion_failure';
    registerAssertion({
      id: assertionId,
      description: 'test-only rate-limit exhaustion assertion',
      onStep: async (_context, step) =>
        step.skip_reason === 'rate_limit_not_triggered'
          ? [{ passed: false, description: 'rate-limit policy assertion failed', error: 'policy failure' }]
          : [],
    });

    const storyboard = makeStoryboard();
    storyboard.track = 'error_handling';
    storyboard.invariants = { enable: [assertionId] };
    storyboard.phases[0].steps[0].expected = 'Rate-limit exhaustion is not a failed replay check.';
    const client = {
      executeTask: async () => ({ success: true, data: { media_buy_id: 'mb_no_limit' } }),
    };
    const result = await runStoryboard('https://stub.example/mcp', storyboard, {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'stub', tools: ['create_media_buy'] },
      agentTools: ['create_media_buy'],
      contracts: ['rate_limit_trip_runner'],
      allowLiveSideEffects: true,
    });
    const step = result.phases[0].steps[0];

    assert.equal(step.passed, true);
    assert.equal(step.skipped, true);
    assert.equal(step.skip.detail, 'rate_limit_not_triggered');
    assert.deepEqual(step.validations, []);
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.overall_passed, false);
    assert.ok(result.assertions.some(assertion => assertion.assertion_id === assertionId && !assertion.passed));

    const track = mapStoryboardResultsToTrackResult('error_handling', [result], {
      name: 'stub',
      tools: [],
    });
    assert.equal(track.status, 'fail');
    const observation = track.observations.find(observation => observation.evidence.assertion_id === assertionId);
    assert.equal(observation.source.kind, 'storyboard_step');
    assert.equal(observation.source.storyboard_id, storyboard.id);
    assert.equal(observation.source.step_id, 'trip');

    const failures = extractFailures([result], [storyboard], 'https://stub.example/mcp');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].step_id, 'trip');
    assert.equal(failures[0].expected, 'Rate-limit exhaustion is not a failed replay check.');
    assert.equal(failures[0].validation.check, 'assertion');

    const junit = formatStoryboardResultsAsJUnit([result]);
    assert.match(junit, /<testsuites\b[^>]+failures="1"/);
    assert.match(junit, /<testsuite\b[^>]+failures="1"/);
    assert.match(junit, /type="StoryboardAssertionFailure"/);
  });

  test('uses normal request enrichment for sentinel product and pricing ids', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        return rateLimited();
      },
    };
    const storyboard = makeStoryboard({
      rate_limit_trip: {
        trip_target_sample_request: {
          buyer_ref: 'buyer-rate-limit-test',
          packages: [{ product_id: 'test-product', pricing_option_id: 'test-pricing', budget: 1000 }],
        },
      },
    });

    await runStoryboardStep('https://stub.example/mcp', storyboard, 'trip', {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'stub', tools: ['create_media_buy'] },
      contracts: ['rate_limit_trip_runner'],
      allowLiveSideEffects: true,
      context: {
        products: [{ product_id: 'prod_real', pricing_options: [{ pricing_option_id: 'price_real' }] }],
      },
    });

    assert.equal(calls[0].packages[0].product_id, 'prod_real');
    assert.equal(calls[0].packages[0].pricing_option_id, 'price_real');
  });

  test('redacts secret-like fields from legacy response and response_record', async () => {
    const client = {
      executeTask: async () => ({
        success: false,
        data: {
          adcp_error: {
            code: 'RATE_LIMITED',
            message: 'slow down',
            retry_after: 0.001,
            details: { access_token: 'secret-token' },
          },
          access_token: 'secret-token',
        },
      }),
    };

    const result = await runTripStep(client);

    assert.equal(result.response.body.trip_response.data.access_token, '[redacted]');
    assert.equal(result.response.body.trip_response.error.details.access_token, '[redacted]');
    assert.equal(result.response_record.payload.trip_response.data.access_token, '[redacted]');
  });

  test('missing trip target tool uses standard missing_tool skip', async () => {
    const client = {
      executeTask: async () => {
        throw new Error('should not dispatch');
      },
    };

    const result = await runStoryboardStep('https://stub.example/mcp', makeStoryboard(), 'trip', {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'stub', tools: ['get_products'] },
      contracts: ['rate_limit_trip_runner'],
      allowLiveSideEffects: true,
    });

    assert.equal(result.passed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'missing_tool');
    assert.equal(result.skip.reason, 'missing_tool');
  });

  test('transport throw returns a failed step instead of aborting the run', async () => {
    const client = {
      executeTask: async () => {
        throw new Error('network down');
      },
    };

    const result = await runTripStep(client);

    assert.equal(result.passed, false);
    assert.match(result.error, /network down/);
    assert.equal(result.response.body.error, 'rate_limit_trip_transport_error');
  });

  test('request override feeds the rate-limit target request', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        return rateLimited();
      },
    };

    const result = await runTripStep(client, makeStoryboard(), {
      request: { buyer_ref: 'override-ref', packages: [{ product_id: 'override-prod', budget: 1234 }] },
    });

    assert.equal(result.passed, false);
    assert.equal(calls[0].buyer_ref, 'override-ref');
    assert.equal(calls[0].packages[0].product_id, 'override-prod');
    assert.equal(result.response_record.payload.trip_request.buyer_ref, 'override-ref');
  });

  test('unresolved runner tokens in the rate-limit target request skip before dispatch', async () => {
    const client = {
      executeTask: async () => {
        throw new Error('should not dispatch unresolved runner tokens');
      },
    };

    const result = await runTripStep(client, makeStoryboard(), {
      request: {
        buyer_ref: 'override-ref',
        packages: [{ product_id: 'override-prod', budget: 1234 }],
        push_notification_config: {
          url: 'https://hooks.example/{{runner.webhook_url:trip}}/{{prior_step.missing.operation_id}}',
        },
      },
    });

    assert.equal(result.passed, false);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'prerequisite_failed');
    assert.match(result.skip.detail, /runner\.webhook_url:trip/);
    assert.match(result.skip.detail, /prior_step\.missing\.operation_id/);
  });

  test('expect_error trip target preserves authored sample request without enrichment', async () => {
    const calls = [];
    const client = {
      executeTask: async (_taskName, params) => {
        calls.push(params);
        if (calls.length === 1) return rateLimited();
        return { success: true, data: { media_buy_id: 'mb_clean_replay' } };
      },
    };

    const result = await runTripStep(
      client,
      makeStoryboard({
        step: { expect_error: true },
        rate_limit_trip: {
          trip_target_sample_request: { buyer_ref: 'intentionally-invalid' },
        },
      })
    );

    assert.equal(result.passed, true);
    assert.equal(calls[0].buyer_ref, 'intentionally-invalid');
    assert.equal(calls[0].packages, undefined);
    assert.equal(result.response_record.payload.trip_request.packages, undefined);
  });

  test('client-side validation throw is classified separately from transport errors', async () => {
    const client = {
      executeTask: async () => {
        throw new ValidationError('packages[0].product_id', undefined, 'required');
      },
    };

    const result = await runTripStep(client);

    assert.equal(result.passed, false);
    assert.equal(result.response.body.error, 'rate_limit_trip_request_error');
  });

  test('transport-side SDK ADCP errors remain transport errors', async () => {
    const client = {
      executeTask: async () => {
        throw new ResponseTooLargeError(1024, 2048, 'https://stub.example/mcp');
      },
    };

    const result = await runTripStep(client);

    assert.equal(result.passed, false);
    assert.equal(result.response.body.error, 'rate_limit_trip_transport_error');
  });
});
