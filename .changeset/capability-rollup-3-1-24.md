---
'@adcp/sdk': patch
---

`buildComplianceBundleResults` now grades a declined root capability gate as `not_applicable` on AdCP 3.1.24 and later 3.1 bundles, as it already did from 3.2. adcontextprotocol/adcp#7625 (adcp#7584) backported the "Applicability order" rule to the 3.1 line in 3.1.24 (and gated the governance scenarios on `media_buy.governance_aware`), so an optional scenario an agent never claimed no longer keeps its bundle `partial` there. For a 3.1 media-buy seller this clears the declined, non-`compliance_testing` scenarios in the `media-buy` protocol bundle and the `wholesale_feed_*` universal bundles (adcontextprotocol/adcp#8534).

Every other condition is unchanged: `compliance_testing.*` gates, unmet requirements and any execution evidence still cap the bundle. Bundles 3.1.0 to 3.1.23 and every 3.0 bundle lack the rule and keep capping.
