---
"@adcp/sdk": patch
---

Implicit demand-grant authority now extends to the brand's house (adcp L2 §Grants in trust records, adcp#8169). `authorizeDemandGrant` returns `source: 'implicit'` when the account operator and the signer's operator share a registrable domain with the brand's domain or with the house `resolveBrandHouse` returns, so a house operating its own child brand no longer needs a grant to itself. A house that the brand names but that does not list the brand back resolves to `undefined` and still needs a grant. An uncoded throw from `resolveBrandHouse` is now a `TrustRecordUnavailableError` (`SERVICE_UNAVAILABLE`) instead of an uncoded error, so an outage is never `grant_absent`; an `IdentityAuthorizationError` or `AdcpError` it throws keeps its code.
