---
'@adcp/sdk': patch
---

Make SDK test clients, including `createTestClient`, and authored storyboard response-schema checks grade strict JSON Schema verdicts by default so local CLI and programmatic preflight results match hosted compliance grading. Add `strictResponseSchemaValidation: false` as a packaged-schema diagnostic migration escape hatch, and preserve implementation-specific strings in `compliance_testing.scenarios`.
