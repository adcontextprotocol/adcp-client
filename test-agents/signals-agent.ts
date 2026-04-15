/**
 * Signals agent — built strictly from skills/build-signals-agent/SKILL.md
 * Marketplace signals agent with 4 audience segments, CPM pricing, DSP activation
 */

import { createAdcpServer, serve, adcpError } from '@adcp/client';
import type { GetSignalsResponse } from '@adcp/client';

type Signal = GetSignalsResponse['signals'][number];

const SIGNALS: Signal[] = [
  {
    signal_agent_segment_id: 'seg_auto_intenders',
    name: 'Auto Intenders',
    description: 'Users actively researching vehicle purchases in the last 30 days',
    signal_type: 'marketplace',
    data_provider: 'DataCo Audiences',
    coverage_percentage: 12,
    deployments: [],
    pricing_options: [{ pricing_option_id: 'po_cpm_auto', model: 'cpm', cpm: 3.5, currency: 'USD' }],
    signal_id: { source: 'catalog', data_provider_domain: 'dataco-audiences.com', id: 'auto_intenders_30d' },
    value_type: 'binary',
  },
  {
    signal_agent_segment_id: 'seg_luxury_shoppers',
    name: 'Luxury Shoppers',
    description: 'High-income consumers browsing premium retail and fashion brands',
    signal_type: 'marketplace',
    data_provider: 'DataCo Audiences',
    coverage_percentage: 8,
    deployments: [],
    pricing_options: [{ pricing_option_id: 'po_cpm_luxury', model: 'cpm', cpm: 5.0, currency: 'USD' }],
    signal_id: { source: 'catalog', data_provider_domain: 'dataco-audiences.com', id: 'luxury_shoppers' },
    value_type: 'binary',
  },
  {
    signal_agent_segment_id: 'seg_fitness_enthusiasts',
    name: 'Fitness Enthusiasts',
    description: 'Users engaging with health, fitness, and wellness content',
    signal_type: 'marketplace',
    data_provider: 'DataCo Audiences',
    coverage_percentage: 18,
    deployments: [],
    pricing_options: [{ pricing_option_id: 'po_cpm_fitness', model: 'cpm', cpm: 2.0, currency: 'USD' }],
    signal_id: { source: 'catalog', data_provider_domain: 'dataco-audiences.com', id: 'fitness_enthusiasts' },
    value_type: 'binary',
  },
  {
    signal_agent_segment_id: 'seg_travel_planners',
    name: 'Travel Planners',
    description: 'Users researching flights, hotels, and vacation destinations',
    signal_type: 'marketplace',
    data_provider: 'DataCo Audiences',
    coverage_percentage: 15,
    deployments: [],
    pricing_options: [{ pricing_option_id: 'po_cpm_travel', model: 'cpm', cpm: 2.75, currency: 'USD' }],
    signal_id: { source: 'catalog', data_provider_domain: 'dataco-audiences.com', id: 'travel_planners' },
    value_type: 'binary',
  },
];

serve(() =>
  createAdcpServer({
    name: 'DataCo Signals Agent',
    version: '1.0.0',

    signals: {
      getSignals: async (params, ctx) => {
        let results = [...SIGNALS];

        // Natural language search
        if (params.signal_spec) {
          const query = params.signal_spec.toLowerCase();
          results = results.filter(
            s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
          );
        }

        // Exact lookup by signal_ids
        if (params.signal_ids) {
          results = results.filter(s => params.signal_ids!.some((id: any) => id.id === s.signal_id!.id));
        }

        // Filters
        if (params.filters?.max_cpm) {
          results = results.filter(s =>
            s.pricing_options.some((po: any) => po.model === 'cpm' && po.cpm <= params.filters!.max_cpm!)
          );
        }
        if (params.filters?.min_coverage_percentage) {
          results = results.filter(s => s.coverage_percentage >= params.filters!.min_coverage_percentage!);
        }

        // Limit
        if (params.max_results) {
          results = results.slice(0, params.max_results);
        }

        return { signals: results, sandbox: true };
      },

      activateSignal: async (params, ctx) => {
        const signal = SIGNALS.find(s => s.signal_agent_segment_id === params.signal_agent_segment_id);
        if (!signal) {
          return adcpError('INVALID_REQUEST', {
            message: `Unknown segment: ${params.signal_agent_segment_id}`,
            field: 'signal_agent_segment_id',
            suggestion: 'Use get_signals to discover available segments',
          });
        }

        // Validate pricing option
        if (params.pricing_option_id) {
          const po = signal.pricing_options.find((p: any) => p.pricing_option_id === params.pricing_option_id);
          if (!po) {
            return adcpError('INVALID_REQUEST', {
              message: `Unknown pricing option: ${params.pricing_option_id}`,
              field: 'pricing_option_id',
            });
          }
        }

        // Persist activation
        await ctx.store.put('activations', params.signal_agent_segment_id, {
          signal_agent_segment_id: params.signal_agent_segment_id,
          destinations: params.destinations,
          activated_at: new Date().toISOString(),
        });

        const deployments = params.destinations.map((dest: any) => ({
          ...dest,
          is_live: true,
          activation_key:
            dest.type === 'platform'
              ? { type: 'segment_id' as const, segment_id: `seg_${signal.signal_id!.id}_${dest.platform}` }
              : { type: 'key_value' as const, key: 'audience', value: signal.signal_id!.id },
        }));

        return { deployments, sandbox: true };
      },
    },
  })
);
