---
'@adcp/client': patch
---

Add test-runner guardrails so a single hung test can't consume hours of CPU (fixes #680):

- `npm test` / `npm run test:lib` / `prepublishOnly` now pass `--test-timeout=60000`. A stuck test fails after 60s with a stack trace instead of spinning indefinitely at high CPU (previously `--test-force-exit` only fired after the runner finished, which a spinning test never reaches).
- CI jobs in `.github/workflows/ci.yml` now declare `timeout-minutes` so a runaway job is capped at its wall-clock budget instead of eating up to the GitHub Actions default six-hour ceiling.
- `CONTRIBUTING.md` and `AGENTS.md` document the `kill -QUIT <pid>` tip for dumping the V8 stack when a test appears hung.
