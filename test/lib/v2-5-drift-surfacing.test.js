// End-to-end: when SingleAgentClient sends a request to a v2-detected
// agent and the adapted shape doesn't conform to v2.5, the drift must
// surface via result.debug_logs. Without this plumbing, the
// warn-only post-adapter pass silently dropped warnings on the floor —
// adapters could regress in production without anyone noticing until a
// seller reported it.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { AdCPClient, ProtocolClient } = require('../../dist/lib/index.js');
const { hasSchemaBundle } = require('../../dist/lib/validation/schema-loader.js');

const V2_5_AVAILABLE = hasSchemaBundle('v2.5');

describe(
  'v2.5 drift surfaces via result.debug_logs',
  { skip: V2_5_AVAILABLE ? false : 'v2.5 bundle not cached — run `npm run sync-schemas:v2.5`' },
  () => {
    function buildV2Client(taskName, capturedCalls) {
      const mockMCPAgent = {
        id: 'v2-agent',
        name: 'V2 Agent',
        agent_uri: 'https://agents.example.com/mcp',
        protocol: 'mcp',
      };
      const client = new AdCPClient([mockMCPAgent]);
      const agent = client.agent(mockMCPAgent.id);
      const inner = agent.client;
      inner.discoveredEndpoint = mockMCPAgent.agent_uri;
      inner.cachedCapabilities = {
        version: 'v2',
        majorVersions: [2],
        protocols: ['media_buy', 'creative'],
        features: {
          inlineCreativeManagement: false,
          conversionTracking: false,
          audienceTargeting: false,
          propertyListFiltering: false,
          contentStandards: false,
        },
        extensions: [],
        _synthetic: false,
      };
      const original = ProtocolClient.callTool;
      ProtocolClient.callTool = async (_cfg, name, args) => {
        capturedCalls.push({ name, args });
        // Return a minimal valid v2 response shape per task — the test
        // cares about request-side drift logs, not response normalization.
        if (name === 'sync_creatives') return { results: [] };
        if (name === 'create_media_buy') return { media_buy_id: 'mb-1', status: 'completed' };
        return {};
      };
      return { agent, restore: () => (ProtocolClient.callTool = original) };
    }

    test('sync_creatives v3-manifest input emits a v2.5 drift warning to debug_logs', async () => {
      // sync_creatives is a known-drift case (#1116) — v3 manifest shape
      // fails v2.5's single-asset payload oneOf. Until that adapter is
      // rewritten, every sync_creatives call to a v2 agent should surface
      // the drift in result.debug_logs.
      const captured = [];
      const { agent, restore } = buildV2Client('sync_creatives', captured);
      try {
        const result = await agent.syncCreatives({
          account: { account_id: 'acct-1' },
          creatives: [
            {
              creative_id: 'cre-1',
              name: 'Test Creative',
              format_id: { agent_url: 'https://test.example', id: 'format1' },
              assets: {
                video: {
                  asset_type: 'video',
                  url: 'https://example.com/video.mp4',
                  width: 1920,
                  height: 1080,
                  duration_ms: 30000,
                },
              },
            },
          ],
        });

        const logs = (result.debug_logs ?? []).filter(
          e => e?.type === 'warning' && /sync_creatives/.test(e?.message ?? '')
        );
        assert.ok(
          logs.length > 0,
          `expected v2.5 drift warning in debug_logs for sync_creatives. ` +
            `Got: ${JSON.stringify(result.debug_logs ?? [], null, 2)}`
        );
        const issuePointers = logs.flatMap(e => (Array.isArray(e.issues) ? e.issues.map(i => i.pointer) : []));
        assert.ok(
          issuePointers.some(p => p.startsWith('/creatives/0/assets')),
          `expected drift pointer under /creatives/0/assets; got: ${issuePointers.join(', ')}`
        );
      } finally {
        restore();
      }
    });

    test('clean v3 input to a v2 agent surfaces no v2.5 drift warning', async () => {
      // get_products is conformant after the v2 adapter strips v3-only
      // fields. No drift entries should appear.
      const captured = [];
      const { agent, restore } = buildV2Client('get_products', captured);
      try {
        const result = await agent.getProducts({
          buying_mode: 'brief',
          brief: 'Premium ad placements',
          brand: { domain: 'example.com' },
        });
        const driftLogs = (result.debug_logs ?? []).filter(
          e => e?.type === 'warning' && /get_products/.test(e?.message ?? '')
        );
        assert.strictEqual(
          driftLogs.length,
          0,
          `clean adapted shape should not produce v2.5 drift warnings. Got: ${JSON.stringify(driftLogs)}`
        );
      } finally {
        restore();
      }
    });

    test('v3-detected agent does not produce v2.5 drift warnings (gate is correct)', async () => {
      // The v2.5 pass is gated on serverVersion === 'v2'. A v3 agent must
      // never trigger it, even on inputs that would fail v2.5 validation.
      const mockMCPAgent = {
        id: 'v3-agent',
        name: 'V3 Agent',
        agent_uri: 'https://agents.example.com/mcp',
        protocol: 'mcp',
      };
      const client = new AdCPClient([mockMCPAgent]);
      const agent = client.agent(mockMCPAgent.id);
      const inner = agent.client;
      inner.discoveredEndpoint = mockMCPAgent.agent_uri;
      inner.cachedCapabilities = {
        version: 'v3',
        majorVersions: [3],
        protocols: ['media_buy'],
        features: {
          inlineCreativeManagement: false,
          conversionTracking: false,
          audienceTargeting: false,
          propertyListFiltering: false,
          contentStandards: false,
        },
        extensions: [],
        _synthetic: false,
        idempotency: { replayTtlSeconds: 3600 },
      };

      const original = ProtocolClient.callTool;
      ProtocolClient.callTool = async () => ({ products: [] });
      try {
        const result = await agent.getProducts({
          buying_mode: 'brief',
          brief: 'test',
        });
        const v25Drift = (result.debug_logs ?? []).filter(
          e => e?.type === 'warning' && /v2\.5|get_products/.test(e?.message ?? '')
        );
        // No v2.5-specific drift entries should fire on a v3 agent.
        // (The pre-send v3 pass may write its own warn entries; those
        // are not v2.5 drift, hence the message filter above.)
        for (const log of v25Drift) {
          assert.ok(
            !/v2\.5/.test(log.message ?? ''),
            `v3 agent must not produce v2.5 drift warnings. Got: ${JSON.stringify(log)}`
          );
        }
      } finally {
        ProtocolClient.callTool = original;
      }
    });
  }
);
