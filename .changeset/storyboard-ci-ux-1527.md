---
"@adcp/sdk": minor
---

feat(cli): storyboard CI UX improvements — soft-fail, summary file, specialism resolution

Adds three improvements to `adcp storyboard` surfaced by silent CI failures in reference adopter repos:

- **`--soft-fail`**: exit 0 even when storyboards fail, printing a `STORYBOARD FAILURES (N): scenario1, …` block to stderr. Eliminates the `continue-on-error: true` / `|| true` silent-failure pattern — adopters get "non-blocking but visible" without regressions going unnoticed. Applies to all run modes (capability-driven, bundle, `--file`, `--local-agent`, multi-instance, agents-map). Exit 1 (runner crash) and 2 (usage error) are not suppressed.

- **`--summary-file [PATH]`**: write a Markdown run summary to a file after the run. Defaults to `storyboard-result-summary.md` when `PATH` is omitted. Auto-activates when `$GITHUB_STEP_SUMMARY` is set so the summary appears in the GitHub Actions job summary tab without an extra upload step.

- **`adcp storyboard show --specialism <slug>`**: resolve which storyboards are graded when an agent claims a specialism (e.g. `adcp storyboard show --specialism sales-guaranteed`). Shows the full scenario list including protocol baseline and universal storyboards, with capability-gating annotations.
