/**
 * Maps platform types to their curated storyboard sets.
 *
 * PLATFORM_STORYBOARDS is the bridge between platform_type declarations
 * and the storyboard engine. A platform type resolves to storyboards;
 * storyboards define what to test. Tracks become a reporting layer
 * derived from storyboard results, not a routing mechanism.
 *
 * Each entry lists storyboard IDs in recommended execution order.
 * Synced from the canonical adcp repo (adcontextprotocol/adcp).
 */

import type { PlatformType } from './types';
import type { Storyboard } from '../storyboard/types';

/**
 * Curated storyboard sets per platform type.
 *
 * Matches the canonical PLATFORM_STORYBOARDS mapping in the adcp repo
 * (server/src/addie/services/compliance-testing.ts). Keep these in sync.
 *
 * Storyboards without platform_types (universal storyboards) are
 * auto-included by resolveStoryboards() when the agent has the required tools.
 *
 * linear_tv_platform is client-only (not yet in the adcp repo PlatformType).
 */
export const PLATFORM_STORYBOARDS: Record<PlatformType, string[]> = {
  // ── Sales platforms ──────────────────────────────────────

  display_ad_server: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'audience_sync',
    'deterministic_testing',
    'error_compliance',
  ],

  video_ad_server: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'deterministic_testing',
    'error_compliance',
  ],

  social_platform: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'social_platform',
    'media_buy_state_machine',
    'audience_sync',
    'deterministic_testing',
    'error_compliance',
  ],

  pmax_platform: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'creative_lifecycle',
    'audience_sync',
    'deterministic_testing',
    'error_compliance',
  ],

  dsp: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'audience_sync',
    'deterministic_testing',
    'error_compliance',
  ],

  retail_media: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_catalog_creative',
    'media_buy_state_machine',
    'audience_sync',
    'deterministic_testing',
    'error_compliance',
  ],

  search_platform: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'deterministic_testing',
    'error_compliance',
  ],

  audio_platform: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'audience_sync',
    'deterministic_testing',
    'error_compliance',
  ],

  linear_tv_platform: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'deterministic_testing',
    'error_compliance',
  ],

  // ── Creative agents ──────────────────────────────────────

  creative_transformer: ['capability_discovery', 'creative_template'],

  creative_library: ['capability_discovery', 'creative_lifecycle'],

  creative_ad_server: ['capability_discovery', 'creative_ad_server'],

  // ── Sponsored intelligence ───────────────────────────────

  si_platform: ['capability_discovery', 'si_session'],

  // ── AI-native platforms ──────────────────────────────────

  ai_ad_network: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'creative_lifecycle',
    'deterministic_testing',
    'error_compliance',
  ],

  ai_platform: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'creative_template',
    'deterministic_testing',
    'error_compliance',
  ],

  generative_dsp: [
    'capability_discovery',
    'schema_validation',
    'behavioral_analysis',
    'media_buy_seller',
    'media_buy_state_machine',
    'creative_lifecycle',
    'deterministic_testing',
    'error_compliance',
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
  'brand_identity',
  'creative_approval',
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
