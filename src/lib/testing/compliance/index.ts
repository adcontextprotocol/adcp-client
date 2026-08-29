/**
 * AdCP Compliance Assessment
 *
 * comply → "Your agent works"  (deterministic, per-track)
 */

export {
  comply,
  collectObservations,
  buildComplianceBundleResults,
  computeOverallStatus,
  formatComplianceResults,
  formatComplianceResultsJSON,
  rotateStoryboardsForOffset,
} from './comply';
export type { ComplyOptions, ComplianceBundleAssessmentOptions } from './comply';

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
  TestedTrackEntry,
  TrackStatus,
  OverallStatus,
  ComplianceFailure,
  ComplianceBundleResult,
  ComplianceBundleStatus,
  ComplianceResult,
  ComplianceSummary,
  AdvisoryObservation,
  ObservationCategory,
  ObservationSeverity,
  ObservationSource,
  SampleBrief,
} from './types';
