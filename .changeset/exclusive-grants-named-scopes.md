---
'@adcp/sdk': patch
---

Fix `authorizeDemandGrant` applying `exclusive_grants: true` to every scope. The rule is that `grants[]` is exhaustive only for the scopes it names (adcontextprotocol/adcp L2 "Grants in trust records": Absence). A claim in a scope that no grant in the record names, including any claim against an exclusive record with no grants, now stays at the seller's discretion through `sellerAuthorization`, as it does for a nonexclusive record. A scope that any grant names (including through `adcp:all` or `*`, and including grants whose grantee is not a registrable domain) is still exhaustive: an uncovered claim in it is refused with `grant_absent` and `sellerAuthorization` is not called.

Previously, a house that published only exclusive governance grants also blocked media-buying claims that the seller had authorized through its own onboarding. Matching grants, legacy `authorized_operators` handling, and fetch-failure behavior are unchanged.
