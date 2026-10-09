import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PendingWebFlow, PendingWebFlowStore } from '../auth/oauth/web-flow';

/** Application-owned fixture values, for stores with agent foreign keys or carry validation. */
export interface PendingWebFlowStoreRoundTripOptions {
  agentId?: string;
  carry?: Record<string, unknown>;
}

type PendingWebFlowFixture = Required<PendingWebFlow> & {
  clientInformation: Required<PendingWebFlow['clientInformation']> & Record<string, unknown>;
  conformanceExtension: { retained: string };
};

// Required makes omission of any field, including a newly added optional field,
// a build failure. Keep this as the single fixture used by the public helper.
function createPendingWebFlowFixture(
  state: string,
  options: PendingWebFlowStoreRoundTripOptions
): PendingWebFlowFixture {
  const createdAt = new Date();
  return {
    state,
    agentId: options.agentId ?? 'pending-flow-store-conformance',
    agentUrl: 'https://agent.example/mcp',
    codeVerifier: 'conformance-only-pkce-verifier',
    redirectUri: 'https://buyer.example/oauth/callback',
    resource: 'https://resource.example/mcp',
    resourceOverride: 'https://resource.example/mcp',
    resourceOverrideAction: 'set',
    resourceOverrideSnapshot: 'https://previous-resource.example/mcp',
    scope: 'mcp.read mcp.write',
    authorizationServerUrl: 'https://auth.example/tenant',
    authorizationServerIssuer: 'https://auth.example/tenant',
    clientInformation: {
      client_id: 'conformance-client',
      client_secret: 'conformance-only-client-secret',
      client_id_issued_at: 1700000000,
      client_secret_expires_at: 0,
      issuer: 'https://auth.example/tenant',
      redirect_uris: ['https://buyer.example/oauth/callback'],
      token_endpoint_auth_method: 'client_secret_post',
      conformanceExtension: { retained: 'client metadata' },
    },
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1000),
    carry:
      options.carry !== undefined
        ? structuredClone(options.carry)
        : {
            user_id: 'conformance-user',
            return_to: '/dashboard',
            nested: { values: ['one', 2, true, null, { retained: 'yes' }] },
          },
    conformanceExtension: { retained: 'future flow fields' },
  } satisfies PendingWebFlowFixture;
}

/**
 * Assert that an adopter's pending-flow store preserves every current SDK field,
 * revives Dates, isolates state keys, rejects duplicates, consumes atomically
 * once, and treats expired rows as absent. Throws on a contract violation.
 * Stores may refuse to insert an already-expired row. Also checks null snapshots,
 * clear actions, public clients, registration metadata and unknown extensions.
 * Absent optional fields must stay absent rather than become undefined-valued
 * own properties; the callback distinguishes presence for resource snapshots.
 *
 * Run against a disposable store in CI on every SDK upgrade. Uses random states
 * and only conformance credentials; no OAuth endpoints are contacted. Concurrent
 * consume checks are a smoke test, not a proof of distributed atomicity.
 */
export async function assertPendingWebFlowStoreRoundTrip(
  store: PendingWebFlowStore,
  options: PendingWebFlowStoreRoundTripOptions = {}
): Promise<void> {
  // Match real SDK states, including their length, for stores with bounded keys.
  const newState = () => randomBytes(32).toString('base64url');
  const flow = createPendingWebFlowFixture(newState(), options);
  // Snapshot before handing the object to a store that might mutate its input.
  const expected = structuredClone(flow);
  await store.put(flow);
  assert.equal(await store.consume(newState()), null, 'Unknown state must return null');
  assert.deepStrictEqual(
    await store.consume(flow.state),
    expected,
    'Pending flow must round-trip every field and Date'
  );
  assert.equal(await store.consume(flow.state), null, 'Pending flow must only be consumed once');

  const clear: PendingWebFlow = {
    ...createPendingWebFlowFixture(newState(), options),
    resourceOverrideAction: 'clear',
    resourceOverrideSnapshot: null,
    clientInformation: { client_id: 'public-conformance-client', issuer: 'https://auth.example/tenant' },
  };
  delete clear.resourceOverride;
  const expectedClear = structuredClone(clear);
  await store.put(clear);
  assert.deepStrictEqual(
    await store.consume(clear.state),
    expectedClear,
    'Clear flow must preserve null and absent fields'
  );
  assert.equal(await store.consume(clear.state), null, 'Clear flow must only be consumed once');

  const expired = createPendingWebFlowFixture(newState(), options);
  expired.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  expired.expiresAt = new Date(Date.now() - 60 * 60 * 1000);
  // TTL-backed stores may reject expired inserts; neither path may return a row.
  try {
    await store.put(expired);
  } catch {
    // Refusing an already-expired insert is permitted by the store contract.
  }
  assert.equal(await store.consume(expired.state), null, 'Expired flow must return null');

  const concurrent = createPendingWebFlowFixture(newState(), options);
  const expectedConcurrent = structuredClone(concurrent);
  await store.put(concurrent);
  const duplicate = { ...structuredClone(concurrent), codeVerifier: 'different-conformance-verifier' };
  await assert.rejects(async () => store.put(duplicate), 'Duplicate state must be rejected');
  const results = await Promise.all([store.consume(concurrent.state), store.consume(concurrent.state)]);
  const winners = results.filter(result => result !== null);
  assert.equal(winners.length, 1, 'Concurrent consumes must return the flow exactly once');
  assert.deepStrictEqual(winners[0], expectedConcurrent, 'Concurrent consume must preserve the original flow');
  assert.equal(await store.consume(concurrent.state), null, 'Concurrent consume must delete the flow');
}
