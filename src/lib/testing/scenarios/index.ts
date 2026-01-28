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
  selectProduct,
  selectPricingOption,
  buildCreateMediaBuyRequest,
} from './media-buy';

// Creative agent testing
export { testCreativeFlow } from './creative';

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
  hasGovernanceTools,
} from './governance';

// v3 SI (Sponsored Intelligence) protocol testing
export {
  testSISessionLifecycle,
  testSIAvailability,
  hasSITools,
} from './sponsored-intelligence';

// v3 Capability discovery testing
export {
  testCapabilityDiscovery,
  likelySupportsV3,
} from './capabilities';
