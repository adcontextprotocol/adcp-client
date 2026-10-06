# OAuth issuer bindings

The corrective release after SDK 14.3.0 upgrades the official MCP client and
server to 2.2.0 and requires the legacy `@modelcontextprotocol/sdk` peer at
`^1.31.0`. These versions address
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
Installations pinned to legacy SDK 1.24–1.30 must upgrade that peer dependency.
The legacy OAuth transport rejects vulnerable versions even if package-manager
peer checks were bypassed. The Node.js requirement remains `^20.19.0 || >=22.12.0`.

OAuth refresh tokens and client secrets belong to an authorization server.
`AgentOAuthTokens` and `AgentOAuthClient` now preserve an optional `issuer`
field through the SDK's conversions, providers, and file storage. Newly saved
credentials receive their binding from the authorization flow. The provider
persists discovery alongside the pending PKCE verifier and clears that temporary
state after exchange; a callback uses the original authorization server even if
resource discovery changes while the browser is away. Custom `OAuthConfigStorage`
implementations must preserve `oauth_discovery_state` alongside `oauth_code_verifier`. Web flows
validate the discovered server's metadata issuer before registration and
token exchange; diagnostic refreshes validate it before sending credentials.
The provider refuses a changed authorization server before replacing a trusted
confidential registration or reusing a refresh token. Clear credentials explicitly
if an independently verified server migration requires a fresh registration.

File storage preserves omitted tokens, client, verifier and discovery state for
partial callers. Set an own property explicitly to `undefined` to clear it;
owner clearing and PKCE/discovery cleanup do so. Continue loading the complete
agent before creating a provider. See [the follow-up guide](guides/OAUTH-ISSUER-BINDING.md)
for the explicit interactive opt-in and stronger callback owner checks. Background
providers refuse PKCE work and never borrow or clear pending browser state.
Their token saves omit the verifier and discovery fields so partial storage
preserves the current pending flow, including one started during refresh;
interactive completed exchanges still explicitly clear their own state.

## Existing saved credentials

`MCPOAuthProvider` refuses to reuse a saved refresh token or client secret
without a valid issuer, with `oauth_issuer_required`. The web flow and
diagnostic runner also refuse mismatched bindings. Access-token-only and
public-client configurations do not require a new field. A saved unbound refresh
token blocks every call through the provider, even while its access token is
still valid; clear the saved credentials before reconnecting.

For a saved CLI alias, run `adcp <alias> --clear-oauth`, then
`adcp <alias> --oauth` to sign in again.

For legacy saved credentials, clear `oauth_tokens` and any confidential
`oauth_client` registration, then sign in again. Alternatively, an operator
may add the authorization-server issuer established independently from
trusted registration records. **Do not infer it from the current MCP server's
discovery metadata**, an access token's unverified claims, or its resource URL.
If the issuer is unknown, sign in again. Raw `issuer: null` is treated as absent for access-token-only and public-client
configurations; secrets still require a valid string issuer.

```ts
agent.oauth_tokens = {
  ...agent.oauth_tokens!,
  issuer: 'https://auth.example.com', // independently verified token issuer
};
agent.oauth_client = {
  ...agent.oauth_client!,
  issuer: 'https://auth.example.com', // where this client was registered
};
```

An issuer is an authorization-server URL, including its tenant path when one
exists. A single trailing slash difference is tolerated for credential
comparison; distinct tenant paths remain distinct. Stored pending web flows
containing an unbound confidential client must be restarted.

## Custom providers

Preserve the complete `issuer` field passed to `saveTokens()` and
`saveClientInformation()`, and return it from the corresponding getters. Add
an independently verified issuer to pre-registered client information. The
upstream bundled `ClientCredentialsProvider`, `PrivateKeyJwtProvider`,
`StaticPrivateKeyJwtProvider`, and `CrossAppAccessProvider` also need
`expectedIssuer` configured. These are adopter-owned provider settings; a
dependency upgrade cannot reconstruct the ownership of older credentials.

Calls made directly to the upstream `exchangeAuthorization()` and
`refreshAuthorization()` helpers need their own credential-issuer checks.
The SDK's web-flow and diagnosis helpers perform those checks. The SDK's
client-credentials flow uses an explicitly configured token endpoint rather
than selecting one from MCP server discovery.

If affected credentials were sent to an untrusted authorization server,
follow the upstream advisory's credential-rotation guidance.
