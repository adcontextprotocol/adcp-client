---
"@adcp/client": minor
---

Comply CLI DX improvements: failures array, expected text, storyboard filtering, SKILL.md

- `ComplianceResult.failures[]` — flat array of failed steps with storyboard_id, step_id, expected text, error, and fix_command for targeted re-running
- `adcp comply --storyboards media_buy_seller,error_compliance` — run specific storyboards (validated against bundled set)
- "How to Fix" section in human-readable comply output with expected responses and debug commands
- `adcp storyboard show` now displays narratives and expected responses (was titles-only)
- `adcp storyboard list` now includes `track` field in JSON output
- `adcp storyboard step --context @file.json` — read context from file (no shell escaping)
- Updated SKILL.md with comply/storyboard workflow, routing, and filtering options
- Top-level help clarifies comply vs storyboard vs test relationship
- `ComplianceResult.storyboards_executed` (optional) lists which storyboard IDs were executed
- Scenario names in track results changed from bare `phase_id` to `storyboard_id/phase_id`
