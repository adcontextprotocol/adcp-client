---
"@adcp/sdk": minor
---

Add an always-on storyboard summary surface and `adcp specialism show` for pre-flight inspection.

**Always-on summary at end of `adcp storyboard run`.** Every run now writes a compact summary block to **stderr** with three status-driven markers: `STORYBOARD-OK` (passing), `STORYBOARD-PARTIAL` (wired but partly unexercised — silent tracks), and `STORYBOARD-FAIL` (failing / unreachable / auth_required, or any individual step failed). The marker is **status-driven**, not just failure-count-driven: an unreachable agent now correctly renders `STORYBOARD-FAIL run ended unreachable` instead of the silent green pass it produced before. CI authors can `grep -q STORYBOARD-FAIL` to surface failures regardless of `--json` mode or workflow `continue-on-error: true` wiring. When `$GITHUB_STEP_SUMMARY` is set (GitHub Actions), the same content is appended as a markdown table so PR reviewers see failures in the run summary panel without opening the log.

**Status-aware exit code.** `adcp storyboard run` now exits 3 when `overall_status` is `failing`, `unreachable`, or `auth_required` — previously, an unreachable agent or auth-blocked run silently exited 0 because `tracks_failed` was zero. `partial` is preserved as exit 0 (some tracks ran silent — reportable but not a CI block). Runs that throw before `comply()` produces a result still exit 1 with a synthetic `pre-flight/comply` failure in the summary artifact (see below).

**Crash-path summary.** When `comply()` itself throws (network down, capabilities parse error, TLS-policy refusal), the catch block now emits the same stderr block, `$GITHUB_STEP_SUMMARY` markdown, and `--summary-output` JSON via a synthetic `buildCrashSummary` artifact (`overall_status: unreachable`, single failure with `storyboard_id: 'pre-flight'`, `step_id: 'comply'`, `reason_kind: 'error'`). The always-on promise now holds on the path where it matters most: a Slack bot reading `summary.json` sees a valid `schema_version: 1` payload precisely when the agent is broken hardest, instead of nothing.

**`--summary-output <path>`.** New flag on `storyboard run`. Writes a narrow, schema-stable JSON artifact for downstream tooling (badges, Slack bots, dashboards):

```json
{
  "schema_version": 1,
  "agent_url": "...",
  "sdk_version": "6.9.0",
  "adcp_version": "3.0.6",
  "overall_status": "failing",
  "passed": 12, "failed": 2, "skipped": 1,
  "failures": [
    { "track": "media_buy", "storyboard_id": "...", "step_id": "...", "reason": "...", "reason_kind": "validation" }
  ]
}
```

`failures[].reason_kind` is a stable discriminator (`error` | `validation` | `expected_mismatch` | `unspecified`) so a Slack bot can color-code without regexing the reason string. Pin downstream tooling to this contract. The full `ComplianceResult` on stdout in `--json` mode evolves with the protocol; the summary doesn't.

**`adcp specialism show <slug>` (new top-level verb).** Prints the resolved required scenarios, required tools, storyboard phases, and invariants for a specialism — answers "what is CI actually exercising against my server?" *before* runtime. `adcp specialism list` enumerates every specialism the compliance cache knows about. Both subcommands support `--json`. Specialisms get a top-level verb (parallel to `storyboard show`) rather than a flag on `storyboard show` so the positional contract stays unambiguous.

**Public API additions** (`@adcp/sdk`):

- `buildComplianceSummary(result, { sdkVersion, adcpVersion }) → ComplianceSummaryArtifact`
- `buildCrashSummary({ sdkVersion, adcpVersion, agentUrl, error, startedAt, durationMs }) → ComplianceSummaryArtifact`
- `formatComplianceSummaryText(artifact) → string`  *(stderr-style block)*
- `formatComplianceSummaryMarkdown(artifact) → string`  *(GitHub step summary table)*
- `loadSpecialismDetail(slug) → SpecialismDetail`  *(resolves `requires_scenarios` against the bundled cache)*
- `listSpecialisms() → ComplianceIndexSpecialism[]`

Pure-additive surface at the wire, library API, and CLI. No breaking changes.
