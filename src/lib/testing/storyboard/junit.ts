/**
 * JUnit XML formatter for `StoryboardResult[]`.
 *
 * Matches the schema Jenkins, CircleCI, and GitLab CI all consume without
 * a plugin — one `<testsuite>` per storyboard, one `<testcase>` per step,
 * failures/skips attached as children.
 *
 * Hints (`step.hints`) land inside the `<failure>` body AND, when
 * `step.error` is absent, in the `<failure message="…">` attribute — so
 * CI systems that only read the attribute still surface the diagnosis
 * (see adcp-client#870 / #883 for when steps fail without a task-level
 * error).
 *
 * @internal — CLI tooling; not part of the published `@adcp/client` API
 * surface. Exported from `./index` so the CLI (`bin/adcp.js`) and unit
 * tests can import it without re-reading it out of the CLI's require tree.
 */
import type { StoryboardResult, StoryboardStepResult, StoryboardStepHint } from './types';

function xmlEscape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hintLines(hints: readonly StoryboardStepHint[] | undefined): string[] {
  if (!hints || hints.length === 0) return [];
  return hints.map(h => `Hint (${h.kind}): ${h.message}`);
}

/**
 * First-hint message, used as a `<failure message=...>` fallback when
 * `step.error` is empty. Returns `undefined` when there are no hints.
 */
function firstHintMessage(step: StoryboardStepResult): string | undefined {
  return step.hints?.[0]?.message;
}

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
            ...step.validations.filter(v => !v.passed).map(v => `${v.description}: ${v.error || 'failed'}`),
            // Runner hints (adcp-client#870) are diagnostic, not fatal, but
            // they're the piece that collapses triage from "SDK bug vs
            // seller bug" to one line — worth propagating into the CI
            // report body.
            ...hintLines(step.hints),
          ]
            .filter(Boolean)
            .join('\n');
          // Attribute-only consumers (e.g. dashboards that surface only the
          // `message=` on failure) see the first hint when there's no
          // task-level `step.error` — common on validation-only failures
          // under the #883 widened hint gate.
          const message = step.error || firstHintMessage(step) || 'validation failed';
          suiteCases.push(
            `    <testcase classname="${xmlEscape(sb.storyboard_id)}" name="${xmlEscape(name)}" time="${time}">\n` +
              `      <failure message="${xmlEscape(message)}" type="StoryboardFailure">${xmlEscape(failureDetails)}</failure>\n` +
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
