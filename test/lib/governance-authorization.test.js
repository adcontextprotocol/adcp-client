const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CompactSign, importJWK } = require('jose');

const {
  buildGovernanceExecutionRequest,
  buildGovernanceExecutionCommitment,
  buildGovernanceIntentRequest,
  buildGovernanceProposedCommitment,
  computeGovernedPayloadHash,
  createGovernanceEnforcementMiddleware,
  getGovernanceEnforcementTasks,
  InMemoryGovernanceReplayStore,
  targetDeclaresGovernanceEnforcement,
  verifyGovernanceAuthorization,
} = require('../../dist/lib/index.js');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');
const { createAdcpGovernanceEnforcementMiddleware } = require('../../dist/lib/server/governance.js');

const vectors = require(
  path.resolve(__dirname, '../../compliance/cache/latest/test-vectors/governance-authorization.json')
);

function verifierOptions(testCase) {
  const signed = vectors.signed_jws;
  const defaults = signed.verification_defaults;
  const overrides = testCase.verification_overrides ?? {};
  const testKey = { ...signed.test_key };
  delete testKey.$comment;
  delete testKey._private_d_for_test_only;

  const replayStore = new InMemoryGovernanceReplayStore();
  if (overrides.preconsumed_jti) {
    replayStore.preload(testCase.claims.iss, testCase.claims.aud, testCase.claims.jti, testCase.claims.exp);
  }

  return {
    token: testCase.compact_jws,
    expectedIssuer: overrides.expected_issuer ?? defaults.expected_issuer,
    expectedAudience: overrides.expected_audience ?? defaults.expected_audience,
    authenticatedCaller: overrides.authenticated_caller ?? defaults.authenticated_caller,
    expectedTask: overrides.expected_task ?? defaults.expected_task,
    payload: overrides.payload ?? defaults.payload,
    actualCommitment: overrides.actual_commitment ?? defaults.actual_commitment,
    expectedPhase: overrides.expected_phase ?? defaults.expected_phase,
    jwks: new StaticJwksResolver([testKey]),
    replayStore,
    now: () => overrides.now ?? defaults.now,
    clockSkewSeconds: overrides.clock_skew_seconds ?? defaults.clock_skew_seconds,
  };
}

async function signAuthorization(claims, headerOverrides = {}) {
  const fixtureKey = vectors.signed_jws.test_key;
  const privateKey = {
    ...fixtureKey,
    d: fixtureKey._private_d_for_test_only,
    key_ops: ['sign'],
  };
  delete privateKey.$comment;
  delete privateKey._private_d_for_test_only;
  const key = await importJWK(privateKey, 'EdDSA');
  const header = {
    alg: 'EdDSA',
    kid: fixtureKey.kid,
    typ: 'adcp-gov+jws',
    crit: ['authorized_commitment', 'authorized_task', 'authorized_payload_hash'],
    authorized_commitment: true,
    authorized_task: true,
    authorized_payload_hash: true,
    ...headerOverrides,
  };
  return new CompactSign(Buffer.from(JSON.stringify(claims))).setProtectedHeader(header).sign(key, {
    crit: {
      authorized_commitment: true,
      authorized_task: true,
      authorized_payload_hash: true,
    },
  });
}

describe('AdCP governance authorization profile', () => {
  for (const testCase of vectors.payload_hash_cases) {
    it(`computes published payload hash: ${testCase.id}`, () => {
      assert.equal(computeGovernedPayloadHash(testCase.payload), testCase.expected_hash);
    });
  }

  for (const testCase of vectors.signed_jws.cases) {
    it(`verifies published compact JWS vector: ${testCase.id}`, async () => {
      const result = await verifyGovernanceAuthorization(verifierOptions(testCase));
      if (testCase.expected.result === 'accept') {
        assert.equal(result.ok, true, result.message);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.error, testCase.expected.error);
      }
    });
  }

  for (const authorizationCase of vectors.authorization_cases) {
    it(`enforces published authorization case: ${authorizationCase.id}`, async () => {
      const accepted = vectors.signed_jws.cases.find(testCase => testCase.id === 'valid-exact-authorization');
      const payload = accepted.verification_overrides?.payload ?? vectors.signed_jws.verification_defaults.payload;
      const claims = {
        ...accepted.claims,
        jti: `logical-${authorizationCase.id}`,
        authorized_task: authorizationCase.task_match ? 'create_media_buy' : 'update_media_buy',
        authorized_payload_hash: authorizationCase.payload_hash_match
          ? computeGovernedPayloadHash(payload)
          : computeGovernedPayloadHash({ ...payload, amount: 999 }),
        authorized_commitment: {
          amount: authorizationCase.authorized_amount,
          currency: authorizationCase.currency_match ? 'USD' : 'EUR',
        },
      };
      const headerOverrides = authorizationCase.critical_markers_complete
        ? {}
        : { crit: ['authorized_task', 'authorized_payload_hash'], authorized_commitment: undefined };
      const token = await signAuthorization(claims, headerOverrides);
      const options = verifierOptions(accepted);
      const result = await verifyGovernanceAuthorization({
        ...options,
        token,
        payload,
        actualCommitment: { amount: authorizationCase.actual_amount, currency: 'USD' },
      });
      assert.equal(result.ok, authorizationCase.expected === 'accept');
    });
  }

  it('fails closed for unknown-purpose keys and revoked authorizations', async () => {
    const acceptedCase = vectors.signed_jws.cases.find(testCase => testCase.expected.result === 'accept');
    const unknownKeyOptions = verifierOptions(acceptedCase);
    unknownKeyOptions.jwks = new StaticJwksResolver([]);
    const unknownKey = await verifyGovernanceAuthorization(unknownKeyOptions);
    assert.equal(unknownKey.ok, false);
    assert.equal(unknownKey.error, 'governance_key_unknown');

    const missingUseOptions = verifierOptions(acceptedCase);
    const missingUseKey = { ...vectors.signed_jws.test_key };
    delete missingUseKey.$comment;
    delete missingUseKey._private_d_for_test_only;
    delete missingUseKey.use;
    missingUseOptions.jwks = new StaticJwksResolver([missingUseKey]);
    const missingUse = await verifyGovernanceAuthorization(missingUseOptions);
    assert.equal(missingUse.ok, false);
    assert.equal(missingUse.error, 'governance_key_unknown');

    const revokedOptions = verifierOptions(acceptedCase);
    const revoked = await verifyGovernanceAuthorization({
      ...revokedOptions,
      revocationStore: { isRevoked: async () => true },
    });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error, 'governance_token_revoked');

    const revokedJtiOptions = verifierOptions(acceptedCase);
    const revokedJti = await verifyGovernanceAuthorization({
      ...revokedJtiOptions,
      isJtiRevoked: async () => true,
    });
    assert.equal(revokedJti.ok, false);
    assert.equal(revokedJti.error, 'governance_token_revoked');
  });

  it('rejects a consumed authorization before a side effect can run twice', async () => {
    const acceptedCase = vectors.signed_jws.cases.find(testCase => testCase.id === 'valid-exact-authorization');
    const options = verifierOptions(acceptedCase);
    assert.equal((await verifyGovernanceAuthorization(options)).ok, true);
    const retry = await verifyGovernanceAuthorization(options);
    assert.equal(retry.ok, false);
    assert.equal(retry.error, 'governance_token_replayed');

    const missingToken = await verifyGovernanceAuthorization({ ...options, token: undefined });
    assert.equal(missingToken.ok, false);
    assert.equal(missingToken.error, 'governance_token_invalid');
  });

  it('partitions in-memory replay capacity by issuer and audience', async () => {
    const store = new InMemoryGovernanceReplayStore({ maxEntries: 1 });
    assert.equal(await store.consume('issuer-a', 'audience-a', 'jti-1', 1000, 0), 'ok');
    assert.equal(await store.consume('issuer-b', 'audience-b', 'jti-1', 1000, 0), 'ok');
    assert.equal(await store.consume('issuer-a', 'audience-a', 'jti-2', 1000, 0), 'rate_abuse');
  });

  it('requires fresh combined revocation status for tokens over 15 minutes', async () => {
    const acceptedCase = vectors.signed_jws.cases.find(testCase => testCase.id === 'valid-exact-authorization');
    const claims = { ...acceptedCase.claims, jti: 'long-lived', exp: acceptedCase.claims.iat + 3600 };
    const token = await signAuthorization(claims);
    const options = verifierOptions(acceptedCase);
    const withoutCombined = await verifyGovernanceAuthorization({
      ...options,
      token,
      revocationStore: { isRevoked: async () => false },
      isJtiRevoked: async () => false,
    });
    assert.equal(withoutCombined.ok, false);
    assert.equal(withoutCombined.error, 'governance_token_invalid');

    const withCombined = await verifyGovernanceAuthorization({
      ...options,
      token,
      replayStore: new InMemoryGovernanceReplayStore(),
      revocationResolver: {
        resolve: async issuer => ({
          issuer,
          keyRevoked: false,
          jtiRevoked: false,
          nextUpdate: acceptedCase.claims.iat + 120,
        }),
      },
    });
    assert.equal(withCombined.ok, true);
  });

  it('fails closed when combined revocation status omits or mistypes either revocation flag', async () => {
    const acceptedCase = vectors.signed_jws.cases.find(testCase => testCase.id === 'valid-exact-authorization');
    const claims = { ...acceptedCase.claims, jti: 'malformed-revocation-status', exp: acceptedCase.claims.iat + 3600 };
    const token = await signAuthorization(claims);
    const malformedStatuses = [
      { issuer: claims.iss, jtiRevoked: false, nextUpdate: claims.iat + 120 },
      { issuer: claims.iss, keyRevoked: 'false', jtiRevoked: false, nextUpdate: claims.iat + 120 },
      { issuer: claims.iss, keyRevoked: false, nextUpdate: claims.iat + 120 },
      { issuer: claims.iss, keyRevoked: false, jtiRevoked: 0, nextUpdate: claims.iat + 120 },
    ];

    for (const status of malformedStatuses) {
      const result = await verifyGovernanceAuthorization({
        ...verifierOptions(acceptedCase),
        token,
        revocationResolver: { resolve: async () => status },
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'governance_token_revoked');
    }
  });

  it('rejects intent authorizations that carry execution-only media_buy_id', async () => {
    const acceptedCase = vectors.signed_jws.cases.find(testCase => testCase.id === 'valid-exact-authorization');
    const claims = { ...acceptedCase.claims, jti: 'intent-with-media-buy-id', media_buy_id: 'buy-1' };
    const token = await signAuthorization(claims);
    const result = await verifyGovernanceAuthorization({ ...verifierOptions(acceptedCase), token });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'governance_token_not_applicable');
  });

  it('builds distinct intent and execution request shapes', () => {
    assert.deepEqual(buildGovernanceProposedCommitment(10, 'USD'), { amount: 10, currency: 'USD' });
    assert.deepEqual(buildGovernanceExecutionCommitment(5, 'USD'), { amount: 5, currency: 'USD' });
    const intent = buildGovernanceIntentRequest({
      planId: 'plan-1',
      caller: 'https://buyer.example',
      targetAgent: 'https://seller.example/mcp',
      tool: 'create_media_buy',
      payload: { idempotency_key: 'key-1', total_budget: 10 },
      purchaseType: 'media_buy',
    });
    assert.equal(intent.plan_id, 'plan-1');
    assert.equal(intent.target_agent, 'https://seller.example/mcp');
    assert.ok(!('governance_context' in intent));

    const execution = buildGovernanceExecutionRequest({
      caller: 'https://seller.example/mcp',
      governanceContext: 'signed-token',
      plannedDelivery: { total_budget: 10, currency: 'USD' },
      executionCommitment: { amount: 10, currency: 'USD' },
    });
    assert.equal(execution.governance_context, 'signed-token');
    assert.ok(!('plan_id' in execution));
    assert.ok(!('tool' in execution));
    assert.ok(!('payload' in execution));
  });

  it('enforces phase-specific execution request requirements', () => {
    assert.throws(
      () =>
        buildGovernanceExecutionRequest({
          caller: 'https://seller.example/mcp',
          governanceContext: 'signed-token',
          plannedDelivery: { media_buy_id: 'buy-1', total_budget: 10, currency: 'USD' },
          phase: 'modification',
        }),
      /requires executionCommitment/
    );
    assert.throws(
      () =>
        buildGovernanceExecutionRequest({
          caller: 'https://seller.example/mcp',
          governanceContext: 'signed-token',
          plannedDelivery: { media_buy_id: 'buy-1', total_budget: 10, currency: 'USD' },
          phase: 'delivery',
        }),
      /requires deliveryMetrics/
    );
  });

  it('requires one signed-context declaration per governed task', () => {
    const capabilities = {
      experimental_features: ['governance.campaign'],
      adcp: {
        governance_enforcement: {
          tasks: [
            { task: 'create_media_buy', modes: ['signed_context'] },
            { task: 'update_media_buy', modes: ['online_execution_check'] },
          ],
        },
      },
    };
    assert.deepEqual(getGovernanceEnforcementTasks(capabilities), [
      { task: 'create_media_buy', modes: ['signed_context'] },
    ]);
    assert.equal(targetDeclaresGovernanceEnforcement(capabilities, 'create_media_buy'), true);
    assert.equal(targetDeclaresGovernanceEnforcement(capabilities, 'update_media_buy'), false);
    assert.equal(
      targetDeclaresGovernanceEnforcement({ adcp: capabilities.adcp }, 'create_media_buy'),
      false,
      'the experimental feature marker is required'
    );
    assert.throws(
      () =>
        getGovernanceEnforcementTasks({
          adcp: {
            governance_enforcement: {
              tasks: [
                { task: 'create_media_buy', modes: [] },
                { task: 'create_media_buy', modes: ['signed_context'] },
              ],
            },
          },
        }),
      /Duplicate governance_enforcement task/
    );
  });

  it('does not invoke a governed side effect before authorization succeeds', async () => {
    const acceptedCase = vectors.signed_jws.cases.find(testCase => testCase.expected.result === 'accept');
    const rejectedCase = vectors.signed_jws.cases.find(testCase => testCase.id === 'signature-tampered');
    let sideEffects = 0;

    const acceptedOptions = verifierOptions(acceptedCase);
    const acceptedMiddleware = createGovernanceEnforcementMiddleware({
      expectedIssuer: acceptedOptions.expectedIssuer,
      expectedAudience: acceptedOptions.expectedAudience,
      jwks: acceptedOptions.jwks,
      replayStore: acceptedOptions.replayStore,
      now: acceptedOptions.now,
      clockSkewSeconds: acceptedOptions.clockSkewSeconds,
    });
    const value = await acceptedMiddleware(
      {
        token: acceptedOptions.token,
        authenticatedCaller: acceptedOptions.authenticatedCaller,
        task: acceptedOptions.expectedTask,
        payload: acceptedOptions.payload,
        actualCommitment: acceptedOptions.actualCommitment,
      },
      () => {
        sideEffects++;
        return 'executed';
      }
    );
    assert.equal(value, 'executed');
    assert.equal(sideEffects, 1);
    await assert.rejects(
      () =>
        acceptedMiddleware(
          {
            token: acceptedOptions.token,
            authenticatedCaller: acceptedOptions.authenticatedCaller,
            task: acceptedOptions.expectedTask,
            payload: acceptedOptions.payload,
            actualCommitment: acceptedOptions.actualCommitment,
          },
          () => {
            sideEffects++;
          }
        ),
      error => error.code === 'governance_token_replayed'
    );
    assert.equal(sideEffects, 1);

    const rejectedOptions = verifierOptions(rejectedCase);
    const rejectedMiddleware = createGovernanceEnforcementMiddleware({
      expectedIssuer: rejectedOptions.expectedIssuer,
      expectedAudience: rejectedOptions.expectedAudience,
      jwks: rejectedOptions.jwks,
      replayStore: rejectedOptions.replayStore,
      now: rejectedOptions.now,
      clockSkewSeconds: rejectedOptions.clockSkewSeconds,
    });
    await assert.rejects(
      () =>
        rejectedMiddleware(
          {
            token: rejectedOptions.token,
            authenticatedCaller: rejectedOptions.authenticatedCaller,
            task: rejectedOptions.expectedTask,
            payload: rejectedOptions.payload,
            actualCommitment: rejectedOptions.actualCommitment,
          },
          () => {
            sideEffects++;
          }
        ),
      error => error.code === 'governance_token_invalid'
    );
    assert.equal(sideEffects, 1);
  });

  it('maps service authorization failures to structured PERMISSION_DENIED', async () => {
    const acceptedCase = vectors.signed_jws.cases.find(testCase => testCase.expected.result === 'accept');
    const options = verifierOptions(acceptedCase);
    const enforce = createAdcpGovernanceEnforcementMiddleware({
      expectedIssuer: options.expectedIssuer,
      expectedAudience: options.expectedAudience,
      jwks: options.jwks,
      replayStore: options.replayStore,
      now: options.now,
      clockSkewSeconds: options.clockSkewSeconds,
    });
    let sideEffects = 0;
    const response = await enforce(
      {
        token: undefined,
        authenticatedCaller: options.authenticatedCaller,
        task: options.expectedTask,
        payload: options.payload,
        actualCommitment: options.actualCommitment,
      },
      () => ++sideEffects
    );
    assert.equal(sideEffects, 0);
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
  });
});
