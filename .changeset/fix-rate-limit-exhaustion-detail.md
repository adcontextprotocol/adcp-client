---
'@adcp/sdk': patch
---

Emit the canonical `rate_limit_not_triggered` detail when a rate-limit trip exhausts its attempts without observing a `RATE_LIMITED` response. Preserve the passing skipped-step contract while surfacing independent assertion failures through compliance reports.
