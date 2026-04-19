/**
 * Example: Signals Agent (Server)
 *
 * Demonstrates building an AdCP signals agent that serves audience segments
 * via `get_signals` and accepts `activate_signal` with idempotency.
 *
 * Run with:
 *
 *   npx tsx examples/signals-agent.ts
 *
 * Then test with:
 *
 *   npx @adcp/client http://localhost:3001/mcp
 *   npx @adcp/client http://localhost:3001/mcp get_signals '{"signal_spec":"audience segments"}'
 *   npx @adcp/client http://localhost:3001/mcp get_signals '{"signal_spec":"shoppers"}'
 *   npx @adcp/client http://localhost:3001/mcp get_signals '{"filters":{"catalog_types":["marketplace"]}}'
 */

import { createAdcpServer, serve } from '@adcp/client';
import { createIdempotencyStore, memoryBackend } from '@adcp/client/server';
import type { GetSignalsResponse, ServeContext } from '@adcp/client';

// ---------------------------------------------------------------------------
// Audience segment catalog — typed to match the AdCP signals response schema
// ---------------------------------------------------------------------------
type Signal = GetSignalsResponse['signals'][number];

const SEGMENTS: Signal[] = [
  {
    signal_agent_segment_id: 'high_intent_shoppers',
    signal_id: {
      source: 'catalog',
      data_provider_domain: 'example-signals.com',
      id: 'high_intent_shoppers',
    },
    name: 'High Intent Shoppers',
    description: 'Users who visited product pages 3+ times in the last 7 days without purchasing.',
    value_type: 'binary',
    signal_type: 'owned',
    data_provider: 'Example Signals Agent',
    coverage_percentage: 12,
    deployments: [],
    pricing_options: [
      {
        pricing_option_id: 'po_high_intent_cpm',
        model: 'cpm',
        currency: 'USD',
        cpm: 6,
      },
    ],
  },
  {
    signal_agent_segment_id: 'lapsed_subscribers',
    signal_id: {
      source: 'catalog',
      data_provider_domain: 'example-signals.com',
      id: 'lapsed_subscribers',
    },
    name: 'Lapsed Subscribers',
    description: 'Email subscribers who have not opened in 90+ days but previously had high engagement.',
    value_type: 'binary',
    signal_type: 'custom',
    data_provider: 'Example Signals Agent',
    coverage_percentage: 8,
    deployments: [],
    pricing_options: [
      {
        pricing_option_id: 'po_lapsed_cpm',
        model: 'cpm',
        currency: 'USD',
        cpm: 3,
      },
    ],
  },
  {
    signal_agent_segment_id: 'geo_urban_commuters',
    signal_id: {
      source: 'catalog',
      data_provider_domain: 'example-signals.com',
      id: 'geo_urban_commuters',
    },
    name: 'Urban Commuters',
    description: 'Users whose location data indicates daily commute patterns through major metro areas.',
    value_type: 'binary',
    signal_type: 'marketplace',
    data_provider: 'Example Signals Agent',
    coverage_percentage: 22,
    deployments: [],
    pricing_options: [
      {
        pricing_option_id: 'po_urban_cpm',
        model: 'cpm',
        currency: 'USD',
        cpm: 5,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Query logic — filters segments by spec, IDs, and catalog type
// ---------------------------------------------------------------------------
function querySegments(args: {
  signal_spec?: string | null;
  signal_ids?: Array<{ id: string }> | null;
  catalog_types?: string[] | null;
  max_results?: number | null;
}): Signal[] {
  let results = [...SEGMENTS];

  if (args.signal_ids?.length) {
    const ids = new Set(args.signal_ids.map(s => s.id));
    results = results.filter(s => ids.has(s.signal_agent_segment_id));
  }

  if (args.catalog_types?.length) {
    results = results.filter(s => args.catalog_types!.includes(s.signal_type));
  }

  if (args.signal_spec) {
    const spec = args.signal_spec.toLowerCase();
    results = results.filter(s => s.name.toLowerCase().includes(spec) || s.description.toLowerCase().includes(spec));
  }

  if (args.max_results) {
    results = results.slice(0, args.max_results);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
const idempotency = createIdempotencyStore({
  backend: memoryBackend(),
  ttlSeconds: 86400,
});

function createSignalsAgent({ taskStore }: ServeContext) {
  return createAdcpServer({
    name: 'Example Signals Agent',
    version: '1.0.0',
    taskStore,
    idempotency,
    // Principal scope for idempotency. A constant works for a no-auth
    // demo; multi-tenant agents type the account via
    // `createAdcpServer<MyAccount>({...})` and use `ctx.account?.id`.
    resolveSessionKey: () => 'default-principal',
    instructions: 'Signals agent providing audience segment discovery via get_signals.',

    signals: {
      getSignals: async params => {
        const signals = querySegments({
          signal_spec: params.signal_spec,
          signal_ids: params.signal_ids,
          catalog_types: params.filters?.catalog_types,
          max_results: params.max_results,
        });
        return { signals, sandbox: true };
      },
      activateSignal: async params => {
        // Per the compliance spec: platform (DSP) activation is ASYNC,
        // agent (sales-agent) activation is SYNC. The buyer polls for
        // platform activations (subsequent activate_signal call) until
        // is_live flips to true.
        const deployments = params.destinations.map(dest => {
          if (dest.type === 'platform') {
            return {
              type: 'platform' as const,
              platform: dest.platform,
              is_live: false,
              estimated_activation_duration_minutes: 30,
              activation_key: {
                type: 'segment_id' as const,
                segment_id: `${dest.platform}_${params.signal_agent_segment_id}`,
              },
            };
          }
          return {
            type: 'agent' as const,
            agent_url: dest.agent_url,
            is_live: true,
            activation_key: {
              type: 'key_value' as const,
              key: 'audience',
              value: params.signal_agent_segment_id,
            },
            deployed_at: new Date().toISOString(),
          };
        });
        return { deployments, sandbox: true };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
serve(createSignalsAgent);
