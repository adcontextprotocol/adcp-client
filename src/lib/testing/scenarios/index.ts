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
