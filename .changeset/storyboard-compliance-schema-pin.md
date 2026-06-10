---
'@adcp/sdk': patch
---

Fail fast when `adcp storyboard run --compliance-version` selects a compliance bundle whose matching schema bundle is unavailable.

The storyboard runner now refuses to proceed with installed default schemas in that case and points operators at `--schema-root` / `ADCP_SCHEMA_ROOT` or an SDK install that includes the requested schema bundle.
