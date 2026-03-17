/**
 * AdCP Compliance & Convince Assessment
 *
 * comply   → "Your agent works"  (deterministic, per-track)
 * convince → "Your agent sells"  (AI-assessed, per-brief)
 */

export { comply, formatComplianceResults, formatComplianceResultsJSON } from './comply';
export type { ComplyOptions } from './comply';

export { convince, formatConvinceResults, formatConvinceResultsJSON } from './convince';
export type { FullConvinceOptions } from './convince';

export { SAMPLE_BRIEFS, getBriefById, getBriefsByVertical } from './briefs';

export type {
  ComplianceTrack,
  TrackResult,
  TrackStatus,
  ComplianceResult,
  ComplianceSummary,
  AdvisoryObservation,
  ObservationCategory,
  ObservationSeverity,
  SampleBrief,
  ConvinceDimension,
  ConvinceRating,
  DimensionScore,
  ScenarioAssessment,
  ConvinceResult,
  ConvincePattern,
  ConvinceOptions,
} from './types';
