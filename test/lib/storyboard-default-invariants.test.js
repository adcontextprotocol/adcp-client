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
  it('registers the four upstream assertion ids', () => {
    for (const id of [
      'idempotency.conflict_no_payload_leak',
      'context.no_secret_echo',
      'governance.denial_blocks_mutation',
      'status.monotonic',
    ]) {
      assert.ok(getAssertion(id), `assertion "${id}" must be registered at import time`);
    }
  });

  it('resolveAssertions() on a storyboard referencing all four does not throw', () => {
    assert.doesNotThrow(() =>
      resolveAssertions([
        'idempotency.conflict_no_payload_leak',
        'context.no_secret_echo',
        'governance.denial_blocks_mutation',
        'status.monotonic',
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

  // All fixture secrets are ≥16 chars to clear the SECRET_MIN_LENGTH floor.
  for (const variant of [
    {
      name: 'bearer auth',
      options: { auth: { type: 'bearer', token: 'SECRET_BEARER_TOKEN_1234' } },
      secret: 'SECRET_BEARER_TOKEN_1234',
    },
    {
      name: 'basic auth password',
      options: { auth: basicAuth('alice', 'SECRET_BASIC_PASSWORD_1234') },
      secret: 'SECRET_BASIC_PASSWORD_1234',
    },
    {
      name: 'oauth access_token',
      options: {
        auth: {
          type: 'oauth',
          tokens: { access_token: 'SECRET_OAUTH_ACCESS_TOKEN_1', refresh_token: 'other-refresh-fixture-val' },
        },
      },
      secret: 'SECRET_OAUTH_ACCESS_TOKEN_1',
    },
    {
      name: 'oauth refresh_token',
      options: {
        auth: {
          type: 'oauth',
          tokens: { access_token: 'other-access-fixture-val', refresh_token: 'SECRET_OAUTH_REFRESH_TOKEN' },
        },
      },
      secret: 'SECRET_OAUTH_REFRESH_TOKEN',
    },
    {
      name: 'oauth confidential client_secret',
      options: {
        auth: {
          type: 'oauth',
          tokens: {
            access_token: 'access-fixture-longenough',
            refresh_token: 'refresh-fixture-longenough',
          },
          client: { client_id: 'cid', client_secret: 'SECRET_OAUTH_CLIENT_SECRET' },
        },
      },
      secret: 'SECRET_OAUTH_CLIENT_SECRET',
    },
    {
      name: 'oauth_client_credentials.credentials.client_secret',
      options: {
        auth: {
          type: 'oauth_client_credentials',
          credentials: {
            token_endpoint: 'https://idp/t',
            client_id: 'cid',
            client_secret: 'SECRET_CLIENT_CREDS_SECRET',
          },
        },
      },
      secret: 'SECRET_CLIENT_CREDS_SECRET',
    },
    {
      name: 'oauth_client_credentials.tokens.access_token',
      options: {
        auth: {
          type: 'oauth_client_credentials',
          credentials: {
            token_endpoint: 'https://idp/t',
            client_id: 'cid',
            client_secret: 'not-this-fixture-value',
          },
          tokens: { access_token: 'SECRET_CC_ACCESS_TOKEN_JKL' },
        },
      },
      secret: 'SECRET_CC_ACCESS_TOKEN_JKL',
    },
  ]) {
    test(`catches a leaked ${variant.name}`, () => {
      const out = runEcho(variant.options, { echoed_secret: variant.secret });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].passed, false, `expected a leak finding for ${variant.name}`);
      assert.match(out[0].error, /caller-supplied secret/);
    });

    test(`stays silent when the ${variant.name} is not echoed`, () => {
      const out = runEcho(variant.options, { harmless: 'nothing sensitive here' });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].passed, true);
    });
  }

  test('still honours raw options.auth_token and options.secrets', () => {
    const out = runEcho(
      { auth_token: 'RAW_BEARER_FIXTURE_TOKEN_V1', secrets: ['EXTRA_SECRET_FIXTURE_VALUE'] },
      { echoed: 'EXTRA_SECRET_FIXTURE_VALUE in the payload' }
    );
    assert.strictEqual(out[0].passed, false);
  });

  test('coerces non-string entries in options.secrets without throwing', () => {
    // Defensive: if a consumer passes a misshaped secrets array, skip the bad
    // entries rather than crash the assertion.
    const out = runEcho(
      { secrets: [null, undefined, 42, 'REAL_SECRET_FIXTURE_VALUE_1'] },
      { echoed: 'REAL_SECRET_FIXTURE_VALUE_1 is here' }
    );
    assert.strictEqual(out[0].passed, false);
  });

  test('no auth configured → still runs whole-body scan, passes on clean response', () => {
    // Even with no caller-supplied secrets, the widened assertion scans for
    // bearer-token literals and suspect property names — that's the point of
    // the widening. On a benign body it just passes.
    const out = runEcho({}, { echoed: 'anything goes here' });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].passed, true);
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
    const user = 'fixtureusername';
    const pw = 'fixturepasswordlongenough';
    const basicHeader = Buffer.from(`${user}:${pw}`, 'utf8').toString('base64');
    const out = runEcho({ auth: basicAuth(user, pw) }, { leaked: `Authorization: Basic ${basicHeader}` });
    assert.strictEqual(out[0].passed, false, 'must catch a leaked base64 Basic header');
  });

  test('does NOT extract basic-auth username alone (RFC-like: username is a public identifier)', () => {
    // Username is a public identifier — welcome messages, audit logs, and
    // "last login by X" displays all legitimately echo it. Extracting it
    // alone would false-positive in realistic storyboards. The base64 blob
    // covers the genuine Authorization-header leak case.
    const out = runEcho(
      { auth: basicAuth('fixtureusername-unique-1234', 'fixturepasswordlongenough') },
      { echoed_user: 'fixtureusername-unique-1234' }
    );
    // Password and the base64 blob are extracted, but the bare username is
    // not — so echoing the username alone must not trip the assertion.
    assert.strictEqual(out[0].passed, true, 'username alone must not flag');
  });

  test('does NOT extract oauth_client_credentials.client_id (RFC 6749 §2.2: public identifier)', () => {
    // client_id is public by RFC 6749 §2.2 — echoes in token responses,
    // introspection payloads, audit logs, and error bodies are intentional.
    // Extracting it would false-positive any IdP that echoes the requesting
    // client back in its responses.
    const out = runEcho(
      {
        auth: {
          type: 'oauth_client_credentials',
          credentials: {
            token_endpoint: 'https://idp/t',
            client_id: 'public-client-id-fixture-1234',
            client_secret: 'SECRET_FIXTURE_LONGENOUGH',
          },
        },
      },
      { token_response: { client_id: 'public-client-id-fixture-1234', audience: 'svc' } }
    );
    assert.strictEqual(out[0].passed, true, 'client_id echo must not flag — it is a public identifier');
  });
});

describe('default-invariants: idempotency.conflict_no_payload_leak (widened allowlist)', () => {
  const spec = getAssertion('idempotency.conflict_no_payload_leak');

  function step(adcpError) {
    return {
      step_id: 's1',
      phase_id: 'p',
      title: 't',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      validations: [],
      context: {},
      extraction: { path: 'none' },
      response: adcpError !== undefined ? { adcp_error: adcpError } : undefined,
    };
  }

  test('silent on non-IDEMPOTENCY_CONFLICT error codes', () => {
    const out = spec.onStep({ state: {} }, step({ code: 'INVALID_REQUEST', message: 'bad' }));
    assert.deepStrictEqual(out, []);
  });

  test('passes when the envelope has only allowlisted fields', () => {
    const out = spec.onStep(
      { state: {} },
      step({ code: 'IDEMPOTENCY_CONFLICT', message: 'key reused', correlation_id: 'c-1' })
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].passed, true);
  });

  test('flags any non-allowlisted envelope field (the read-oracle leak vector)', () => {
    const out = spec.onStep(
      { state: {} },
      step({ code: 'IDEMPOTENCY_CONFLICT', message: 'conflict', budget: 5000, start_time: '2026-06-01T00:00:00Z' })
    );
    assert.strictEqual(out[0].passed, false);
    assert.match(out[0].error, /budget/);
    assert.match(out[0].error, /start_time/);
  });

  test('flags the specific named leak fields too (belt-and-suspenders)', () => {
    const out = spec.onStep(
      { state: {} },
      step({ code: 'IDEMPOTENCY_CONFLICT', message: 'conflict', payload: { budget: 5000 } })
    );
    assert.strictEqual(out[0].passed, false);
    assert.match(out[0].error, /payload/);
  });

  test('lists leaked fields deterministically (sorted) for diagnostic stability', () => {
    const out = spec.onStep(
      { state: {} },
      step({ code: 'IDEMPOTENCY_CONFLICT', message: 'conflict', z_field: 1, a_field: 2, m_field: 3 })
    );
    assert.match(out[0].error, /a_field, m_field, z_field/);
  });
});

describe('default-invariants: context.no_secret_echo (widened whole-body scan)', () => {
  const spec = getAssertion('context.no_secret_echo');

  function ctx(options = {}) {
    return { storyboard: {}, agentUrl: 'x', options, state: {} };
  }

  function step(response) {
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
      response,
    };
  }

  test('silent on steps with no response body', () => {
    const c = ctx();
    spec.onStart(c);
    assert.deepStrictEqual(spec.onStep(c, step(undefined)), []);
  });

  test('passes when response carries no credentials / suspect fields', () => {
    const c = ctx({ auth_token: 'sk-live-verylongsecret' });
    spec.onStart(c);
    const out = spec.onStep(c, step({ media_buy_id: 'mb-1', status: 'active' }));
    assert.strictEqual(out[0].passed, true);
  });

  test('fails on a bearer-token literal anywhere in the body', () => {
    const c = ctx();
    spec.onStart(c);
    const out = spec.onStep(c, step({ debug: 'request had Authorization: Bearer abcdef123456xyz' }));
    assert.strictEqual(out[0].passed, false);
    assert.match(out[0].error, /bearer-token literal/);
  });

  test('fails when response echoes options.auth_token verbatim outside .context', () => {
    const c = ctx({ auth_token: 'sk-live-verylongsecret' });
    spec.onStart(c);
    const out = spec.onStep(c, step({ error: { message: 'auth sk-live-verylongsecret failed' } }));
    assert.strictEqual(out[0].passed, false);
    assert.match(out[0].error, /caller-supplied secret/);
  });

  test('fails when response echoes options.secrets[] verbatim', () => {
    const c = ctx({ secrets: ['internal-token-abc123XYZ'] });
    spec.onStart(c);
    const out = spec.onStep(c, step({ audit: { inbound_auth: 'internal-token-abc123XYZ' } }));
    assert.strictEqual(out[0].passed, false);
  });

  test('fails when response echoes test_kit.auth.api_key verbatim', () => {
    const c = ctx({ test_kit: { auth: { api_key: 'tk-api-key-alpha1' } } });
    spec.onStart(c);
    const out = spec.onStep(c, step({ echoed_auth: 'tk-api-key-alpha1' }));
    assert.strictEqual(out[0].passed, false);
  });

  test('fails on a suspect property name at any depth', () => {
    const c = ctx();
    spec.onStart(c);
    const out = spec.onStep(c, step({ nested: { deeper: { Authorization: 'anything' } } }));
    assert.strictEqual(out[0].passed, false);
    assert.match(out[0].error, /suspect property name "Authorization"/);
  });

  test('walks arrays when hunting leaks', () => {
    const c = ctx();
    spec.onStart(c);
    const out = spec.onStep(c, step({ items: [{ ok: 1 }, { notes: 'see Bearer aaaaaaaaaaaaa for details' }] }));
    assert.strictEqual(out[0].passed, false);
  });

  test('ignores short option values to avoid placeholder false positives', () => {
    const c = ctx({ auth_token: 'sk' });
    spec.onStart(c);
    const out = spec.onStep(c, step({ note: 'sk is not a secret' }));
    assert.strictEqual(out[0].passed, true);
  });

  test('does not flag generic use of the word "bearer" in prose', () => {
    const c = ctx();
    spec.onStart(c);
    const out = spec.onStep(c, step({ message: 'the bearer of bad news' }));
    assert.strictEqual(out[0].passed, true);
  });
});

describe('default-invariants: status.monotonic', () => {
  const spec = getAssertion('status.monotonic');

  function makeCtx() {
    return { storyboard: {}, agentUrl: 'x', options: {}, state: {} };
  }

  function step(overrides) {
    return {
      step_id: 's1',
      phase_id: 'p',
      title: 't',
      task: 'get_media_buys',
      passed: true,
      duration_ms: 0,
      validations: [],
      context: {},
      extraction: { path: 'none' },
      ...overrides,
    };
  }

  function run(steps) {
    const ctx = makeCtx();
    spec.onStart(ctx);
    return steps.map(s => ({ step: s.step_id, output: spec.onStep(ctx, s) }));
  }

  function mb(id, status, extra = {}) {
    return { media_buy_id: id, status, packages: [], ...extra };
  }

  // ── media_buy ───────────────────────────────────────────────

  test('silent when no status observations appear', () => {
    const out = run([step({ task: 'get_products', response: { products: [] } })]);
    assert.deepStrictEqual(out[0].output, []);
  });

  test('media_buy forward transitions pass', () => {
    const out = run([
      step({ step_id: 'create', task: 'create_media_buy', response: mb('mb-1', 'pending_creatives') }),
      step({ step_id: 'read1', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'active')] } }),
      step({ step_id: 'read2', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'paused')] } }),
      step({ step_id: 'read3', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'active')] } }),
      step({ step_id: 'read4', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'completed')] } }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('media_buy backward transition fails with actionable error', () => {
    const out = run([
      step({ step_id: 'create', task: 'create_media_buy', response: mb('mb-1', 'active') }),
      step({ step_id: 'regress', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'pending_creatives')] } }),
    ]);
    const fail = out[1].output[0];
    assert.strictEqual(fail.passed, false);
    assert.match(fail.error, /media_buy mb-1/);
    assert.match(fail.error, /active → pending_creatives/);
    assert.match(fail.error, /step "create" → step "regress"/);
  });

  test('media_buy terminal is terminal — no exit transitions allowed', () => {
    const out = run([
      step({ step_id: 'done', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'completed')] } }),
      step({ step_id: 'revive', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'active')] } }),
    ]);
    assert.strictEqual(out[1].output[0].passed, false);
    assert.match(out[1].output[0].error, /completed → active/);
  });

  test('scope is per-(resource_type, resource_id) — two media buys independent', () => {
    const out = run([
      step({ step_id: 'a-done', task: 'get_media_buys', response: { media_buys: [mb('mb-a', 'completed')] } }),
      step({ step_id: 'b-active', task: 'create_media_buy', response: mb('mb-b', 'active') }),
    ]);
    assert.ok(out[1].output.every(o => o.passed));
  });

  test('self-edges (replay observing same status) are silent', () => {
    const out = run([
      step({ step_id: 's1', task: 'create_media_buy', response: mb('mb-1', 'pending_creatives') }),
      step({ step_id: 's2', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'pending_creatives')] } }),
      // Backward check still uses the ORIGINAL step (s1), not s2 — self-edge doesn't advance the anchor.
      step({
        step_id: 's3_backward',
        task: 'get_media_buys',
        response: { media_buys: [mb('mb-1', 'pending_creatives')] },
      }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  // ── skip semantics ──────────────────────────────────────────

  test('errored / expect_error / skipped steps do not record observations', () => {
    const out = run([
      step({ step_id: 'create', task: 'create_media_buy', response: mb('mb-1', 'active') }),
      step({
        step_id: 'errored_read',
        task: 'get_media_buys',
        passed: false,
        response: { media_buys: [mb('mb-1', 'pending_creatives')] },
      }),
      step({
        step_id: 'expect_err',
        task: 'get_media_buys',
        expect_error: true,
        response: { media_buys: [mb('mb-1', 'pending_creatives')] },
      }),
      step({ step_id: 'skipped', task: 'get_media_buys', skipped: true, response: undefined }),
      // All three intermediates ignored — final read against anchor 'create' (active) must go forward.
      step({ step_id: 'ok', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'paused')] } }),
    ]);
    assert.ok(out[4].output[0].passed);
  });

  test('adcp_error on response is treated as no observation', () => {
    const out = run([
      step({ step_id: 'create', task: 'create_media_buy', response: mb('mb-1', 'active') }),
      step({
        step_id: 'err',
        task: 'get_media_buys',
        response: { adcp_error: { code: 'INVALID_REQUEST', message: 'bad' } },
      }),
      step({ step_id: 'ok', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'paused')] } }),
    ]);
    assert.ok(out[2].output[0].passed);
  });

  // ── creative ────────────────────────────────────────────────

  test('creative asset: rejected → processing → pending_review → approved (re-sync path)', () => {
    // Per `creative-status.json`: re-sync takes a rejected creative back to
    // `processing`, which then auto-transitions to `pending_review` before
    // finally reaching `approved`. No `processing → approved` shortcut.
    const creativeOf = (id, status) => ({ creative_id: id, status });
    const out = run([
      step({
        step_id: 'sync1',
        task: 'sync_creatives',
        response: { creatives: [creativeOf('cr-1', 'rejected')] },
      }),
      step({
        step_id: 'resync',
        task: 'sync_creatives',
        response: { creatives: [creativeOf('cr-1', 'processing')] },
      }),
      step({
        step_id: 'queued',
        task: 'list_creatives',
        response: { creatives: [creativeOf('cr-1', 'pending_review')] },
      }),
      step({
        step_id: 'review',
        task: 'list_creatives',
        response: { creatives: [creativeOf('cr-1', 'approved')] },
      }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('creative asset: processing → approved shortcut is NOT allowed', () => {
    // Per schema prose, `processing` auto-transitions to `pending_review`
    // or `rejected`, never directly to `approved`. A seller emitting that
    // shortcut is skipping the review gate.
    const creativeOf = (id, status) => ({ creative_id: id, status });
    const out = run([
      step({ step_id: 's1', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'processing')] } }),
      step({ step_id: 's2', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'approved')] } }),
    ]);
    assert.strictEqual(out[1].output[0].passed, false);
    assert.match(out[1].output[0].error, /creative cr-1: processing → approved/);
  });

  test('creative asset: approved ↔ archived is bidirectional', () => {
    const creativeOf = (id, status) => ({ creative_id: id, status });
    const out = run([
      step({ step_id: 's1', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'approved')] } }),
      step({ step_id: 's2', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'archived')] } }),
      step({ step_id: 's3', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'approved')] } }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('creative asset: approved → processing is NOT allowed', () => {
    const creativeOf = (id, status) => ({ creative_id: id, status });
    const out = run([
      step({ step_id: 's1', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'approved')] } }),
      step({ step_id: 's2', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'processing')] } }),
    ]);
    assert.strictEqual(out[1].output[0].passed, false);
    assert.match(out[1].output[0].error, /creative cr-1: approved → processing/);
  });

  test('creative asset: pending_review → processing is NOT allowed', () => {
    // The only path back to `processing` is from `rejected` (re-sync after
    // fixing issues). `pending_review` itself goes to approved or rejected.
    const creativeOf = (id, status) => ({ creative_id: id, status });
    const out = run([
      step({ step_id: 's1', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'pending_review')] } }),
      step({ step_id: 's2', task: 'sync_creatives', response: { creatives: [creativeOf('cr-1', 'processing')] } }),
    ]);
    assert.strictEqual(out[1].output[0].passed, false);
    assert.match(out[1].output[0].error, /creative cr-1: pending_review → processing/);
  });

  // ── creative_approval (nested under media_buy.packages) ────

  test('creative_approval tracked via nested package arrays', () => {
    const responseWithApproval = (creativeId, approvalStatus) =>
      mb('mb-1', 'pending_creatives', {
        packages: [
          { package_id: 'pkg-1', creative_approvals: [{ creative_id: creativeId, approval_status: approvalStatus }] },
        ],
      });
    const out = run([
      step({ step_id: 's1', task: 'create_media_buy', response: responseWithApproval('cr-1', 'pending_review') }),
      step({
        step_id: 's2',
        task: 'get_media_buys',
        response: { media_buys: [responseWithApproval('cr-1', 'approved')] },
      }),
      step({
        step_id: 's3',
        task: 'get_media_buys',
        response: { media_buys: [responseWithApproval('cr-1', 'pending_review')] },
      }),
    ]);
    assert.strictEqual(out[2].output[0].passed, false);
    assert.match(out[2].output[0].error, /creative_approval cr-1: approved → pending_review/);
  });

  // ── account ────────────────────────────────────────────────

  test('account: active ↔ suspended is reversible', () => {
    const accountOf = (id, status) => ({ account_id: id, status });
    const out = run([
      step({ step_id: 's1', task: 'sync_accounts', response: { accounts: [accountOf('acc-1', 'active')] } }),
      step({ step_id: 's2', task: 'list_accounts', response: { accounts: [accountOf('acc-1', 'suspended')] } }),
      step({ step_id: 's3', task: 'list_accounts', response: { accounts: [accountOf('acc-1', 'active')] } }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('account: closed is terminal', () => {
    const accountOf = (id, status) => ({ account_id: id, status });
    const out = run([
      step({ step_id: 's1', task: 'list_accounts', response: { accounts: [accountOf('acc-1', 'closed')] } }),
      step({ step_id: 's2', task: 'list_accounts', response: { accounts: [accountOf('acc-1', 'active')] } }),
    ]);
    assert.strictEqual(out[1].output[0].passed, false);
    assert.match(out[1].output[0].error, /closed → active/);
  });

  test('account: suspended → payment_required is allowed (credit lapse during suspension)', () => {
    const accountOf = (id, status) => ({ account_id: id, status });
    const out = run([
      step({ step_id: 's1', task: 'list_accounts', response: { accounts: [accountOf('acc-1', 'suspended')] } }),
      step({ step_id: 's2', task: 'list_accounts', response: { accounts: [accountOf('acc-1', 'payment_required')] } }),
    ]);
    assert.ok(out[1].output[0].passed);
  });

  // ── si_session ─────────────────────────────────────────────

  test('si_session terminal states cannot re-activate', () => {
    const out = run([
      step({ step_id: 's1', task: 'si_initiate_session', response: { session_id: 'sn-1', status: 'active' } }),
      step({ step_id: 's2', task: 'si_send_message', response: { session_id: 'sn-1', status: 'terminated' } }),
      step({ step_id: 's3', task: 'si_send_message', response: { session_id: 'sn-1', status: 'active' } }),
    ]);
    assert.strictEqual(out[2].output[0].passed, false);
    assert.match(out[2].output[0].error, /si_session sn-1: terminated → active/);
  });

  // ── catalog_item ───────────────────────────────────────────

  test('catalog_item: approved ↔ warning is reversible', () => {
    const itemOf = (id, status) => ({ item_id: id, status });
    const out = run([
      step({
        step_id: 's1',
        task: 'sync_catalogs',
        response: { catalogs: [{ catalog_id: 'cat-1', items: [itemOf('it-1', 'approved')] }] },
      }),
      step({
        step_id: 's2',
        task: 'list_catalogs',
        response: { catalogs: [{ catalog_id: 'cat-1', items: [itemOf('it-1', 'warning')] }] },
      }),
      step({
        step_id: 's3',
        task: 'list_catalogs',
        response: { catalogs: [{ catalog_id: 'cat-1', items: [itemOf('it-1', 'approved')] }] },
      }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  // ── proposal ───────────────────────────────────────────────

  test('proposal: committed is terminal', () => {
    const proposalOf = (id, status) => ({ proposal_id: id, status });
    const out = run([
      step({ step_id: 's1', task: 'get_products', response: { proposal: proposalOf('p-1', 'committed') } }),
      step({ step_id: 's2', task: 'get_products', response: { proposal: proposalOf('p-1', 'draft') } }),
    ]);
    assert.strictEqual(out[1].output[0].passed, false);
    assert.match(out[1].output[0].error, /proposal p-1: committed → draft/);
  });

  // ── unknown / drift tolerance ──────────────────────────────

  test('unknown status value is treated as enum drift (not a fail)', () => {
    const out = run([
      step({ step_id: 's1', task: 'create_media_buy', response: mb('mb-1', 'xx_unknown') }),
      step({ step_id: 's2', task: 'get_media_buys', response: { media_buys: [mb('mb-1', 'active')] } }),
    ]);
    // prev status was unknown — assertion doesn't fail, resets anchor instead.
    assert.ok(out[1].output.every(o => o.passed));
  });

  test('duplicate id within a single step with inconsistent statuses flags a transition', () => {
    // A seller returning two media_buys[] entries with the same id and
    // different statuses is contradicting itself. The assertion treats the
    // second as a transition from the first — technically "step X → step X"
    // in the diagnostic but factually accurate: the response is inconsistent
    // within itself.
    const out = run([
      step({
        step_id: 'read',
        task: 'get_media_buys',
        response: {
          media_buys: [mb('mb-1', 'active'), mb('mb-1', 'pending_creatives')],
        },
      }),
    ]);
    assert.strictEqual(out[0].output[0].passed, false);
    assert.match(out[0].output[0].error, /media_buy mb-1: active → pending_creatives/);
  });

  // ── audience ───────────────────────────────────────────────

  const audienceOf = (id, status, extra = {}) => ({ audience_id: id, status, ...extra });

  test('audience: processing → ready forward flow passes', () => {
    const out = run([
      step({ step_id: 's1', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'processing')] } }),
      step({ step_id: 's2', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready', { matched_count: 1200 })] } }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('audience: too_small → processing → ready re-sync path passes', () => {
    const out = run([
      step({ step_id: 's1', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'too_small', { minimum_size: 1000 })] } }),
      step({ step_id: 's2', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'processing')] } }),
      step({ step_id: 's3', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready', { matched_count: 1500 })] } }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('audience: ready ↔ too_small is bidirectional (counts cross minimum_size)', () => {
    const out = run([
      step({ step_id: 's1', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready')] } }),
      step({ step_id: 's2', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'too_small')] } }),
      step({ step_id: 's3', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready')] } }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('audience: ready → processing is allowed on re-sync', () => {
    const out = run([
      step({ step_id: 's1', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready')] } }),
      step({ step_id: 's2', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'processing')] } }),
    ]);
    assert.ok(out[1].output.every(o => o.passed));
  });

  test('audience: self-edge (same status re-read) is silent pass', () => {
    const out = run([
      step({ step_id: 's1', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready')] } }),
      step({ step_id: 's2', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready')] } }),
    ]);
    // Two passes, no failures. `prev.status === ob.status` is a no-op path.
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('audience: action deleted / failed omits status — observations are silent', () => {
    // Spec envelope omits `status` entirely when `action` is `deleted` or
    // `failed`. pushAudience requires both id and status, so these rows
    // contribute no observations — the assertion can't see absence.
    const out = run([
      step({ step_id: 's1', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready')] } }),
      step({ step_id: 's2', task: 'sync_audiences', response: { audiences: [{ audience_id: 'aud-1', action: 'deleted' }] } }),
      step({ step_id: 's3', task: 'sync_audiences', response: { audiences: [{ audience_id: 'aud-1', action: 'failed' }] } }),
    ]);
    // s2/s3 carry no status → no observations → assertion doesn't emit.
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('audience: observations are scoped per audience_id', () => {
    // aud-1 and aud-2 have independent histories. A ready on aud-1 doesn't
    // anchor aud-2, so aud-2 starting at too_small isn't a regression.
    const out = run([
      step({ step_id: 's1', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready'), audienceOf('aud-2', 'too_small')] } }),
      step({ step_id: 's2', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'processing'), audienceOf('aud-2', 'ready')] } }),
    ]);
    assert.ok(out.every(r => r.output.every(o => o.passed)));
  });

  test('audience: unknown status value is treated as enum drift (not a fail)', () => {
    // Matches the existing drift behaviour on media_buy — unknown prev.status
    // resets the anchor instead of failing; response_schema is the gate for
    // enum conformance.
    const out = run([
      step({ step_id: 's1', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'xx_unknown')] } }),
      step({ step_id: 's2', task: 'sync_audiences', response: { audiences: [audienceOf('aud-1', 'ready')] } }),
    ]);
    assert.ok(out[1].output.every(o => o.passed));
  });
});
