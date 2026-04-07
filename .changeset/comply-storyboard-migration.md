---
"@adcp/client": minor
---

Migrate comply() to storyboard-driven testing. The compliance engine now runs storyboard YAMLs instead of hand-written scenario functions. Adds YAML format extensions (expect_error, requires_tool, context_outputs/context_inputs, error_code validation) and 10 new compliance storyboards covering governance, SI, brand rights, state machines, error compliance, schema validation, behavioral analysis, audiences, and deterministic testing. Deprecates SCENARIO_REQUIREMENTS, DEFAULT_SCENARIOS, and testAllScenarios() in favor of storyboard execution.
