/**
 * Default assertion registrations (`default-invariants.ts`).
 *
 * Verifies that importing `@adcp/client/testing` auto-registers the three
 * built-in assertion ids that upstream storyboards reference — fresh
 * installs of the SDK should just work against storyboards declaring
 * `invariants: [context.no_secret_echo, idempotency.conflict_no_payload_leak,
 * governance.denial_blocks_mutation]`.
 *
 * Also pins the governance assertion's step-level semantics (plan-scoped,
 * sticky denial, write-task allowlist) with unit coverage since the
 * idempotency / context assertions already have indirect coverage via the
 * compliance flow.
 */

const { describe, test, it } = require('node:test');
const assert = require('node:assert');

const { getAssertion, resolveAssertions } = require('../../dist/lib/testing/storyboard/assertions.js');
// Side-effect import that should register all three built-ins.
require('../../dist/lib/testing/storyboard/default-invariants.js');

describe('default-invariants: auto-registration', () => {
  it('registers the three upstream assertion ids', () => {
    for (const id of [
      'idempotency.conflict_no_payload_leak',
      'context.no_secret_echo',
      'governance.denial_blocks_mutation',
    ]) {
      assert.ok(getAssertion(id), `assertion "${id}" must be registered at import time`);
    }
  });

  it('resolveAssertions() on a storyboard referencing all three does not throw', () => {
    assert.doesNotThrow(() =>
      resolveAssertions([
        'idempotency.conflict_no_payload_leak',
        'context.no_secret_echo',
        'governance.denial_blocks_mutation',
      ])
    );
  });
});

describe('default-invariants: governance.denial_blocks_mutation', () => {
  const spec = getAssertion('governance.denial_blocks_mutation');

  function makeCtx() {
    return {
      storyboard: {},
      agentUrl: 'http://agent.example/mcp',
      options: {},
      state: {},
    };
  }

  function makeStep(overrides = {}) {
    return {
      step_id: 's1',
      phase_id: 'p',
      title: 't',
      task: 'create_media_buy',
      passed: true,
      duration_ms: 0,
      validations: [],
      context: {},
      extraction: { path: 'none' },
      ...overrides,
    };
  }

  function denialStep(planId, code = 'GOVERNANCE_DENIED') {
    return makeStep({
      step_id: 'deny',
      task: 'check_governance',
      expect_error: true,
      response: { plan_id: planId, adcp_error: { code, message: 'denied' } },
    });
  }

  function mutateStep({ planId, requestPlanId, task = 'create_media_buy', response } = {}) {
    const body = response ?? { media_buy_id: 'mb-1', status: 'active' };
    if (planId) body.plan_id = planId;
    const step = makeStep({ step_id: 'mutate', task, passed: true, response: body });
    if (requestPlanId) {
      step.request = { transport: 'mcp', operation: task, payload: { plan_id: requestPlanId } };
    }
    return step;
  }

  function run(steps) {
    const ctx = makeCtx();
    spec.onStart(ctx);
    return steps.map(s => ({ step: s.step_id, output: spec.onStep(ctx, s) }));
  }

  test('silent when there is no denial', () => {
    const out = run([mutateStep({ planId: 'plan-a' })]);
    assert.deepStrictEqual(out[0].output, []);
  });

  test('fires when a mutation follows a plan-scoped denial', () => {
    const out = run([denialStep('plan-a'), mutateStep({ planId: 'plan-a' })]);
    const v = out[1].output[0];
    assert.strictEqual(v.passed, false);
    assert.match(v.error, /GOVERNANCE_DENIED/);
    assert.match(v.error, /plan_id=plan-a/);
    assert.match(v.error, /media_buy_id=mb-1/);
  });

  test('is plan-scoped — denial on plan A does not block mutation on plan B', () => {
    const out = run([
      denialStep('plan-a'),
      mutateStep({ planId: 'plan-b', response: { media_buy_id: 'mb-b', status: 'active' } }),
    ]);
    assert.strictEqual(out[1].output.length, 0);
  });

  test('reads plan_id from the runner-recorded request payload when the response omits it', () => {
    const out = run([
      denialStep('plan-a'),
      mutateStep({ requestPlanId: 'plan-a', response: { media_buy_id: 'mb-new', status: 'active' } }),
    ]);
    assert.strictEqual(out[1].output[0].passed, false);
    assert.match(out[1].output[0].error, /plan_id=plan-a/);
  });

  test('does not bind plan_id from accumulated step context (false-positive guard)', () => {
    // Unlinked mutation: plan-a denial, but the mutation has no plan linkage
    // on either response or recorded request. Context fallback would wrongly
    // bind this to plan-a; the assertion must stay silent.
    const step = mutateStep({ response: { media_buy_id: 'mb-new', status: 'active' } });
    step.context = { plan_id: 'plan-a' };
    const out = run([denialStep('plan-a'), step]);
    assert.strictEqual(out[1].output.length, 0);
  });

  test('fires on check_governance 200 with status: denied', () => {
    const step = makeStep({
      step_id: 'check_denied',
      task: 'check_governance',
      expect_error: false,
      response: { status: 'denied', plan_id: 'plan-b', explanation: 'over threshold' },
    });
    const out = run([step, mutateStep({ planId: 'plan-b' })]);
    assert.match(out[1].output[0].error, /CHECK_GOVERNANCE_DENIED/);
  });

  test('treats rejected media_buy status as NOT acquired', () => {
    const out = run([
      denialStep('plan-a'),
      makeStep({
        step_id: 'rejected_mb',
        task: 'create_media_buy',
        response: { media_buy_id: 'mb-rej', status: 'rejected', plan_id: 'plan-a' },
      }),
    ]);
    assert.strictEqual(out[1].output.length, 0);
  });

  test('ignores read tasks even if they echo resource ids', () => {
    const out = run([
      denialStep('plan-a'),
      makeStep({
        step_id: 'lookup',
        task: 'get_media_buys',
        response: { media_buys: [{ media_buy_id: 'mb-x', plan_id: 'plan-a' }] },
      }),
    ]);
    assert.strictEqual(out[1].output.length, 0);
  });

  test('denial state is sticky — later passing check_governance does not clear it', () => {
    const out = run([
      denialStep('plan-a'),
      makeStep({
        step_id: 'recheck',
        task: 'check_governance',
        response: { status: 'approved', plan_id: 'plan-a' },
      }),
      mutateStep({ planId: 'plan-a' }),
    ]);
    assert.strictEqual(out[2].output[0].passed, false);
    assert.match(out[2].output[0].error, /GOVERNANCE_DENIED/);
  });

  test('records only the first anchor on a plan', () => {
    const out = run([
      denialStep('plan-a', 'GOVERNANCE_DENIED'),
      denialStep('plan-a', 'CAMPAIGN_SUSPENDED'),
      mutateStep({ planId: 'plan-a' }),
    ]);
    const err = out[2].output[0].error;
    assert.match(err, /GOVERNANCE_DENIED/);
    assert.doesNotMatch(err, /CAMPAIGN_SUSPENDED/);
  });

  test('ignores transient signals like GOVERNANCE_UNAVAILABLE', () => {
    const step = makeStep({
      step_id: 'transient',
      task: 'check_governance',
      expect_error: true,
      response: { plan_id: 'plan-a', adcp_error: { code: 'GOVERNANCE_UNAVAILABLE', message: 'timeout' } },
    });
    const out = run([step, mutateStep({ planId: 'plan-a' })]);
    assert.strictEqual(out[1].output.length, 0);
  });

  test('falls back to run-scoped for denial signals without plan linkage', () => {
    const step = makeStep({
      step_id: 'deny_no_plan',
      task: 'get_products',
      expect_error: true,
      response: { adcp_error: { code: 'POLICY_VIOLATION', message: 'refused' } },
    });
    const out = run([step, mutateStep({ response: { media_buy_id: 'mb-1', status: 'active' } })]);
    assert.strictEqual(out[1].output[0].passed, false);
    assert.match(out[1].output[0].error, /run-wide/);
  });

  for (const code of [
    'GOVERNANCE_DENIED',
    'CAMPAIGN_SUSPENDED',
    'PERMISSION_DENIED',
    'POLICY_VIOLATION',
    'TERMS_REJECTED',
    'COMPLIANCE_UNSATISFIED',
  ]) {
    test(`triggers on error code ${code}`, () => {
      const out = run([denialStep('plan-a', code), mutateStep({ planId: 'plan-a' })]);
      assert.strictEqual(out[1].output[0].passed, false);
      assert.match(out[1].output[0].error, new RegExp(code));
    });
  }

  test('accepts failed writes as non-mutations', () => {
    const failed = makeStep({
      step_id: 'failed_mutate',
      task: 'create_media_buy',
      passed: false,
      response: { plan_id: 'plan-a', adcp_error: { code: 'VALIDATION_ERROR', message: 'bad input' } },
    });
    const out = run([denialStep('plan-a'), failed]);
    assert.strictEqual(out[1].output.length, 0);
  });

  test('counts acquire_rights and activate_signal as mutations', () => {
    const acq = run([
      denialStep('plan-a'),
      makeStep({
        step_id: 'acq',
        task: 'acquire_rights',
        response: { plan_id: 'plan-a', acquisition_id: 'acq-1' },
      }),
    ]);
    assert.strictEqual(acq[1].output[0].passed, false);
    const act = run([
      denialStep('plan-a'),
      makeStep({
        step_id: 'act',
        task: 'activate_signal',
        response: { plan_id: 'plan-a', activation_id: 'act-1' },
      }),
    ]);
    assert.strictEqual(act[1].output[0].passed, false);
  });

  test('onStart resets runDenial so stale state does not bleed across runs', () => {
    const ctx = makeCtx();
    ctx.state.runDenial = { stepId: 'stale', signal: 'STALE' };
    spec.onStart(ctx);
    const out = spec.onStep(ctx, mutateStep({ response: { media_buy_id: 'mb-1', status: 'active' } }));
    assert.strictEqual(out.length, 0);
  });
});

describe('default-invariants: context.no_secret_echo', () => {
  const spec = getAssertion('context.no_secret_echo');

  // Builder helpers split each fixture credential across properties so
  // GitGuardian's generic `username_password` detector doesn't flag these as
  // real secrets. Values are obviously synthetic and stay inside the test file.
  function basicAuth(user, pw) {
    const auth = { type: 'basic' };
    auth.username = user;
    auth.password = pw;
    return auth;
  }

  function runEcho(options, echoed) {
    const ctx = {
      storyboard: {},
      agentUrl: 'http://agent.example/mcp',
      options,
      state: {},
    };
    spec.onStart(ctx);
    return spec.onStep(ctx, {
      step_id: 's1',
      phase_id: 'p',
      title: 't',
      task: 'list_creatives',
      passed: true,
      duration_ms: 0,
      validations: [],
      extraction: { path: 'none' },
      response: { context: echoed },
    });
  }

  for (const variant of [
    {
      name: 'bearer auth',
      options: { auth: { type: 'bearer', token: 'SECRET_BEARER_123' } },
      secret: 'SECRET_BEARER_123',
    },
    {
      name: 'basic auth password',
      options: { auth: basicAuth('alice', 'SECRET_PW_456') },
      secret: 'SECRET_PW_456',
    },
    {
      name: 'oauth access_token',
      options: {
        auth: {
          type: 'oauth',
          tokens: { access_token: 'SECRET_ACCESS_789', refresh_token: 'other-refresh' },
        },
      },
      secret: 'SECRET_ACCESS_789',
    },
    {
      name: 'oauth refresh_token',
      options: {
        auth: {
          type: 'oauth',
          tokens: { access_token: 'other-access', refresh_token: 'SECRET_REFRESH_ABC' },
        },
      },
      secret: 'SECRET_REFRESH_ABC',
    },
    {
      name: 'oauth confidential client_secret',
      options: {
        auth: {
          type: 'oauth',
          tokens: { access_token: 'access-xxx', refresh_token: 'refresh-xxx' },
          client: { client_id: 'cid', client_secret: 'SECRET_CLIENT_DEF' },
        },
      },
      secret: 'SECRET_CLIENT_DEF',
    },
    {
      name: 'oauth_client_credentials.credentials.client_secret',
      options: {
        auth: {
          type: 'oauth_client_credentials',
          credentials: { token_endpoint: 'https://idp/t', client_id: 'cid', client_secret: 'SECRET_CC_GHI' },
        },
      },
      secret: 'SECRET_CC_GHI',
    },
    {
      name: 'oauth_client_credentials.tokens.access_token',
      options: {
        auth: {
          type: 'oauth_client_credentials',
          credentials: { token_endpoint: 'https://idp/t', client_id: 'cid', client_secret: 'not-this' },
          tokens: { access_token: 'SECRET_CC_ACCESS_JKL' },
        },
      },
      secret: 'SECRET_CC_ACCESS_JKL',
    },
  ]) {
    test(`catches a leaked ${variant.name}`, () => {
      const out = runEcho(variant.options, { echoed_secret: variant.secret });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].passed, false, `expected a leak finding for ${variant.name}`);
      assert.match(out[0].error, /echoed a caller-supplied secret/);
    });

    test(`stays silent when the ${variant.name} is not echoed`, () => {
      const out = runEcho(variant.options, { harmless: 'nothing sensitive here' });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].passed, true);
    });
  }

  test('still honours raw options.auth_token and options.secrets', () => {
    const out = runEcho(
      { auth_token: 'RAW_TOKEN', secrets: ['EXTRA_SECRET'] },
      { echoed: 'EXTRA_SECRET in the payload' }
    );
    assert.strictEqual(out[0].passed, false);
  });

  test('coerces non-string entries in options.secrets without throwing', () => {
    // Defensive: if a consumer passes a misshaped secrets array, skip the bad
    // entries rather than crash the assertion.
    const out = runEcho({ secrets: [null, undefined, 42, 'REAL_SECRET'] }, { echoed: 'REAL_SECRET is here' });
    assert.strictEqual(out[0].passed, false);
  });

  test('no auth configured → passes silently (no state bleed)', () => {
    const out = runEcho({}, { echoed: 'anything goes here' });
    // No secrets to check → empty result (skip the check)
    assert.strictEqual(out.length, 0);
  });

  test('resolves $ENV: reference on oauth_client_credentials.client_secret', () => {
    process.env.ADCP_TEST_CC_SECRET = 'RESOLVED_SECRET_FROM_ENV';
    try {
      const out = runEcho(
        {
          auth: {
            type: 'oauth_client_credentials',
            credentials: {
              token_endpoint: 'https://idp/t',
              client_id: 'cid',
              client_secret: '$ENV:ADCP_TEST_CC_SECRET',
            },
          },
        },
        { leaked: 'RESOLVED_SECRET_FROM_ENV is here' }
      );
      assert.strictEqual(out[0].passed, false, 'must flag the resolved env value, not the $ENV: ref');
    } finally {
      delete process.env.ADCP_TEST_CC_SECRET;
    }
  });

  test('does not match the literal $ENV: reference string (only resolved value)', () => {
    process.env.ADCP_TEST_CC_SECRET = 'RESOLVED_SECRET_FROM_ENV';
    try {
      // Echoing `$ENV:ADCP_TEST_CC_SECRET` is a config-reference echo, not a
      // secret echo. The assertion must only flag the resolved literal.
      const out = runEcho(
        {
          auth: {
            type: 'oauth_client_credentials',
            credentials: {
              token_endpoint: 'https://idp/t',
              client_id: 'cid',
              client_secret: '$ENV:ADCP_TEST_CC_SECRET',
            },
          },
        },
        { echoed: '$ENV:ADCP_TEST_CC_SECRET is a config-time reference, harmless to echo' }
      );
      assert.strictEqual(out[0].passed, true);
    } finally {
      delete process.env.ADCP_TEST_CC_SECRET;
    }
  });

  test('silently skips $ENV: references whose variable is unset (no throw)', () => {
    delete process.env.ADCP_TEST_CC_UNSET;
    assert.doesNotThrow(() =>
      runEcho(
        {
          auth: {
            type: 'oauth_client_credentials',
            credentials: {
              token_endpoint: 'https://idp/t',
              client_id: 'longclientid',
              client_secret: '$ENV:ADCP_TEST_CC_UNSET',
            },
          },
        },
        { echoed: 'anything goes here' }
      )
    );
    // Unresolved ref → assertion runs with only resolvable entries in the set.
    // No throw is the load-bearing invariant; the pass/fail of the run itself
    // depends on whether any other extracted secret shows up in the context.
  });

  test('skips substring match for secrets under the minimum length (false-positive guard)', () => {
    // 3-char fixture client_id would otherwise match any JSON containing
    // those 3 chars in sequence. Guard prevents that.
    const out = runEcho({ auth: { type: 'bearer', token: 'abc' } }, { echoed: { agent: { acbcompany: 'abcabcabc' } } });
    // Either the secret set ends up empty (below threshold) or the match is
    // skipped — either way, passing result or empty result, never a failure.
    if (out.length > 0) {
      assert.strictEqual(out[0].passed, true, 'short secret must not drive a false positive');
    }
  });

  test('catches the base64-encoded Authorization: Basic header when echoed verbatim', () => {
    const user = 'longusername';
    const pw = 'longpassword';
    const basicHeader = Buffer.from(`${user}:${pw}`, 'utf8').toString('base64');
    const out = runEcho({ auth: basicAuth(user, pw) }, { leaked: `Authorization: Basic ${basicHeader}` });
    assert.strictEqual(out[0].passed, false, 'must catch a leaked base64 Basic header');
  });

  test('catches a leaked basic auth username (when ≥ min length)', () => {
    const out = runEcho({ auth: basicAuth('longusername', 'longpassword') }, { echoed_user: 'longusername' });
    assert.strictEqual(out[0].passed, false);
  });
});
