---
'@adcp/sdk': patch
---

Treat HTTP 408 and 429 during capabilities or brand.json signing discovery as retryable failures, including webhook signature verification. Other HTTP 4xx and SSRF policy refusals remain terminal.
