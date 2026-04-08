---
"@adcp/client": minor
---

Add --storyboards flag to comply CLI and storyboards_executed field to ComplianceResult

- `adcp comply --storyboards media_buy_seller,error_compliance` runs only the specified storyboards (highest resolution priority)
- Storyboard IDs are validated against bundled storyboards with a clear error on typos
- `ComplianceResult.storyboards_executed` (optional) lists which storyboard IDs were resolved and executed
- Human-readable comply report now shows which storyboards ran in the header
- Scenario names in track results changed from bare `phase_id` to `storyboard_id/phase_id` for clarity
- `adcp storyboard run` now displays the storyboard title and ID in human-readable output
