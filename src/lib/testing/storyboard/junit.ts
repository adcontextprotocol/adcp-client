import type { StoryboardResult } from './types';

function xmlEscape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Emit JUnit XML for a list of `StoryboardResult`. Each storyboard becomes a
 * `<testsuite>`; each step becomes a `<testcase>` with failures attached as
 * `<failure>` children. Matches the schema Jenkins, CircleCI, and GitLab CI
 * all consume without a plugin.
 *
 * Hints (`step.hints`) are included in the `<failure>` body immediately after
 * `step.error` so CI failure annotations carry the context-rejection diagnosis.
 * When `step.error` is absent, the first hint message is used as the `message=`
 * attribute so systems that only read that attribute still surface the hint.
 *
 * @internal — CLI tooling; not part of the public `@adcp/client` API surface.
 * Import directly from `dist/lib/testing/storyboard/junit.js` if needed.
 */
export function formatStoryboardResultsAsJUnit(results: StoryboardResult[]): string {
  let totalTests = 0;
  let totalFailures = 0;
  let totalSkipped = 0;
  let totalDuration = 0;
  const suites: string[] = [];

  for (const sb of results) {
    const suiteCases: string[] = [];
    for (const phase of sb.phases) {
      for (const step of phase.steps) {
        totalTests += 1;
        const name = `${phase.phase_title} › ${step.title}`;
        const time = ((step.duration_ms || 0) / 1000).toFixed(3);
        if (step.skipped) {
          totalSkipped += 1;
          suiteCases.push(
            `    <testcase classname="${xmlEscape(sb.storyboard_id)}" name="${xmlEscape(name)}" time="${time}">\n` +
              `      <skipped message="${xmlEscape(step.skip_reason || 'skipped')}"/>\n` +
              `    </testcase>`
          );
          continue;
        }
        if (!step.passed) {
          totalFailures += 1;
          const failureDetails = [
            step.error,
            ...(step.hints ?? []).map(h => `Hint: ${h.message}`),
            ...step.validations.filter(v => !v.passed).map(v => `${v.description}: ${v.error || 'failed'}`),
          ]
            .filter(Boolean)
            .join('\n');
          suiteCases.push(
            `    <testcase classname="${xmlEscape(sb.storyboard_id)}" name="${xmlEscape(name)}" time="${time}">\n` +
              `      <failure message="${xmlEscape(step.error || step.hints?.[0]?.message || 'validation failed')}" type="StoryboardFailure">${xmlEscape(failureDetails)}</failure>\n` +
              `    </testcase>`
          );
          continue;
        }
        suiteCases.push(
          `    <testcase classname="${xmlEscape(sb.storyboard_id)}" name="${xmlEscape(name)}" time="${time}"/>`
        );
      }
    }
    totalDuration += sb.total_duration_ms || 0;
    const suiteTests = sb.phases.reduce((n, p) => n + p.steps.length, 0);
    suites.push(
      `  <testsuite name="${xmlEscape(sb.storyboard_title)}" tests="${suiteTests}" failures="${sb.failed_count}" skipped="${sb.skipped_count}" time="${((sb.total_duration_ms || 0) / 1000).toFixed(3)}" timestamp="${sb.tested_at || new Date().toISOString()}">\n` +
        suiteCases.join('\n') +
        `\n  </testsuite>`
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="adcp-storyboards" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" time="${(totalDuration / 1000).toFixed(3)}">\n` +
    suites.join('\n') +
    `\n</testsuites>\n`
  );
}
