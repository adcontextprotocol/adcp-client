# OAuth authorization-server binding

Major migration: background defaults and partial storage.

Refresh tokens/confidential clients need independently trusted `issuer` in
`AgentOAuthTokens` / `AgentOAuthClient`. Missing/mismatched bindings refuse before
secret refresh, DCR or replacement (`oauth_issuer_required` / `oauth_issuer_mismatch`).
Access-only tokens/public clients permit missing/null issuer; refresh requires it
even with valid access. Comparison tolerates one trailing slash, never different
tenant paths. Metadata follows the official asymmetric issuer-echo rule.

Recover: `adcp <alias> --clear-oauth`, then `adcp <alias> --oauth`.
Clear tokens/client/verifier/discovery, keeping URL/other auth. Each issuer may come
from trusted registration records, never PRM, unverified JWT, token-endpoint hostname
or successful requests. Upgrades cannot restore historical trust. Trust the resource
before fresh credentialless sign-in uses AS metadata; missing/mismatched returned
metadata issuer refuses.

Direct `MCPOAuthProvider` defaults to background; interactive opt-in:
`allowInteractiveAuthorization: true` (CLI factories do). Background PKCE/DCR and
token/client/all invalidation refuse (`owner_reauthorization_required`); direct
redirects retain `interactive_required`. Discovery/verifier invalidation is private
in background. Callers must authorize explicit `clearAuth`.

Adapters must retain token/client issuer and interactive PKCE/discovery. The SDK
revalidates restored discovery. File/custom adapters must BOTH preserve omitted
`oauth_tokens`, `oauth_client`, `oauth_code_verifier`, `oauth_discovery_state` AND
clear own `undefined` fields. Other fields retain backend semantics: omitted
`oauth_resource` clears in file storage. Background token/client/configured
client-credentials saves omit pending fields, preserving browser state created
during HTTP. Interactive completion clears its state; background never borrows owner PKCE.

Web stores must retain `PendingWebFlow.authorizationServerIssuer` and
`clientInformation.issuer`; restart unbound flows. Check frozen AS/current client
after metadata, before POST and before save; use the same client-bearing view at
start/callback. Explicit fresh owner flows may present a credentialless view,
stage DCR privately and reconstruct for callback. Applications provide ownership
and atomic generation replacement. No distributed refresh coordination,
grant/client CAS or spent-grant cancellation: quiesce background callers for recovery.

Pending flows written by an older store that omitted `authorizationServerIssuer`
fail at callback with `oauth_issuer_required` and must restart sign-in. The SDK parser
can read these legacy rows, but cannot recreate their historical issuer trust.
Use the shared serializer and run `assertPendingWebFlowStoreRoundTrip` in CI to
catch dropped fields on upgrade; see [Web OAuth storage](WEB-OAUTH.md#storage-and-errors).

Custom providers must preserve issuer in getters/saves. Upstream
`ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider`,
`CrossAppAccessProvider` need independent `expectedIssuer`. Direct exchange/refresh
helpers require caller binding checks (SDK web/diagnosis do them). Configured client
credentials retain the exact operator token endpoint, without PRM replacement or
credential-bearing redirects.
