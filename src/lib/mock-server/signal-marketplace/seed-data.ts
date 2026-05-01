export interface MockCohort {
  cohort_id: string;
  name: string;
  description: string;
  category: 'behavioral' | 'demographic' | 'intent' | 'contextual' | 'retargeting';
  member_count: number;
  total_universe: number;
  freshness_days: number;
  activation_status: 'active' | 'draft' | 'archived';
  data_provider_domain: string;
  data_provider_id: string;
  /** Human-readable name of the upstream data provider — flows directly to
   * AdCP `signal_id.data_provider` (required by signals response schema).
   * Without it, adapters have to fabricate the value from the domain, which
   * trains the wrong reflex. */
  data_provider_name: string;
  value_type: 'binary' | 'numeric' | 'categorical';
  range?: { min: number; max: number };
  categories?: string[];
  pricing: MockPricingTier[];
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MockPricingTier {
  pricing_id: string;
  model: 'cpm';
  cpm_amount: number;
  currency: string;
  minimum_spend?: number;
}

export interface MockDestination {
  destination_id: string;
  name: string;
  platform_type: 'dsp' | 'ssp' | 'social' | 'ctv' | 'retail' | 'agent';
  integration: 'api_push' | 'segment_id' | 'key_value' | 'agent_url';
  platform_code?: string;
  agent_url?: string;
  expected_match_rate?: number;
}

export interface MockOperator {
  operator_id: string;
  display_name: string;
  /** AdCP-side operator identifier the adapter receives in `account.operator`. */
  adcp_operator: string;
  visible_cohort_ids: string[];
  visible_destination_ids: string[];
  /** Map of cohort_id → operator-scoped pricing override. Falls back to default pricing if absent. */
  pricing_overrides: Record<string, MockPricingTier[]>;
}

const NOW = '2026-04-15T12:00:00Z';
const RECENT = '2026-04-30T08:30:00Z';

/**
 * Default pricing for each cohort. Operator-specific overrides live on the
 * MockOperator entries below — this is what `op_pinnacle` (the storyboard's
 * operator) sees. A second operator in this fixture (`op_summit`) sees the
 * same Trident cohorts at a different rate.
 */
export const COHORTS: MockCohort[] = [
  {
    cohort_id: 'ckhsh_us_evb_2024q4_001',
    name: 'Likely EV Buyers (Trident, US)',
    description:
      'Auto-intent shoppers showing strong EV-specific signals — model-comparison sessions, charger-locator activity, and EV-incentive content engagement.',
    category: 'intent',
    member_count: 8_000_000,
    total_universe: 100_000_000,
    freshness_days: 1,
    activation_status: 'active',
    data_provider_domain: 'tridentauto.example',
    data_provider_id: 'likely_ev_buyers',
    data_provider_name: 'Trident Auto Insights',
    value_type: 'binary',
    pricing: [
      {
        pricing_id: 'tier_default_evb_cpm',
        model: 'cpm',
        cpm_amount: 3.5,
        currency: 'USD',
      },
    ],
    metadata: { trident_taxonomy_version: '2024.4' },
    created_at: NOW,
    updated_at: RECENT,
  },
  {
    cohort_id: 'ckhsh_us_pp_2024q4_002',
    name: 'Purchase Propensity Score (Trident, US)',
    description:
      'Per-user 0-1 propensity score for next-90-day vehicle purchase, modeled across browsing, dealership-visit, and credit-shopping signals.',
    category: 'behavioral',
    member_count: 55_000_000,
    total_universe: 100_000_000,
    freshness_days: 7,
    activation_status: 'active',
    data_provider_domain: 'tridentauto.example',
    data_provider_id: 'purchase_propensity',
    data_provider_name: 'Trident Auto Insights',
    value_type: 'numeric',
    range: { min: 0, max: 1 },
    pricing: [
      {
        pricing_id: 'tier_default_pp_cpm',
        model: 'cpm',
        cpm_amount: 4.0,
        currency: 'USD',
      },
    ],
    metadata: { trident_taxonomy_version: '2024.4' },
    created_at: NOW,
    updated_at: RECENT,
  },
  {
    cohort_id: 'ckhsh_us_cv_2024q4_003',
    name: 'Competitor Dealer Visitors (Meridian, US)',
    description:
      'Mobile devices observed in geofenced areas around competitor auto-dealer locations within the past 30 days.',
    category: 'behavioral',
    member_count: 6_000_000,
    total_universe: 100_000_000,
    freshness_days: 3,
    activation_status: 'active',
    data_provider_domain: 'meridiangeo.example',
    data_provider_id: 'competitor_visitors',
    data_provider_name: 'Meridian Geo',
    value_type: 'binary',
    pricing: [
      {
        pricing_id: 'tier_default_cv_cpm',
        model: 'cpm',
        cpm_amount: 5.0,
        currency: 'USD',
      },
    ],
    metadata: { meridian_geo_radius_meters: 250 },
    created_at: NOW,
    updated_at: RECENT,
  },
  {
    cohort_id: 'ckhsh_us_ntb_2024q4_004',
    name: 'New-to-Brand Auto Shoppers (ShopGrid, US)',
    description:
      'Shoppers researching auto purchases who have no prior transaction history with target brand. Built from ShopGrid retail-exhaust data.',
    category: 'intent',
    member_count: 25_000_000,
    total_universe: 100_000_000,
    freshness_days: 2,
    activation_status: 'active',
    data_provider_domain: 'shopgrid.example',
    data_provider_id: 'new_to_brand',
    data_provider_name: 'ShopGrid Retail Data',
    value_type: 'binary',
    pricing: [
      {
        pricing_id: 'tier_default_ntb_cpm',
        model: 'cpm',
        cpm_amount: 3.5,
        currency: 'USD',
      },
    ],
    metadata: { shopgrid_lookback_days: 180 },
    created_at: NOW,
    updated_at: RECENT,
  },
];

export const DESTINATIONS: MockDestination[] = [
  {
    destination_id: 'dest_ttd_main',
    name: 'The Trade Desk — Production',
    platform_type: 'dsp',
    integration: 'segment_id',
    platform_code: 'the-trade-desk',
    expected_match_rate: 0.78,
  },
  {
    destination_id: 'dest_streamhaus_ctv',
    name: 'StreamHaus CTV',
    platform_type: 'ctv',
    integration: 'segment_id',
    platform_code: 'streamhaus',
    expected_match_rate: 0.62,
  },
  {
    destination_id: 'dest_wonderstruck_agent',
    name: 'Wonderstruck Sales Agent',
    platform_type: 'agent',
    integration: 'agent_url',
    agent_url: 'https://wonderstruck.salesagents.example',
    expected_match_rate: 0.95,
  },
];

/**
 * Mapping table the adapter has to consume. The AdCP request carries
 * `account.operator: "pinnacle-agency.example"`; the adapter maps that to
 * the upstream operator_id and sends `X-Operator-Id` accordingly.
 *
 * Two operators are seeded so the adapter MUST respect the mapping — using
 * the wrong operator id (or omitting the header) yields a different cohort
 * set and the storyboard fails.
 */
export const OPERATORS: MockOperator[] = [
  {
    operator_id: 'op_pinnacle',
    display_name: 'Pinnacle Agency',
    adcp_operator: 'pinnacle-agency.example',
    visible_cohort_ids: COHORTS.map(c => c.cohort_id),
    visible_destination_ids: DESTINATIONS.map(d => d.destination_id),
    pricing_overrides: {},
  },
  {
    operator_id: 'op_summit',
    display_name: 'Summit Media',
    adcp_operator: 'summit-media.example',
    // Only sees Trident cohorts.
    visible_cohort_ids: ['ckhsh_us_evb_2024q4_001', 'ckhsh_us_pp_2024q4_002'],
    visible_destination_ids: ['dest_ttd_main', 'dest_streamhaus_ctv'],
    // Premium rate card — same cohorts, +$1 CPM.
    pricing_overrides: {
      ckhsh_us_evb_2024q4_001: [
        {
          pricing_id: 'tier_summit_evb_cpm',
          model: 'cpm',
          cpm_amount: 4.5,
          currency: 'USD',
          minimum_spend: 10_000,
        },
      ],
      ckhsh_us_pp_2024q4_002: [
        {
          pricing_id: 'tier_summit_pp_cpm',
          model: 'cpm',
          cpm_amount: 5.0,
          currency: 'USD',
          minimum_spend: 10_000,
        },
      ],
    },
  },
];

/**
 * Default static API key shared across all operators owned by the customer.
 * Override at boot via `--api-key` if a test wants a different value.
 */
export const DEFAULT_API_KEY = 'mock_signal_market_key_do_not_use_in_prod';
