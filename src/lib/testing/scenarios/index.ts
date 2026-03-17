/**
 * Test Scenarios Index
 *
 * Re-exports all test scenarios for easy importing.
 */

// Health check
export { testHealthCheck } from './health';

// Discovery
export { testDiscovery } from './discovery';

// Media buy / sales flow
export {
  testCreateMediaBuy,
  testFullSalesFlow,
  testCreativeSync,
  testCreativeInline,
  testCreativeReference,
  testSyncAudiences,
  resolveAccountForAudiences,
  selectProduct,
  selectPricingOption,
  buildCreateMediaBuyRequest,
} from './media-buy';

// Creative agent testing
export { testCreativeFlow, testCreativeLifecycle } from './creative';

// Signals agent testing
export { testSignalsFlow } from './signals';

// Edge case testing
export {
  testErrorHandling,
  testValidation,
  testPricingEdgeCases,
  testTemporalValidation,
  testBehaviorAnalysis,
  testResponseConsistency,
} from './edge-cases';

// v3 Governance protocol testing
export {
  testGovernancePropertyLists,
  testGovernanceContentStandards,
  testPropertyListFilters,
  testCampaignGovernance,
  testCampaignGovernanceDenied,
  testCampaignGovernanceConditions,
  testCampaignGovernanceDelivery,
  hasGovernanceTools,
  hasCampaignGovernanceTools,
} from './governance';

// v3 SI (Sponsored Intelligence) protocol testing
export { testSISessionLifecycle, testSIAvailability, testSIHandoff, hasSITools } from './sponsored-intelligence';

// v3 Capability discovery testing
export { testCapabilityDiscovery, likelySupportsV3 } from './capabilities';

// Schema compliance testing
export { testSchemaCompliance } from './schema-compliance';
