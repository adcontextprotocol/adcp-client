---
"@adcp/sdk": patch
---

fix(testing): seed storyboard root context before applying caller overrides.

Refs #2099. The storyboard runner now uses top-level storyboard `context` defaults for full-run, multi-pass seeding, and single-step execution paths, while preserving `options.context` override behavior.
