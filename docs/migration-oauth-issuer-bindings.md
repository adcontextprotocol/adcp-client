# OAuth issuer bindings

The corrective release after SDK 14.3.0 upgrades the official MCP client and
server to 2.2.0 and requires the legacy `@modelcontextprotocol/sdk` peer at
`^1.31.0`. These versions address
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
The Node.js requirement remains `^20.19.0 || >=22.12.0`.

OAuth refresh tokens and client secrets belong to an authorization server.
`AgentOAuthTokens` and `AgentOAuthClient` now preserve an optional `issuer`
field through the SDK's conversions, providers, and file storage. Newly saved
credentials receive their binding from the authorization flow. Web flows
validate the discovered server's metadata issuer before registration and
token exchange; diagnostic refreshes validate it before sending credentials.

## Existing saved credentials

`MCPOAuthProvider` refuses to reuse a saved refresh token or client secret
without a valid issuer, with `oauth_issuer_required`. The web flow and
diagnostic runner also refuse mismatched bindings. Access-token-only and
public-client configurations do not require a new field.

For legacy saved credentials, clear `oauth_tokens` and any confidential
`oauth_client` registration, then sign in again. Alternatively, an operator
may add the authorization-server issuer established independently from
trusted registration records. **Do not infer it from the current MCP server's
discovery metadata**, an access token's unverified claims, or its resource URL.
If the issuer is unknown, sign in again.

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
