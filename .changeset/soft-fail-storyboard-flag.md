---
"@adcp/sdk": minor
---

`adcp storyboard run --soft-fail` — exits 0 even when storyboards fail (suppresses exit 3 only; exit 1 and 2 are preserved). Writes a greppable `STORYBOARD FAILURES (N): ...` line to stderr. Replaces the `|| true` / `continue-on-error: true` pattern — failures stay visible without blocking CI. Applies to all run modes: capability-driven, `--file`, `--local-agent`, multi-instance (`--url`), and agents-map (`--agents-map`).
