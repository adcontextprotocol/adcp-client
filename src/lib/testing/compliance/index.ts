/**
 * AdCP Compliance Assessment
 *
 * comply → "Your agent works"  (deterministic, per-track)
 */

export { comply, computeOverallStatus, formatComplianceResults, formatComplianceResultsJSON } from './comply';
export type { ComplyOptions } from './comply';

export { SAMPLE_BRIEFS, getBriefById, getBriefsByVertical } from './briefs';

export { getPlatformProfile, getAllPlatformTypes, getPlatformTypesWithLabels } from './profiles';
export type { PlatformProfile } from './profiles';

export {
  PLATFORM_STORYBOARDS,
  getStoryboardIdsForPlatform,
  extractScenariosFromStoryboard,
  filterToKnownScenarios,
} from './platform-storyboards';

export type {
  ComplianceTrack,
  TrackResult,
  TrackStatus,
  OverallStatus,
  ComplianceFailure,
  ComplianceResult,
  ComplianceSummary,
  AdvisoryObservation,
  ObservationCategory,
  ObservationSeverity,
  SampleBrief,
  PlatformType,
  SalesPlatformType,
  CreativeAgentType,
  SponsoredIntelligenceType,
  AINativePlatformType,
  CoherenceFinding,
  PlatformCoherenceResult,
  InventoryModel,
  PricingModel,
} from './types';
