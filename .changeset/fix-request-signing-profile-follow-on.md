---
'@adcp/sdk': patch
---

Keep the body-bound request-signing corpus selected for AdCP 3.2 and later, and register the remaining unsigned and malformed-header negative builders. Reject received signed URLs containing raw non-ASCII host bytes at checklist step 1 in every signing profile, before key resolution or replay state changes. Preserve the documented HTTP transport exclusion for the raw U-label fixture.

Refresh the development and test-server lockfile's Express dependency proxy-addr to 2.0.8 to fix critical IP spoofing through IPv4-mapped IPv6 trust subnets (GHSA-jqcg-44mw-7w3h). Add spoofing regressions with valid IPv4 and IPv6 trust controls. Adopters running Express must update proxy-addr in their own lockfile; the published SDK does not include this lockfile.
