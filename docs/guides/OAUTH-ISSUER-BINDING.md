# OAuth authorization-server binding

This major upgrade changes direct-provider defaults and custom storage contracts.

Refresh tokens and confidential client registrations require a trusted `issuer`
on `AgentOAuthTokens` and `AgentOAuthClient`. Missing or different bindings refuse
secret use before refresh, DCR or replacement (`oauth_issuer_required` /
`oauth_issuer_mismatch`). Access-only tokens and public clients retain their
missing-issuer behavior, including `null`; an unbound refresh token refuses even
while its access token is valid. Credential comparison tolerates one trailing
slash; distinct tenant paths remain distinct. Metadata retains the official
asymmetric issuer-echo rule, not URL normalization.

Owners must explicitly clear old credentials and sign in to a trusted resource:
`adcp <alias> --clear-oauth`, then `adcp <alias> --oauth`. Clearing
removes tokens, registration and pending verifier/discovery, preserving URL and
other auth settings. Alternatively supply each issuer from independently trusted
registration records. Never infer it from current PRM, unverified JWT claims,
token-endpoint hostname or a successful request. Dependency upgrades cannot
recover historical trust. Fresh credentialless sign-in uses advertised AS
metadata; trust the resource before signing in. Missing/mismatched metadata is refused.

Direct `MCPOAuthProvider` construction defaults to background mode. Set
`allowInteractiveAuthorization: true` explicitly for interactive registration
and invalidation; CLI factories opt in. Background PKCE/DCR and destructive
token/client/all invalidation return `owner_reauthorization_required`;
direct redirects retain `interactive_required`. Background discovery/verifier invalidation
clears private cache only. Explicit `clearAuth` remains an owner operation.

Adapters must preserve token/client `issuer` and interactive `oauth_code_verifier`
plus `oauth_discovery_state`; restored discovery is revalidated. For tokens,
client, verifier and discovery state, file/custom storage must preserve omitted
fields and clear own `undefined` properties. Resource overrides retain backend
semantics: file storage clears an omitted `oauth_resource`. Background client/token
saves and configured client-credentials refresh omit pending fields, retaining
browser state created during HTTP. Interactive completion explicitly clears its
state. Background discovery stays private and never borrows owner PKCE state.

Web stores must round-trip `PendingWebFlow.authorizationServerIssuer` and
`clientInformation.issuer`; restart older unbound pending flows. Callback checks
the frozen AS and current client after metadata, before POST and before save.
Use the same client-bearing storage view at start/callback. An explicit fresh
owner flow may present a credentialless view, stage DCR privately and reconstruct
it for callback. Applications enforce ownership and atomic generation replacement.
There is no distributed refresh coordination, grant/client CAS or cancellation
of an already spent grant; quiesce background callers during owner recovery.

Custom providers must retain issuer in getters/saves; upstream
`ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider`
and `CrossAppAccessProvider` need independent `expectedIssuer`. Direct upstream
exchange/refresh helpers require caller binding checks. SDK web/diagnosis helpers
perform them. Configured client credentials retain the exact operator-supplied
token endpoint, without PRM replacement or credential-bearing redirects.
