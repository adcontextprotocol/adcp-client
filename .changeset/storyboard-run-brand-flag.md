---
'@adcp/client': minor
---

Expose `--brand DOMAIN|JSON` and `--brand-manifest JSON|@file.json` on `adcp storyboard run` (single-instance, multi-instance, and full capability-driven assessment). The runner's `applyBrandInvariant` was previously a no-op for CLI-driven runs because `options.brand` was never threaded — any storyboard step that omitted `brand` on its sample_request could slip into the seller's `open:default` session instead of the tenant under test. `--brand` and `--brand-manifest` are mutually exclusive. Also threads `--allow-http` in single-instance storyboard run for parity with multi-instance and full assessment. (adcp-client#639)
