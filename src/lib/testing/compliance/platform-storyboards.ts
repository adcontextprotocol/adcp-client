/**
 * Maps platform types to their curated storyboard sets.
 *
 * PLATFORM_STORYBOARDS is the bridge between platform_type declarations
 * and the storyboard engine. A platform type resolves to storyboards;
 * storyboards define what to test. Tracks become a reporting layer
 * derived from storyboard results, not a routing mechanism.
 *
 * Each entry lists storyboard IDs in recommended execution order.
 * Derived from the platform_types field in each storyboard YAML.
 */

import type { PlatformType } from './types';
import type { Storyboard } from '../storyboard/types';

/**
 * Curated storyboard sets per platform type.
 *
 * When comply() receives a platform_type, this mapping determines which
 * storyboards to run. Storyboards without platform_types (e.g., schema_validation,
 * error_compliance) are universal and included automatically when the agent
 * has the required tools.
 */
export const PLATFORM_STORYBOARDS: Record<PlatformType, string[]> = {
  // ── Sales platforms ──────────────────────────────────────

  display_ad_server: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_guaranteed_approval',
    'media_buy_seller',
    'audience_sync',
    'deterministic_testing',
  ],

  video_ad_server: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_guaranteed_approval',
    'media_buy_seller',
    'deterministic_testing',
  ],

  social_platform: [
    'schema_validation',
    'behavioral_analysis',
    'creative_sales_agent',
    'media_buy_non_guaranteed',
    'media_buy_seller',
    'audience_sync',
    'signal_owned',
    'deterministic_testing',
  ],

  pmax_platform: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_non_guaranteed',
    'media_buy_proposal_mode',
    'media_buy_seller',
    'audience_sync',
    'signal_marketplace',
    'signal_owned',
    'deterministic_testing',
  ],

  dsp: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_governance_escalation',
    'media_buy_non_guaranteed',
    'media_buy_proposal_mode',
    'media_buy_seller',
    'audience_sync',
    'deterministic_testing',
  ],

  retail_media: [
    'schema_validation',
    'behavioral_analysis',
    'creative_sales_agent',
    'media_buy_catalog_creative',
    'media_buy_proposal_mode',
    'media_buy_seller',
    'audience_sync',
    'signal_owned',
    'deterministic_testing',
  ],

  search_platform: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_non_guaranteed',
    'media_buy_seller',
    'deterministic_testing',
  ],

  audio_platform: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_guaranteed_approval',
    'media_buy_seller',
    'audience_sync',
    'deterministic_testing',
  ],

  linear_tv_platform: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_guaranteed_approval',
    'media_buy_seller',
    'deterministic_testing',
  ],

  // ── Creative agents ──────────────────────────────────────

  creative_transformer: ['schema_validation', 'creative_template'],

  creative_library: ['schema_validation', 'creative_template'],

  creative_ad_server: ['schema_validation', 'creative_ad_server'],

  // ── Sponsored intelligence ───────────────────────────────

  si_platform: ['schema_validation', 'si_session'],

  // ── AI-native platforms ──────────────────────────────────

  ai_ad_network: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_governance_escalation',
    'media_buy_seller',
    'signal_marketplace',
    'deterministic_testing',
  ],

  ai_platform: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_non_guaranteed',
    'media_buy_seller',
    'signal_marketplace',
    'deterministic_testing',
  ],

  generative_dsp: [
    'schema_validation',
    'behavioral_analysis',
    'media_buy_governance_escalation',
    'media_buy_non_guaranteed',
    'media_buy_proposal_mode',
    'media_buy_seller',
    'deterministic_testing',
  ],
};

/**
 * Get the storyboard IDs for a platform type.
 */
export function getStoryboardIdsForPlatform(platformType: PlatformType): string[] {
  return PLATFORM_STORYBOARDS[platformType] ?? [];
}

// ────────────────────────────────────────────────────────────
// Scenario extraction
// ────────────────────────────────────────────────────────────

/**
 * Valid TestScenario names that have standalone test runner functions.
 *
 * Used by filterToKnownScenarios() to validate comply_scenario values
 * extracted from storyboard YAML. Names not in this set are filtered out
 * as typos or phantom references.
 */
const KNOWN_SCENARIOS: ReadonlySet<string> = new Set([
  'health_check',
  'discovery',
  'create_media_buy',
  'full_sales_flow',
  'reporting_flow',
  'creative_sync',
  'creative_inline',
  'creative_reference',
  'pricing_models',
  'creative_flow',
  'creative_lifecycle',
  'signals_flow',
  'error_handling',
  'validation',
  'pricing_edge_cases',
  'temporal_validation',
  'behavior_analysis',
  'response_consistency',
  'governance_property_lists',
  'governance_content_standards',
  'property_list_filters',
  'campaign_governance',
  'campaign_governance_denied',
  'campaign_governance_conditions',
  'campaign_governance_delivery',
  'seller_governance_context',
  'si_session_lifecycle',
  'si_availability',
  'si_handoff',
  'capability_discovery',
  'schema_compliance',
  'sync_audiences',
  'media_buy_lifecycle',
  'terminal_state_enforcement',
  'package_lifecycle',
  'error_codes',
  'error_structure',
  'error_transport',
  'deterministic_creative',
  'deterministic_media_buy',
  'deterministic_account',
  'deterministic_session',
  'deterministic_delivery',
  'deterministic_budget',
  'controller_validation',
  'brand_rights_flow',
]);

/**
 * Extract comply_scenario names from a storyboard's steps.
 *
 * Walks all phases and steps, collecting unique comply_scenario values.
 * Returns deduplicated names in the order they first appear.
 */
export function extractScenariosFromStoryboard(storyboard: Storyboard): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      if (step.comply_scenario && !seen.has(step.comply_scenario)) {
        seen.add(step.comply_scenario);
        result.push(step.comply_scenario);
      }
    }
  }

  return result;
}

/**
 * Filter scenario names to only those in the known TestScenario set.
 *
 * Validates scenario names extracted from storyboard YAML against the
 * known scenario set, filtering out typos or phantom names.
 */
export function filterToKnownScenarios(scenarios: string[]): string[] {
  return scenarios.filter(s => KNOWN_SCENARIOS.has(s));
}
