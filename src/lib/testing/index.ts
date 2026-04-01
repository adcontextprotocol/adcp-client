// Test helpers for AdCP client library
// Provides pre-configured test agents for examples and quick testing

export {
  // Test agents (with auth)
  testAgent,
  testAgentA2A,
  testAgentClient,
  createTestAgent,
  TEST_AGENT_TOKEN,
  TEST_AGENT_MCP_CONFIG,
  TEST_AGENT_A2A_CONFIG,
  // Test agents (without auth - for demonstrating auth requirements)
  testAgentNoAuth,
  testAgentNoAuthA2A,
  TEST_AGENT_NO_AUTH_MCP_CONFIG,
  TEST_AGENT_NO_AUTH_A2A_CONFIG,
  // Creative agents (MCP only - A2A not yet supported)
  creativeAgent,
} from './test-helpers';

// E2E Agent Testing Framework
export {
  testAgent as runAgentTests,
  formatTestResults,
  formatTestResultsJSON,
  formatTestResultsSummary,
  setAgentTesterLogger,
  getLogger,
  createTestClient,
  runStep,
  // Individual scenarios
  testHealthCheck,
  testDiscovery,
  testCreateMediaBuy,
  testFullSalesFlow,
  testReportingFlow,
  testCreativeSync,
  testCreativeInline,
  testCreativeFlow,
  testSignalsFlow,
  testErrorHandling,
  testValidation,
  testPricingEdgeCases,
  testTemporalValidation,
  testBehaviorAnalysis,
  testResponseConsistency,
  // v3 scenarios
  testGovernancePropertyLists,
  testGovernanceContentStandards,
  testPropertyListFilters,
  testSISessionLifecycle,
  testSIAvailability,
  testSIHandoff,
  testCapabilityDiscovery,
  testSyncAudiences,
  resolveAccountForAudiences,
  testSchemaCompliance,
  // State machine compliance
  testMediaBuyLifecycle,
  testTerminalStateEnforcement,
  testPackageLifecycle,
  // Deterministic state machine testing
  testCreativeStateMachine,
  testMediaBuyStateMachine,
  testAccountStateMachine,
  testSessionStateMachine,
  testDeliverySimulation,
  testBudgetSimulation,
  testControllerValidation,
  // v3 helpers
  hasGovernanceTools,
  hasSITools,
  likelySupportsV3,
  // Suite orchestrator
  testAllScenarios,
  getApplicableScenarios,
  SCENARIO_REQUIREMENTS,
  DEFAULT_SCENARIOS,
  formatSuiteResults,
  formatSuiteResultsJSON,
  // Types
  type TestScenario,
  type TestOptions,
  type OrchestratorOptions,
  type TestResult,
  type SuiteResult,
  type TestStepResult,
  type AgentProfile,
  type TaskResult,
  type Logger,
} from './agent-tester';

// Compliance assessment
export {
  comply,
  formatComplianceResults,
  formatComplianceResultsJSON,
  // Brief library
  SAMPLE_BRIEFS,
  getBriefById,
  getBriefsByVertical,
  // Platform profiles
  getPlatformProfile,
  getAllPlatformTypes,
  getPlatformTypesWithLabels,
  // Types
  type ComplyOptions,
  type ComplianceTrack,
  type TrackResult,
  type TrackStatus,
  type ComplianceResult,
  type ComplianceSummary,
  type AdvisoryObservation,
  type SampleBrief,
  type PlatformType,
  type SalesPlatformType,
  type CreativeAgentType,
  type SponsoredIntelligenceType,
  type AINativePlatformType,
  type PlatformProfile,
  type CoherenceFinding,
  type PlatformCoherenceResult,
  type InventoryModel,
  type PricingModel,
} from './compliance';

// Test stubs for compliance testing
export { GovernanceAgentStub } from './stubs';
export type { StubCallRecord } from './stubs';
