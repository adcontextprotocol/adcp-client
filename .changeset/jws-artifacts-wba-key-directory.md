---
'@adcp/sdk': minor
---

Experimental AdCP 3.3 identity: JWS artifacts from a Web Bot Auth identity are verified with a key from that identity's key directory (`specs/agent-identity-3-3.md` R4, as amended by adcontextprotocol/adcp#8299).

- **Selection.** `selectJwsArtifactProfile(agentUrl, trust)` (from `@adcp/sdk/identity-3.3`) derives the trust record from the signing agent's origin `O`. When it lists `O`, the artifact is verified on the WBA path, never under the 3.2 profile. An issuer whose operator has never published a record, or whose record does not list `O`, stays on the 3.2 profile. A trust-record fetch failure throws `JwsArtifactError` with `jws_key_unavailable`; it is never absence and never selects 3.2.
- **Key rules.** `verifyWebBotAuthJwsArtifact(token, origin, { directory, revocation })` requires `alg` `EdDSA` and a `kid` equal to the key's JWK thumbprint, applies no `use`, `key_ops` or `adcp_use` check, and checks revocation against `O`'s list. It works on Cloudflare workerd.
- **Governance contexts.** `verifyGovernanceAuthorization` takes an optional `webBotAuth: { trust, directory, revocation }`. With it, a listed issuer's token is verified on its key directory; every other check is unchanged, including the `buyerIdentity` cross-check that `iss` is the buyer's governance agent. Without it the verifier is 3.2 only, as before.
- **History.** `verifyHistoricalGovernanceContext` verifies a retained governance context for audit, reading a key rotated out of the directory from the governance key archive at `O` (`/.well-known/jwks-archive.json`) through the new `GovernanceKeyArchiveResolver`. A `kid` that `O`'s list revokes is invalid for every token it signed.
- Designated-task responses and rights attestations have no SDK verifier yet; a verifier for either uses `selectJwsArtifactProfile` with `agent_url` or `rights_agent.url` and `verifyWebBotAuthJwsArtifact`.
