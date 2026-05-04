/**
 * AdCP Compliance Assessment
 *
 * comply → "Your agent works"  (deterministic, per-track)
 */

export { comply, computeOverallStatus, formatComplianceResults, formatComplianceResultsJSON } from './comply';
export type { ComplyOptions } from './comply';

export {
  buildComplianceSummary,
  buildCrashSummary,
  formatComplianceSummaryText,
  formatComplianceSummaryMarkdown,
} from './summary';
export type {
  ComplianceSummaryArtifact,
  ComplianceSummaryFailure,
  ComplianceSummaryFailureKind,
  BuildSummaryOptions,
  BuildCrashSummaryOptions,
} from './summary';

export { SAMPLE_BRIEFS, getBriefById, getBriefsByVertical } from './briefs';

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
} from './types';
