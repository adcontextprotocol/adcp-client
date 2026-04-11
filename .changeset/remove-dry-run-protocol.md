---
"@adcp/client": minor
---

Remove dry_run as a protocol concept in favor of sandbox

- Removed X-Dry-Run HTTP header from test client
- Removed dry_run from TestOptions, TestResult, SuiteResult, StoryboardResult, ComplianceResult
- Made sandbox: true the default for all test runs (comply, testAgent, testAllScenarios)
- Changed CLI --dry-run to preview mode (shows steps without executing, opt-in)
- Replaced --no-dry-run flag with --dry-run (default is now to execute)
