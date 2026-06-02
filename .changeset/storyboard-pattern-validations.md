---
'@adcp/sdk': minor
---

fix(storyboard): add regex-backed field pattern validations

Storyboard validations now support `field_pattern` and `envelope_field_pattern` checks for string fields, with consistent handling for missing fields, non-string values, invalid regex sources, conformance replay, and schema drift detection.
