---
"@adcp/client": patch
---

Add behavioral compliance validations to brand rights, property governance, and content standards storyboards

- Brand rights: verify resolved identity data (brand_id match, names present), reject invalid brand IDs, validate creative approval decisions, test expired campaign and nonexistent grant enforcement
- Property governance: assert compliant/non-compliant delivery verdicts, add enforcement phase with authorized and unauthorized publisher tests, fix context propagation for property_list_id
- Content standards: assert calibration verdict, add must-rule violation test, add policy version change test with re-calibration, strengthen delivery validation with summary and results checks
