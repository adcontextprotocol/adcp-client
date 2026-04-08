/**
 * Example: Signals Agent (Server)
 *
 * Demonstrates building an AdCP signals agent that serves audience segments
 * via the get_signals tool. Uses createTaskCapableServer for MCP task support
 * and generated Zod schemas for type-safe input validation.
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

import { createTaskCapableServer, taskToolResponse, serve, GetSignalsRequestSchema } from '@adcp/client';
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
function createSignalsAgent({ taskStore }: ServeContext) {
  const server = createTaskCapableServer('Example Signals Agent', '1.0.0', {
    taskStore,
    instructions: 'Signals agent providing audience segment discovery via get_signals.',
  });

  server.tool(
    'get_signals',
    'Discover audience segments. Supports natural language discovery via signal_spec or exact lookup via signal_ids.',
    GetSignalsRequestSchema.shape,
    async args => {
      const signals = querySegments({
        signal_spec: args.signal_spec,
        signal_ids: args.signal_ids,
        catalog_types: args.filters?.catalog_types,
        max_results: args.max_results,
      });

      return taskToolResponse({ signals, sandbox: true }, `Found ${signals.length} audience segment(s)`);
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
serve(createSignalsAgent);
