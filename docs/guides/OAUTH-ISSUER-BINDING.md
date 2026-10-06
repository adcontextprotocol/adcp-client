# OAuth authorization-server binding

OAuth refresh tokens and client registrations belong to an authorization server,
not to whichever server an MCP resource currently advertises. This SDK preserves
the `issuer` supplied by the patched official MCP authorization lifecycle on both
`AgentOAuthTokens` and `AgentOAuthClient`. Storage adapters must retain each field
when saving and reconstructing credentials.

The SDK uses MCP client/server/core 2.2.0 and legacy SDK 1.31.0 or later to address
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h). Updating
dependencies alone does not make unstamped credentials safe. Existing refresh tokens or
secret-bearing registrations without a trusted `issuer`, or with a different issuer, refuse
authorization-server use before refresh, registration or automatic replacement.
Credential comparison preserves the official MCP tolerance for one trailing
slash; metadata keeps the official asymmetric issuer-echo rule. Neither equates
different paths or tenants on the same origin. Access-token-only and public
client configurations retain the existing missing-issuer behavior where no
refresh token or confidential client secret is being spent. Discovery never
supplies a missing historical binding for such secrets.

For a preconfigured client, supply an issuer obtained independently from the
owner's trusted authorization-server configuration. Do not derive it from
current protected-resource metadata, an unverified JWT, a token-endpoint hostname
or a successful request. Otherwise, the owner must explicitly clear the old
credentials and complete a new sign-in for a resource they trust. A credentialless
interactive sign-in still uses the resource's advertised server; the user must
trust that resource before completing sign-in.

For a saved CLI alias, explicitly run `adcp <alias> --clear-oauth`, followed by
`adcp --save-auth <alias> --oauth`. Clearing removes only authorization-code
tokens, registration, verifier and pending discovery, preserving the URL and other auth settings.

Direct `new MCPOAuthProvider(...)` construction now defaults to background
behavior. To deliberately permit interactive registration and automatic
invalidation, set `allowInteractiveAuthorization: true`. `forCLI` and
`createCLIOAuthProvider` opt in explicitly. `createNonInteractiveOAuthProvider`
refuses registration and automatic token/client/all invalidation; it preserves
the owner grant and requires owner reauthorization instead. Explicit `clearAuth`
remains a separate owner-directed operation. Discovery-only invalidation clears
the discovery cache without deleting the owner's tokens or registration.

Interactive provider storage must round-trip `oauth_code_verifier` and
`oauth_discovery_state`, so a reconstructed provider can complete its callback.
Restored discovery is revalidated before use. Background refresh keeps new
discovery per-instance and does not consume or persist an owner's pending
browser state. It refuses PKCE reads, writes and redirects before sign-in work;
discovery/verifier invalidation clears only its private cache. A successful
background refresh and official public-client issuer back-stamp omit the
pending verifier and discovery fields from storage saves, preserving browser
state created while the request was in flight. Configured client-credentials
refreshes use the same omission rule. Interactive completed exchanges still clear their pending state.
Custom storage adapters must preserve omitted fields in such partial saves.
This does not coordinate grant rotation or provide atomic owner/client CAS.
Use the web-flow helpers below for an explicit application pending-flow store.
The file storage adapter preserves omitted token, client, verifier and discovery fields;
set an own property to `undefined` to explicitly clear it. `clearAuth` and
`clearOAuthTokens` mark these clears for persistence.

Web-flow stores must round-trip `PendingWebFlow.authorizationServerIssuer` as
well as `clientInformation.issuer`. New flows freeze the validated issuer at
start; older pending rows without that binding must be restarted. Completion
checks the frozen issuer and current client after metadata discovery, before
the secret-bearing POST, and before saving returned tokens. An explicitly fresh
owner flow can use the public storage adapter to present a credentialless view,
stage the new registration privately, and reconstruct it for callback; the
application must separately enforce its authorized owner and atomic generation
replacement. This SDK does not supply distributed rotation locks or credential
CAS, and cannot undo a grant already spent during a later concurrent edit.
Use the same client-bearing storage view at start and callback; starting without
storage and later completing with unrelated storage is refused. Authorization
servers must publish metadata with an issuer matching the selected server;
missing metadata is refused, including a fresh interactive flow. Comparison is
deliberately stricter than URL normalization: configure the same issuer spelling
on both records rather than relying on host case or default-port normalization.

The existing `oauth_issuer_required` and `oauth_issuer_mismatch` codes remain
available for controlled owner recovery, and background registration or
destructive invalidation returns `owner_reauthorization_required`.

`diagnose-auth` also refuses a direct refresh with missing or mismatched issuer
bindings. Its other non-mutating diagnostics remain available. Client-credentials
exchanges retain their separate operator-configured exact `token_endpoint` and
never discover a replacement endpoint or follow credential-bearing redirects.
