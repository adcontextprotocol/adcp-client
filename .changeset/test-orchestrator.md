---
"@adcp/client": minor
---

Add test suite orchestrator to `@adcp/client/testing`

New exports:
- `testAllScenarios(agentUrl, options)` — discovers agent capabilities and runs all applicable scenarios, returning a `SuiteResult`
- `getApplicableScenarios(tools, filter?)` — returns which scenarios are applicable for a given tool list
- `SCENARIO_REQUIREMENTS` — maps each scenario to its required tools
- `DEFAULT_SCENARIOS` — the canonical set of scenarios the orchestrator runs
- `formatSuiteResults(suite)` — markdown formatter for suite results
- `formatSuiteResultsJSON(suite)` — JSON formatter for suite results
- `SuiteResult` type — aggregated result across all scenarios
- `OrchestratorOptions` type — `TestOptions` extended with optional `scenarios` filter
