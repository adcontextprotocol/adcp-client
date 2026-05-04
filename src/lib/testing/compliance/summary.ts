/**
 * Narrow, schema-stable summary artifact for compliance runs.
 *
 * `formatComplianceResultsJSON` serializes the full ComplianceResult — that
 * shape evolves with the protocol. Downstream tooling (badges, Slack bots,
 * dashboards) wants a thin contract: pass/fail counts and a flat list of
 * failures with stable IDs. That's what this module provides.
 *
 * Three renderers:
 *   - `buildComplianceSummary`        → ComplianceSummaryArtifact (the JSON contract)
 *   - `formatComplianceSummaryText`   → stderr block with greppable `STORYBOARD-FAIL` prefix
 *   - `formatComplianceSummaryMarkdown` → table for $GITHUB_STEP_SUMMARY
 */

import type { ComplianceFailure, ComplianceResult, ComplianceTrack, OverallStatus } from './types';

const SUMMARY_SCHEMA_VERSION = 1;

/**
 * Stable, schema-versioned summary. Adopters depending on this shape should
 * gate on `schema_version` and treat unknown fields as ignorable.
 */
export interface ComplianceSummaryArtifact {
  schema_version: number;
  agent_url: string;
  sdk_version: string;
  adcp_version: string;
  overall_status: OverallStatus;
  passed: number;
  failed: number;
  skipped: number;
  total_duration_ms: number;
  tested_at: string;
  storyboards_executed: string[];
  failures: ComplianceSummaryFailure[];
}

/**
 * Discriminator for `reason`. Lets a Slack bot color-code or filter without
 * regexing the reason string. Pinned at v1; new kinds are additive.
 */
export type ComplianceSummaryFailureKind =
  | 'error' /** The step itself raised — network, transport, runtime exception. */
  | 'validation' /** A storyboard validation check failed (schema, field_present, etc.). */
  | 'expected_mismatch' /** No structured validation; reason derived from the step's `expected:` text. */
  | 'unspecified'; /** Failure with no extractable reason — should be rare. */

export interface ComplianceSummaryFailure {
  track: ComplianceTrack;
  storyboard_id: string;
  step_id: string;
  reason: string;
  reason_kind: ComplianceSummaryFailureKind;
}

export interface BuildSummaryOptions {
  sdkVersion: string;
  adcpVersion: string;
}

export function buildComplianceSummary(result: ComplianceResult, opts: BuildSummaryOptions): ComplianceSummaryArtifact {
  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    agent_url: result.agent_url,
    sdk_version: opts.sdkVersion,
    adcp_version: opts.adcpVersion,
    overall_status: result.overall_status,
    passed: result.summary.steps_passed ?? 0,
    failed: result.summary.steps_failed ?? 0,
    skipped: result.summary.steps_skipped ?? 0,
    total_duration_ms: result.total_duration_ms,
    tested_at: result.tested_at,
    storyboards_executed: result.storyboards_executed ?? [],
    failures: (result.failures ?? []).map(toSummaryFailure),
  };
}

function toSummaryFailure(f: ComplianceFailure): ComplianceSummaryFailure {
  const { reason, reason_kind } = deriveReason(f);
  return {
    track: f.track,
    storyboard_id: f.storyboard_id,
    step_id: f.step_id,
    reason,
    reason_kind,
  };
}

const REASON_MAX_CHARS = 500;

function deriveReason(f: ComplianceFailure): { reason: string; reason_kind: ComplianceSummaryFailureKind } {
  if (f.error) return { reason: truncate(f.error, REASON_MAX_CHARS), reason_kind: 'error' };
  if (f.validation?.description) {
    const desc = f.validation.description;
    const ptr = f.validation.json_pointer ? ` at ${f.validation.json_pointer}` : '';
    return { reason: truncate(`${desc}${ptr}`, REASON_MAX_CHARS), reason_kind: 'validation' };
  }
  if (f.expected) {
    return { reason: truncate(f.expected.split('\n')[0]!, REASON_MAX_CHARS), reason_kind: 'expected_mismatch' };
  }
  return { reason: 'failed', reason_kind: 'unspecified' };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Hard-failure statuses — runs that should never look green to CI. `partial`
 * is intentionally not in this set: it means some tracks ran silent (wired
 * but unexercised), which is a reportable observation, not a CI block.
 */
const HARD_FAIL_STATUSES = new Set<OverallStatus>(['failing', 'unreachable', 'auth_required']);

function isHardFail(s: ComplianceSummaryArtifact): boolean {
  return HARD_FAIL_STATUSES.has(s.overall_status) || s.failures.length > 0;
}

/**
 * stderr-style summary block. Always starts with `STORYBOARD-FAIL` (kebab,
 * no spaces) on any hard-failing run, so CI scripts can `grep -q STORYBOARD-FAIL`
 * regardless of how the workflow handles the exit code. `partial` runs render
 * `STORYBOARD-PARTIAL` — distinct from both green and red so dashboards can
 * surface "wired but unexercised" without false-alarming CI.
 */
export function formatComplianceSummaryText(s: ComplianceSummaryArtifact): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`──── Storyboard Summary ────`);
  lines.push(`Agent:     ${s.agent_url}`);
  lines.push(`SDK:       @adcp/sdk ${s.sdk_version} (AdCP ${s.adcp_version})`);
  lines.push(`Status:    ${s.overall_status}`);
  lines.push(`Steps:     ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
  lines.push(`Duration:  ${(s.total_duration_ms / 1000).toFixed(1)}s`);
  lines.push('');

  if (!isHardFail(s)) {
    if (s.overall_status === 'passing') {
      lines.push(`STORYBOARD-OK ${s.passed}/${s.passed + s.failed + s.skipped} steps passed`);
    } else {
      // `partial` and `silent` — some tracks were wired but not exercised.
      // Distinct marker so dashboards can surface this without lighting CI red.
      lines.push(`STORYBOARD-PARTIAL ${s.passed} steps passed, run ended ${s.overall_status}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  if (s.failures.length === 0) {
    lines.push(`STORYBOARD-FAIL run ended ${s.overall_status} with no graded steps`);
  } else {
    lines.push(`STORYBOARD-FAIL ${s.failures.length} step(s):`);
    for (const f of s.failures) {
      lines.push(`  - ${f.storyboard_id}/${f.step_id} [${f.track}]: ${f.reason}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Markdown for `$GITHUB_STEP_SUMMARY`. Renders in the PR UI summary panel,
 * so reviewers see failures without opening the run log.
 */
export function formatComplianceSummaryMarkdown(s: ComplianceSummaryArtifact): string {
  const lines: string[] = [];
  const heading = !isHardFail(s)
    ? s.overall_status === 'passing'
      ? '✅ Storyboard run passed'
      : `⚠️ Storyboard run ended ${s.overall_status} (wired but partly unexercised)`
    : s.failures.length === 0
      ? `❌ Storyboard run: ended ${s.overall_status} with no graded steps`
      : `❌ Storyboard run: ${s.failures.length} failure(s)`;
  lines.push(`## ${heading}`);
  lines.push('');
  lines.push(`- **Agent:** \`${s.agent_url}\``);
  lines.push(`- **SDK:** \`@adcp/sdk ${s.sdk_version}\` (AdCP \`${s.adcp_version}\`)`);
  lines.push(`- **Status:** \`${s.overall_status}\``);
  lines.push(`- **Steps:** ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
  lines.push(`- **Duration:** ${(s.total_duration_ms / 1000).toFixed(1)}s`);
  lines.push('');

  if (s.failures.length > 0) {
    lines.push('| Track | Storyboard | Step | Reason |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of s.failures) {
      lines.push(`| \`${f.track}\` | \`${f.storyboard_id}\` | \`${f.step_id}\` | ${escapeTableCell(f.reason)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function escapeTableCell(s: string): string {
  // Escape backslashes first so a `\|` in the input doesn't combine with
  // the pipe-escape below and produce `\\|` (literal backslash + raw pipe,
  // which breaks the table). Order matters: `\` → `\\` then `|` → `\|`.
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Synthesize a summary artifact when the runner itself crashed before
 * `comply()` produced a result (network down, capabilities parse error,
 * auth handshake exception). Schema-stable on the same `schema_version: 1`
 * contract so a Slack bot built against the artifact sees a valid payload
 * — rather than nothing — precisely when the agent is broken hardest.
 */
export interface BuildCrashSummaryOptions extends BuildSummaryOptions {
  agentUrl: string;
  error: Error | string;
  startedAt: string;
  durationMs: number;
}

export function buildCrashSummary(opts: BuildCrashSummaryOptions): ComplianceSummaryArtifact {
  const message = opts.error instanceof Error ? opts.error.message : String(opts.error);
  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    agent_url: opts.agentUrl,
    sdk_version: opts.sdkVersion,
    adcp_version: opts.adcpVersion,
    overall_status: 'unreachable',
    passed: 0,
    failed: 1,
    skipped: 0,
    total_duration_ms: opts.durationMs,
    tested_at: opts.startedAt,
    storyboards_executed: [],
    failures: [
      {
        track: 'core',
        storyboard_id: 'pre-flight',
        step_id: 'comply',
        reason: message.length > 500 ? `${message.slice(0, 499)}…` : message,
        reason_kind: 'error',
      },
    ],
  };
}
