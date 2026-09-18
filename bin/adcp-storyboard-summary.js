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
    .replace(/\\/g, '\\\\')
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
  if (result.completeness === 'timed_out') {
    const timeoutObservation = result.observations?.find(
      observation => observation.source?.code === 'timeout-budget-exceeded'
    );
    lines.push(
      `**Incomplete:** ${timeoutObservation?.message || 'The compliance timeout budget was reached before every selected storyboard ran.'}`
    );
  }
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

/**
 * Scale the implicit compliance budget with the selected storyboard set.
 * Keep the historical 120-second floor for small/unknown selections and
 * reserve ten seconds per selected storyboard for larger release lines.
 */
function defaultComplianceTimeoutSeconds(selectedStoryboardCount) {
  if (!Number.isSafeInteger(selectedStoryboardCount) || selectedStoryboardCount <= 0) return 120;
  return Math.max(120, selectedStoryboardCount * 10);
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

// ────────────────────────────────────────────────────────────────────────────
// Skipped-step rendering + request-signing flag parsing
//
// Same rationale as the markdown writers above: keep the wording and the
// argument semantics unit-testable without spawning the CLI. A run that
// prints `0 passed, N skipped` and nothing else reads as a clean pass, which
// is how an ungradable conformance surface hides (adcp-client#2954).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The runner's own coverage rule, loaded from the built library rather than
 * restated here. An earlier revision of this file hand-wrote the predicate
 * and drifted from the runner within one change — per-scenario instead of
 * per-storyboard — which failed a run whose report was entirely green.
 *
 * Required lazily: `bin/` modules are loaded by tests that exercise pure
 * helpers, and those should not need `dist` present to do it.
 */
function signingCoverageOf(steps) {
  const { signingCoverage } = require('../dist/lib/testing/storyboard/runner.js');
  return signingCoverage(steps);
}

/** Project a compliance `TestStepResult` onto the runner's coverage view. */
function toCoverageStep(step) {
  return {
    task: step?.task,
    skipped: step?.skipped,
    skip_reason: step?.skip_reason,
    // `mapStepToTestStep` carries the probe's `HttpProbeResult` here.
    response: step?.observation_data,
  };
}

/**
 * Escape C0/C1 control characters. Skip details can quote agent-supplied
 * text, and a hostile agent should not be able to rewrite the terminal.
 */
function escapeTerminalControlChars(text) {
  // eslint-disable-next-line no-control-regex -- the point is to escape control characters
  const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
  return String(text).replace(CONTROL_CHARS, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Canonical `RunnerSkipReason` values meaning "the runner could not grade
 * this", as opposed to "this does not apply to your agent". Keep in sync with
 * `DETAILED_SKIP_TO_CANONICAL` in `src/lib/testing/storyboard/types.ts`.
 */
const COVERAGE_GAP_SKIP_REASONS = new Set(['fixture_unavailable']);

/**
 * Detailed reasons that are runner-owned coverage gaps even though they
 * canonicalize to `not_applicable` — the canonical layer follows the
 * output contract's registered shapes, so the gap shows up here.
 */
const COVERAGE_GAP_DETAILED_REASONS = new Set(['signing_transport_unavailable']);

/** Whether a skipped step should read as missing coverage rather than as a skip. */
function isCoverageGapRow(step) {
  return (
    Boolean(step?.skipped) &&
    (COVERAGE_GAP_SKIP_REASONS.has(step.skip?.reason) || COVERAGE_GAP_DETAILED_REASONS.has(step.skip_reason))
  );
}

/**
 * The operator-facing remedy a probe recorded, if any. `skip.detail` carries
 * the output contract's machine-readable sub-reason token for registered
 * reasons, so the human text lives on the probe result.
 */
function probeRemedy(step) {
  const response = step?.response ?? step?.observation_data;
  if (!response || typeof response !== 'object') return undefined;
  return typeof response.error === 'string' && response.error.length > 0 ? response.error : undefined;
}

/**
 * Lines describing why a step was skipped. Empty when the step ran, or when
 * the caller already printed a reason-specific message for it.
 *
 * @param {object} step storyboard step result
 * @param {{ handledReasons?: Set<string> }} [options]
 * @returns {string[]} indented output lines
 */
function formatStepSkipLines(step, options = {}) {
  if (!step || !step.skipped) return [];
  const detailed = step.skip_reason;
  if (options.handledReasons?.has(detailed)) return [];
  const canonical = step.skip?.reason;
  if (!canonical && !detailed) return [];

  const reasonText = detailed && detailed !== canonical ? `${canonical ?? 'skipped'} / ${detailed}` : canonical;
  const lines = [
    `   ${isCoverageGapRow(step) ? 'COVERAGE UNAVAILABLE' : 'Skipped'} (${escapeTerminalControlChars(reasonText)})`,
  ];
  // Prefer the probe's remedy; fall back to `skip.detail` unless it is just
  // the machine-readable token already printed above.
  const detail = probeRemedy(step) ?? (step.skip?.detail !== detailed ? step.skip?.detail : undefined);
  if (detail) lines.push(`   ${escapeTerminalControlChars(detail)}`);
  return lines;
}

/**
 * Whether a single-step run should exit nonzero: the step is a
 * request-signing probe and nothing about the agent's verifier was graded
 * because this runner had no way to dispatch it.
 *
 * Scoped to that case on purpose. A step the operator excluded is their own
 * scoping decision, and a legacy `fixture_unavailable` gap keeps its
 * long-standing exit 0 — the runner-output contract says that reason must not
 * move a verdict.
 */
function isCoverageUnavailableStep(step) {
  return signingCoverageOf([toCoverageStep({ ...step, observation_data: step?.response })]) === 'transport_unverified';
}

/**
 * Storyboards in a `ComplianceResult` whose request-signing coverage went
 * unverified, with why (adcp-client#2954).
 *
 * Grouped by storyboard, because the compliance projection emits one scenario
 * per phase: evaluating `negative_vectors` on its own reports a gap for a run
 * whose `positive_vectors` graded fine, which is a false CI failure on an
 * all-green report.
 *
 * @param {object} complianceResult result from `comply()`
 * @returns {Array<{ storyboard_id: string, coverage: import('../dist/lib/testing/storyboard/runner.js').SigningCoverage }>}
 */
function unverifiedSigningCoverage(complianceResult) {
  const stepsByStoryboard = new Map();
  for (const track of complianceResult?.tracks ?? []) {
    for (const scenario of track?.scenarios ?? []) {
      const storyboardId = String(scenario?.scenario ?? '').split('/')[0];
      if (!storyboardId) continue;
      const steps = (scenario?.steps ?? []).map(toCoverageStep);
      stepsByStoryboard.set(storyboardId, [...(stepsByStoryboard.get(storyboardId) ?? []), ...steps]);
    }
  }
  const unverified = [];
  for (const [storyboardId, steps] of stepsByStoryboard) {
    const coverage = signingCoverageOf(steps);
    // Every state except "graded" and "no probes at all" means the verifier
    // was not exercised; the state itself tells the operator which remedy
    // applies, and they are not interchangeable.
    if (coverage !== 'graded' && coverage !== 'not_probed') {
      unverified.push({ storyboard_id: storyboardId, coverage });
    }
  }
  return unverified;
}

/**
 * Verdict line(s) for a single-step run (`adcp storyboard step`).
 *
 * A skipped step carries `passed: true` — skip is not failure — so printing
 * the bare verdict renders a coverage gap as a green "Passed". Route skips
 * through the skip renderer instead, and say "Not verified" when the runner
 * could not grade the step at all.
 *
 * @param {object} step storyboard step result
 * @param {{ durationMs?: number }} [options]
 * @returns {string[]} output lines
 */
function formatStepVerdictLines(step, options = {}) {
  const suffix = typeof options.durationMs === 'number' ? ` (${options.durationMs}ms)` : '';
  if (step?.skipped) {
    const label = isCoverageGapRow(step) ? '⏭️  Not verified' : '⏭️  Skipped';
    return [`${label}${suffix}`, ...formatStepSkipLines(step)];
  }
  return [`${step?.passed ? '✅ Passed' : '❌ Failed'}${suffix}`];
}

const SIGNING_TRANSPORTS = ['raw', 'mcp'];

// Tokens only ever passed as a (rejected) value for a boolean flag — no
// storyboard id or agent URL looks like these, so treating them as a misuse
// of `--signing-skip-rate-abuse` can't swallow a real positional argument.
const BOOLEAN_LITERALS = new Set(['true', 'false', 'yes', 'no', '0', '1']);

/**
 * Parse the `storyboard run` request-signing knobs.
 *
 * Pure: returns `{ ok: true, options }` (options `null` when no flag was
 * passed) or `{ ok: false, error }`. The CLI turns an error into a usage
 * message and exit 2; keeping the decision here means the argument semantics
 * are testable without spawning a process per case.
 *
 * `--signing-transport` is distinct from `--transport`/`--protocol`: the
 * latter selects how the storyboard talks to the agent, this one selects how
 * the RFC 9421 conformance vectors are framed on the wire.
 *
 * @param {(flag: string) => string | null} readFlag reads `--flag value` / `--flag=value`
 * @param {(flag: string) => boolean} hasFlag whether the bare flag is present
 * @param {{ readInlineValue?: (flag: string) => string | null, knownVectorIds?: string[] | null }} [deps]
 *   `readInlineValue` reads the `--flag=value` form only — needed to tell a
 *   boolean flag's misuse (`--signing-skip-rate-abuse=false`) from the bare
 *   flag, which `readFlag` cannot, since it also returns the next positional.
 *   `knownVectorIds` enables vector-id validation; `null`/omitted skips it
 *   (the compliance cache may not be readable, and a nicety must not block a
 *   run).
 */
function parseRequestSigningFlags(readFlag, hasFlag, deps = {}) {
  const readInlineValue = deps.readInlineValue ?? (() => null);
  const knownVectorIds = deps.knownVectorIds ?? null;
  const transport = readFlag('--signing-transport');
  if (transport !== null && !SIGNING_TRANSPORTS.includes(transport)) {
    return {
      ok: false,
      error:
        `--signing-transport must be one of ${SIGNING_TRANSPORTS.join('|')}, got: ${transport}\n` +
        '       Omit the flag to infer the vector transport from the agent protocol.',
    };
  }
  if (hasFlag('--signing-transport') && transport === null) {
    return { ok: false, error: `--signing-transport requires a value (${SIGNING_TRANSPORTS.join('|')}).` };
  }

  const skipVectorsRaw = readFlag('--signing-skip-vectors');
  if (hasFlag('--signing-skip-vectors') && skipVectorsRaw === null) {
    return { ok: false, error: '--signing-skip-vectors requires a value (comma-separated vector ids).' };
  }
  const skipVectors = skipVectorsRaw
    ? skipVectorsRaw
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
    : [];
  if (skipVectorsRaw !== null && skipVectors.length === 0) {
    return { ok: false, error: '--signing-skip-vectors requires at least one vector id.' };
  }
  // A mistyped id silently skips nothing: the grader matches ids exactly, so
  // the operator gets the full vector run they thought they had trimmed, and
  // on a slow one (`020` sends cap+1 requests) they find out minutes later.
  if (knownVectorIds && skipVectors.length > 0) {
    const known = new Set(knownVectorIds);
    const unknown = skipVectors.filter(id => !known.has(id));
    if (unknown.length > 0) {
      const lines = unknown.map(id => {
        const near = knownVectorIds.filter(k => k.startsWith(id) || k.includes(id)).slice(0, 3);
        return `unknown vector id "${id}"${near.length > 0 ? ` — did you mean: ${near.join(', ')}?` : ''}`;
      });
      return {
        ok: false,
        error:
          `--signing-skip-vectors: ${lines.join('; ')}\n` +
          '       Ids are the fixture file names under ' +
          'compliance/cache/<version>/test-vectors/request-signing/{positive,negative}/ (e.g. 002-wrong-tag).',
      };
    }
  }

  // `--signing-skip-rate-abuse` is a bare boolean. Without this check
  // `--signing-skip-rate-abuse=false` reads as "flag present" and skips the
  // vector the operator just asked to run — the inverse of the request, and
  // silent.
  const rateAbuseInline = readInlineValue('--signing-skip-rate-abuse');
  const rateAbuseSpaced = rateAbuseInline === null ? readFlag('--signing-skip-rate-abuse') : null;
  const rateAbuseValue =
    rateAbuseInline ??
    (rateAbuseSpaced !== null && BOOLEAN_LITERALS.has(rateAbuseSpaced.toLowerCase()) ? rateAbuseSpaced : null);
  if (rateAbuseValue !== null) {
    return {
      ok: false,
      error:
        `--signing-skip-rate-abuse takes no value (got "${rateAbuseValue}"). ` +
        'Pass the bare flag to skip the rate-abuse vector, or omit it to run the vector.',
    };
  }
  const skipRateAbuse = hasFlag('--signing-skip-rate-abuse');
  const requestSigning = {
    ...(transport && { transport }),
    ...(skipVectors.length > 0 && { skipVectors }),
    ...(skipRateAbuse && { skipRateAbuse: true }),
  };
  return { ok: true, options: Object.keys(requestSigning).length > 0 ? { request_signing: requestSigning } : null };
}

module.exports = {
  escapeMarkdownCell,
  escapeTerminalControlChars,
  formatStepSkipLines,
  formatStepVerdictLines,
  isCoverageGapRow,
  isCoverageUnavailableStep,
  unverifiedSigningCoverage,
  parseRequestSigningFlags,
  SIGNING_TRANSPORTS,
  buildComplianceSummaryMarkdown,
  buildStoryboardSummaryMarkdown,
  writeSummaryFile,
  printSoftFailBlock,
  defaultComplianceTimeoutSeconds,
};
