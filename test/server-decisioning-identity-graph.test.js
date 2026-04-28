// Integration test for the IdentityGraphProvider worked example.
// Exercises sync ack + multi-stage publishStatusChange (matching →
// matched → activating → active) for the audience-sync specialism.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
const {
  setStatusChangeBus,
  createInMemoryStatusChangeBus,
  publishStatusChange,
} = require('../dist/lib/server/decisioning/status-changes');

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}

function makeIdentityGraph({
  minIdentifiers = 5,
  matchLatencyMs = 25,
  activationLatencyMs = 25,
  defaultMatchRate = 0.42,
} = {}) {
  const config = { minIdentifiers, matchLatencyMs, activationLatencyMs, defaultMatchRate };
  const audienceState = new Map();

  return {
    capabilities: {
      specialisms: ['audience-sync'],
      creative_agents: [],
      channels: [],
      pricingModels: ['cpm'],
      config,
    },
    statusMappers: {},
    accounts: {
      resolve: async () => ({
        id: 'idg_acc_1',
        metadata: { graph_id: 'IG-12345' },
        authInfo: { kind: 'api_key' },
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    audiences: {
      syncAudiences: async audiences => {
        const results = [];
        const accountId = 'idg_acc_1';

        for (const aud of audiences) {
          const audienceId = aud.audience_id ?? `aud_${Math.random()}`;
          const identifiers = aud.identifiers ?? [];

          if (identifiers.length < config.minIdentifiers) {
            results.push({
              audience_id: audienceId,
              action: 'rejected',
              status: 'failed',
              reason: `Too small: ${identifiers.length} (min ${config.minIdentifiers})`,
            });
            continue;
          }

          const isUpdate = audienceState.has(audienceId);
          const initial = { audience_id: audienceId, status: 'matching' };
          audienceState.set(audienceId, initial);

          setTimeout(() => {
            const matched = Math.floor(identifiers.length * config.defaultMatchRate);
            audienceState.set(audienceId, {
              audience_id: audienceId,
              status: 'matched',
              matched_count: matched,
              match_rate: config.defaultMatchRate,
            });
            publishStatusChange({
              account_id: accountId,
              resource_type: 'audience',
              resource_id: audienceId,
              payload: { status: 'matched', matched_count: matched, match_rate: config.defaultMatchRate },
            });
            setTimeout(() => {
              audienceState.set(audienceId, { ...audienceState.get(audienceId), status: 'activating' });
              publishStatusChange({
                account_id: accountId,
                resource_type: 'audience',
                resource_id: audienceId,
                payload: { status: 'activating' },
              });
              setTimeout(() => {
                audienceState.set(audienceId, { ...audienceState.get(audienceId), status: 'active' });
                publishStatusChange({
                  account_id: accountId,
                  resource_type: 'audience',
                  resource_id: audienceId,
                  payload: { status: 'active' },
                });
              }, config.activationLatencyMs).unref?.();
            }, 5).unref?.();
          }, config.matchLatencyMs).unref?.();

          results.push({
            audience_id: audienceId,
            action: isUpdate ? 'updated' : 'created',
            status: 'matching',
            matched_count: 0,
            match_rate: 0,
          });
        }

        return results;
      },

      pollAudienceStatuses: async audienceIds => {
        const out = new Map();
        for (const audienceId of audienceIds) {
          const s = audienceState.get(audienceId);
          if (s) out.set(audienceId, s.status);
        }
        return out;
      },
    },
  };
}

function buildServer(platform) {
  return createAdcpServerFromPlatform(platform, {
    name: 'IdentityGraph',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
  });
}

describe('IdentityGraphProvider — sync ack + multi-stage status changes', () => {
  it('syncAudiences returns matching status immediately; lifecycle channel emits matched/activating/active', async () => {
    const platform = makeIdentityGraph({ minIdentifiers: 3, matchLatencyMs: 20, activationLatencyMs: 20 });
    const bus = createInMemoryStatusChangeBus();
    const prevBus = setStatusChangeBus(bus);
    const received = [];
    bus.subscribe(evt => received.push(evt));

    try {
      const server = buildServer(platform);
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'sync_audiences',
          arguments: {
            audiences: [{ audience_id: 'aud_42', identifiers: ['e1', 'e2', 'e3', 'e4'] }],
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            account: { account_id: 'idg_acc_1' },
          },
        },
      });

      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      const auds = result.structuredContent.audiences;
      assert.strictEqual(auds[0].audience_id, 'aud_42');
      assert.strictEqual(auds[0].status, 'matching');
      assert.strictEqual(auds[0].action, 'created');

      // Wait for the full match → activating → active pipeline
      await waitFor(
        () =>
          received.filter(e => e.resource_type === 'audience' && e.resource_id === 'aud_42')
            .length >= 3
      );

      const stages = received
        .filter(e => e.resource_type === 'audience' && e.resource_id === 'aud_42')
        .map(e => e.payload.status);
      assert.deepStrictEqual(stages, ['matched', 'activating', 'active']);
    } finally {
      setStatusChangeBus(prevBus);
    }
  });

  it('audience below minIdentifiers rejects with reason in sync row (no status changes)', async () => {
    const platform = makeIdentityGraph({ minIdentifiers: 100 });
    const bus = createInMemoryStatusChangeBus();
    const prevBus = setStatusChangeBus(bus);
    const received = [];
    bus.subscribe(evt => received.push(evt));

    try {
      const server = buildServer(platform);
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'sync_audiences',
          arguments: {
            audiences: [{ audience_id: 'aud_small', identifiers: ['e1', 'e2'] }],
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            account: { account_id: 'idg_acc_1' },
          },
        },
      });

      const aud = result.structuredContent.audiences[0];
      assert.strictEqual(aud.status, 'failed');
      assert.strictEqual(aud.action, 'rejected');
      assert.match(aud.reason, /Too small/);

      // No status changes for rejected audiences
      await new Promise(r => setTimeout(r, 30));
      const audEvents = received.filter(e => e.resource_id === 'aud_small');
      assert.strictEqual(audEvents.length, 0);
    } finally {
      setStatusChangeBus(prevBus);
    }
  });

  it('multiple audiences in one batch get independent lifecycle channels', async () => {
    const platform = makeIdentityGraph({ minIdentifiers: 3, matchLatencyMs: 15, activationLatencyMs: 15 });
    const bus = createInMemoryStatusChangeBus();
    const prevBus = setStatusChangeBus(bus);
    const received = [];
    bus.subscribe(evt => received.push(evt));

    try {
      const server = buildServer(platform);
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'sync_audiences',
          arguments: {
            audiences: [
              { audience_id: 'aud_a', identifiers: ['e1', 'e2', 'e3', 'e4'] },
              { audience_id: 'aud_b', identifiers: ['e5', 'e6', 'e7'] },
            ],
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            account: { account_id: 'idg_acc_1' },
          },
        },
      });

      await waitFor(
        () =>
          received.filter(e => e.resource_id === 'aud_a').length >= 3 &&
          received.filter(e => e.resource_id === 'aud_b').length >= 3
      );

      const a = received.filter(e => e.resource_id === 'aud_a').map(e => e.payload.status);
      const b = received.filter(e => e.resource_id === 'aud_b').map(e => e.payload.status);
      assert.deepStrictEqual(a, ['matched', 'activating', 'active']);
      assert.deepStrictEqual(b, ['matched', 'activating', 'active']);
    } finally {
      setStatusChangeBus(prevBus);
    }
  });
});
