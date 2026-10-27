---
'@adcp/sdk': minor
---

Align `authorizeDemandGrant` with the one delegation-chain rule (adcontextprotocol/adcp#8473, an erratum to ratified R6), and run its cross-SDK vectors.

- **Implicit authority:** `account.operator` and the signer's operator only need to each be the brand or its house. A brand-operated account with the house's own agent signing (or the reverse) is implicit; before, both had to equal the same domain.
- **Chains:** at most two grants from the house's record to the signer's operator, every grant covering the claim, with `account.operator` the brand, the house, or the first grant's grantee. Brand- and house-operated accounts can now use a two-grant chain, and the brand's own record can supply the second grant. When several candidate chains exist, an unreadable intermediary record is an outage only if no other chain authorizes.
- **Exclusivity:** `exclusive_grants: true` on the house's record makes `grants[]` the complete list whatever the scope, so an uncovered claim is `grant_absent` and `sellerAuthorization` is never called. This reverses the per-scope reading shipped in 16.5.0. Without it, an uncovered claim is at the seller's discretion, and a grant that does not cover the claim no longer narrows that discretion.

`test/lib/identity-3.3-delegation-chain-vectors.test.js` runs all 48 vectors from `static/test-vectors/delegation-chains.json` (vendored, pinned in `test/fixtures/delegation-chains/PINNED.json`).
