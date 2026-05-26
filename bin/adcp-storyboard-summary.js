/**
 * Markdown summary writers + soft-fail helpers for the storyboard CLI runners
 * (issue adcp-client#1527).
 *
 * Extracted from bin/adcp.js so the formatting / file-write / soft-fail surfaces
 * are unit-testable without spawning the CLI. The runner commands import these
 * to render `--summary-file` outputs and to print the always-on
 * "STORYBOARD FAILURES" block when `--soft-fail` swallows a failing exit code.
 *
 * Two markdown shapes exist because the runner has two underlying result
 * shapes: `comply()` returns a `ComplianceResult` (with `summary.steps_passed`,
 * `summary.steps_failed`, `failures[]`) while `runStoryboard()` returns one or
 * more `StoryboardResult`s (with `phases[].steps[]` and per-step `passed` /
 * `validations[]`). Each shape gets its own renderer; the column layout and
 * cell-escape rules are shared via `escapeMarkdownCell`.
 */

const { writeFileSync } = require('node:fs');

function escapeMarkdownCell(s) {
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

/**
 * Renders a `comply()` `ComplianceResult` as a Markdown summary suitable for
 * `--summary-file` or `$GITHUB_STEP_SUMMARY`. Always emits a heading, an
 * "Overall" line, and (when present) a per-failure table. A non-passing run
 * with no `failures[]` array prints a placeholder so reviewers know failure
 * details are unavailable rather than the run actually being clean.
 */
function buildComplianceSummaryMarkdown(result, agentUrl) {
  const lines = [];
  const s = result.summary || {};
  lines.push(`# Storyboard run: ${agentUrl}`);
  lines.push('');
  lines.push(
    `**Overall:** ${result.overall_status} — ` +
      `${s.steps_passed ?? 0} passed / ${s.steps_failed ?? 0} failed / ${s.steps_skipped ?? 0} skipped / ` +
      `${s.steps_not_selected ?? 0} not selected`
  );
  const notSelectedReasons = formatReasonCounts(s.not_selected_by_reason);
  if (notSelectedReasons) lines.push(`**Not selected:** ${notSelectedReasons}`);
  const skippedReasons = formatReasonCounts(s.skipped_by_reason);
  if (skippedReasons) lines.push(`**Skipped:** ${skippedReasons}`);
  const specialisms = result.agent_profile?.specialisms;
  if (specialisms?.length) {
    lines.push(`**Specialisms:** ${specialisms.join(', ')}`);
  }
  lines.push('');
  const failures = result.failures;
  if (failures?.length) {
    lines.push('## Failures');
    lines.push('');
    lines.push('| Storyboard | Step | Reason |');
    lines.push('|---|---|---|');
    for (const f of failures) {
      const reason = f.error || f.validation?.description || '';
      lines.push(
        `| ${escapeMarkdownCell(f.storyboard_id)} | ${escapeMarkdownCell(f.step_id)} | ${escapeMarkdownCell(reason)} |`
      );
    }
    lines.push('');
  } else if (result.overall_status !== 'passing') {
    lines.push('_No per-step failure details available._');
    lines.push('');
  }
  return lines.join('\n');
}

function formatReasonCounts(counts) {
  if (!counts) return undefined;
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return undefined;
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
}

/**
 * Renders one or more `StoryboardResult`s (the shape `runStoryboard()` and
 * `runFullAssessment()` produce) as a Markdown summary. Walks every
 * `phase.steps[]` for failed steps and emits one row per failure. Failed
 * steps with a `validations[]` array surface the concatenated validation
 * descriptions; otherwise the renderer falls back to `step.error` and
 * finally the literal "failed" so the column is never empty.
 */
function buildStoryboardSummaryMarkdown(results, agentUrl, overallPassed) {
  const lines = [];
  lines.push(`# Storyboard run: ${agentUrl || 'local agent'}`);
  lines.push('');
  const totalPassed = results.reduce((n, r) => n + (r.passed_count ?? 0), 0);
  const totalFailed = results.reduce((n, r) => n + (r.failed_count ?? 0), 0);
  const totalSkipped = results.reduce((n, r) => n + (r.skipped_count ?? 0), 0);
  lines.push(
    `**Overall:** ${overallPassed ? 'passed' : 'failed'} — ` +
      `${totalPassed} passed / ${totalFailed} failed / ${totalSkipped} skipped`
  );
  lines.push('');
  const failures = [];
  for (const r of results) {
    for (const phase of r.phases || []) {
      for (const step of phase.steps || []) {
        if (!step.skipped && !step.passed) {
          const reason =
            step.validations
              ?.filter(v => !v.passed)
              .map(v => v.error || v.description)
              .join('; ') ||
            step.error ||
            'failed';
          failures.push({ storyboard: r.storyboard_id || '', step: step.id || step.title || '', reason });
        }
      }
    }
  }
  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    lines.push('| Storyboard | Step | Reason |');
    lines.push('|---|---|---|');
    for (const f of failures) {
      lines.push(
        `| ${escapeMarkdownCell(f.storyboard)} | ${escapeMarkdownCell(f.step)} | ${escapeMarkdownCell(f.reason)} |`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Writes `content` to `summaryFile`. Failures are downgraded to a stderr
 * warning rather than exiting the process — the markdown summary is a
 * convenience output, never a contract surface, so a permission denied on
 * a CI volume must not mask the underlying run's exit code.
 */
function writeSummaryFile(summaryFile, content) {
  try {
    writeFileSync(summaryFile, content, 'utf-8');
  } catch (err) {
    console.error(`WARNING: Could not write summary file ${summaryFile}: ${err.message}`);
  }
}

/**
 * Print the "STORYBOARD FAILURES" block on stderr after a soft-fail-suppressed
 * run. Suppressed under `--json` so machine-readable stdout consumers
 * (e.g. JUnit + JSON pipelines) don't get unexpected stderr lines mixed in
 * with their result envelope. A zero-length list is a no-op.
 */
function printSoftFailBlock(failedScenarios, jsonOutput) {
  if (!jsonOutput && failedScenarios.length > 0) {
    console.error(`\nSTORYBOARD FAILURES (${failedScenarios.length}): ${failedScenarios.join(', ')}`);
    console.error('  --soft-fail set: exiting 0');
  }
}

module.exports = {
  escapeMarkdownCell,
  buildComplianceSummaryMarkdown,
  buildStoryboardSummaryMarkdown,
  writeSummaryFile,
  printSoftFailBlock,
};
