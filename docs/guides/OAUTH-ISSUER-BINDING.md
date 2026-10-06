# OAuth authorization-server binding

OAuth refresh tokens and client registrations belong to an authorization server,
not to whichever server an MCP resource currently advertises. This SDK preserves
the `issuer` supplied by the patched official MCP authorization lifecycle on both
`AgentOAuthTokens` and `AgentOAuthClient`. Storage adapters must retain each field
when saving and reconstructing credentials.

The SDK uses MCP client/server/core 2.2.0 and legacy SDK 1.31.0 or later to address
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h). Updating
dependencies alone does not make unstamped credentials safe. Existing tokens or
registrations without a trusted `issuer`, or with a different issuer, refuse
authorization-server use before refresh, registration or automatic replacement.
The comparison preserves the official MCP tolerance for one trailing slash; it
does not equate different paths or tenants on the same origin.

For a preconfigured client, supply an issuer obtained independently from the
owner's trusted authorization-server configuration. Do not derive it from
current protected-resource metadata, an unverified JWT, a token-endpoint hostname
or a successful request. Otherwise, the owner must explicitly clear the old
credentials and complete a new sign-in for a resource they trust. A credentialless
interactive sign-in still uses the resource's advertised server; the user must
trust that resource before completing sign-in.

For a saved CLI alias, explicitly run `adcp <alias> --clear-oauth`, followed by
`adcp --save-auth <alias> --oauth`. Clearing removes only authorization-code
tokens, registration and verifier, preserving the URL and other auth settings.

Direct `new MCPOAuthProvider(...)` construction now defaults to background
behavior. To deliberately permit interactive registration and automatic
invalidation, set `allowInteractiveAuthorization: true`. `forCLI` and
`createCLIOAuthProvider` opt in explicitly. `createNonInteractiveOAuthProvider`
refuses registration and automatic token/client/all invalidation; it preserves
the owner grant and requires owner reauthorization instead. Explicit `clearAuth`
remains a separate owner-directed operation. Discovery-only invalidation clears
only provider-local discovery state.

With the modern MCP client, keep the same `MCPOAuthProvider` instance through
the redirect and callback legs so its validated discovery state remains
available. Use the web-flow helpers below for callbacks in another process.
The file storage adapter preserves omitted token, client and verifier fields;
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

`diagnose-auth` also refuses a direct refresh with missing or mismatched issuer
bindings. Its other non-mutating diagnostics remain available. Client-credentials
exchanges retain their separate operator-configured exact `token_endpoint` and
never discover a replacement endpoint or follow credential-bearing redirects.
