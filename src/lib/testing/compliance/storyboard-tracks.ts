/**
 * Bridges storyboard execution to the comply() track system.
 *
 * Maps StoryboardResult objects to TrackResult objects so that
 * comply() can use storyboards as its testing engine while
 * maintaining the existing ComplianceResult interface.
 */

import type { TestResult, TestStepResult, AgentProfile } from '../types';
import type { ComplianceTrack, TrackResult, TrackStatus, AdvisoryObservation } from './types';
import type { StoryboardResult, StoryboardStepResult } from '../storyboard/types';

/** Labels for each compliance track. */
export const TRACK_LABELS: Record<ComplianceTrack, string> = {
  core: 'Core Protocol',
  products: 'Product Discovery',
  media_buy: 'Media Buy Lifecycle',
  creative: 'Creative Management',
  reporting: 'Reporting & Delivery',
  governance: 'Governance',
  campaign_governance: 'Campaign Governance',
  signals: 'Signals',
  si: 'Sponsored Intelligence',
  audiences: 'Audience Management',
  error_handling: 'Error Handling',
  brand: 'Brand Rights',
};

/**
 * Convert storyboard results to a TrackResult for backwards-compatible ComplianceResult.
 */
export function mapStoryboardResultsToTrackResult(
  track: ComplianceTrack,
  storyboardResults: StoryboardResult[],
  _profile: AgentProfile
): TrackResult {
  const label = TRACK_LABELS[track] || track;

  // No storyboards ran for this track
  if (storyboardResults.length === 0) {
    return {
      track,
      status: 'skip',
      label,
      scenarios: [],
      skipped_scenarios: [],
      observations: [],
      duration_ms: 0,
    };
  }

  // Convert each storyboard result into pseudo-TestResults (one per phase)
  const scenarios: TestResult[] = [];
  const observations: AdvisoryObservation[] = [];
  let totalDuration = 0;

  for (const sbResult of storyboardResults) {
    totalDuration += sbResult.total_duration_ms;

    for (const phase of sbResult.phases) {
      const steps: TestStepResult[] = phase.steps.map(stepResult => mapStepToTestStep(stepResult));

      const testResult: TestResult = {
        agent_url: sbResult.agent_url,
        scenario: `${sbResult.storyboard_id}/${phase.phase_id}` as any,
        overall_passed: phase.passed,
        steps,
        summary: phase.passed
          ? `${phase.phase_title}: all steps passed`
          : `${phase.phase_title}: ${steps.filter(s => !s.passed).length} step(s) failed`,
        total_duration_ms: phase.duration_ms,
        tested_at: sbResult.tested_at,
        dry_run: sbResult.dry_run,
      };

      scenarios.push(testResult);
    }
  }

  // Determine track status
  const status = computeTrackStatus(storyboardResults);

  // Detect deterministic mode
  const hasDeterministic = storyboardResults.some(r =>
    r.phases.some(p => p.steps.some(s => s.task === 'comply_test_controller'))
  );

  return {
    track,
    status,
    label,
    scenarios,
    skipped_scenarios: [],
    observations,
    duration_ms: totalDuration,
    mode: hasDeterministic ? 'deterministic' : 'observational',
  };
}

/**
 * Map a StoryboardStepResult to a TestStepResult.
 */
function mapStepToTestStep(stepResult: StoryboardStepResult): TestStepResult {
  const validationDetails = stepResult.validations
    .map(v => `${v.passed ? '✓' : '✗'} ${v.description}${v.error ? ': ' + v.error : ''}`)
    .join('; ');

  return {
    step: stepResult.title,
    task: stepResult.task,
    passed: stepResult.skipped ? false : stepResult.passed,
    duration_ms: stepResult.duration_ms,
    error: stepResult.error,
    details: validationDetails || undefined,
    observation_data: stepResult.response as Record<string, unknown> | undefined,
    warnings: stepResult.skipped
      ? [
          (
            {
              missing_test_harness: 'Not testable: requires comply_test_controller harness',
              not_testable: 'Not testable: agent lacks required tool',
              dependency_failed: 'Skipped: prior stateful step failed',
            } as Record<string, string>
          )[stepResult.skip_reason ?? ''] ?? 'Step skipped',
        ]
      : undefined,
  };
}

/**
 * Compute the track status from storyboard results.
 */
function computeTrackStatus(results: StoryboardResult[]): TrackStatus {
  const totalPassed = results.reduce((sum, r) => sum + r.passed_count, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed_count, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped_count, 0);
  const totalSteps = totalPassed + totalFailed + totalSkipped;

  if (totalSteps === 0) return 'skip';
  if (totalSteps === totalSkipped) return 'skip';
  if (totalFailed === 0) return 'pass';
  if (totalPassed === 0) return 'fail';
  return 'partial';
}
