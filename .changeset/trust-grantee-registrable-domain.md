---
'@adcp/sdk': minor
---

Experimental AdCP 3.3 identity (`@adcp/sdk/identity-3.3`): a trust.json grant's `grantee` must be a registrable domain under the pinned Public Suffix List snapshot, ICANN and private sections (adcontextprotocol/adcp#8169).

- **A host grantee is no longer broadened.** `authorizeDemandGrant` used to reduce a `grantee` such as `media.agency.example` to its registrable domain, `agency.example`, so the grant reached every agent that domain runs. A grant whose `grantee` is not itself a registrable domain now covers no claim, on either link of a chain and for a self-operated brand's direct grant. Its `scopes` still count for `exclusive_grants`: with `exclusive_grants: true` the claim is refused and `sellerAuthorization` is not consulted. Without it, the uncovered claim stays at the seller's discretion: such a grant no longer counts as published narrowing that blocks `sellerAuthorization`.
- **A public suffix grantee covers no claim.** A `grantee` that is a public suffix itself, such as `github.io`, has no registrable domain, while `alice.github.io` does. Such a grant used to throw `EtldComputationError` out of `authorizeDemandGrant` for every claim against that record; it is now ignored like any other non-registrable grantee.
- **Authoring refuses them.** The new `assertPublishableTrustRecord`, which `createTrustRecord` and `adcp identity trust-validate` now use, throws a `TypeError` naming the grantee when a grant's `grantee` is not a registrable domain, or when a grant's `agents[].url` is not a valid agent origin. A fetched record that carries either is still a valid record: the rule applies per grant.
- **A malformed grant `agents[].url` no longer throws.** A schema-valid but unparseable URL (such as `https://agency.example:99999/`) in one grant's `agents[]` used to throw `CanonicalizeError` out of `authorizeDemandGrant`, failing every claim against the record. That grant now lists no agent and simply does not match.
