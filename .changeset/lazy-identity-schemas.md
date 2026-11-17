---
'@adcp/sdk': patch
---

Register the AdCP 3.3 draft identity schemas on the first identity validation instead of at import. Every SDK entry point reached that module, so importing `@adcp/sdk`, `@adcp/sdk/server` or `@adcp/sdk/testing` built an Ajv instance and checked each schema against the meta-schema (about 45 ms of CPU for the main entry point). Validation results are unchanged.
