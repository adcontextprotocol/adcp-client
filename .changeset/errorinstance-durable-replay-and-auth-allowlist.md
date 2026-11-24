---
'@adcp/sdk': patch
---

**`AuthenticationRequiredError` keeps only its declared, sanitized fields.** This applies to every subclass, whether the error is thrown or carried on `result.errorInstance`. Seller-supplied text outside the declared interfaces no longer reaches thrown errors, `details`, or serialized results.

- **`agentUrl`.** Userinfo, query and fragment are stripped from `agentUrl`, `details.agentUrl` and the default message. On `NeedsAuthorizationError` they are also stripped from its message, `requirements.agentUrl` and `details.requirements.agentUrl`. A URL with none of them is unchanged.
- **`challenge` and `details.challenge`.** Only the `AuthChallengeInfo` fields remain: `scheme`, plus `realm`, `scope`, `error` and `error_description` when they are strings. This drops:
  - `params`, the map of every auth-param, including unrecognized ones;
  - `resource_metadata`;
  - any other undeclared field.
- **`oauthMetadata` and `details.oauthMetadata`.** Only the `OAuthMetadataInfo` string fields remain: `authorization_endpoint`, `token_endpoint`, `registration_endpoint` and `issuer`. This drops the rest of the seller's RFC 8414 document, including `code_challenge_methods_supported`, `response_types_supported`, `grant_types_supported`, `token_endpoint_auth_methods_supported` and `scopes_supported`.

The declared TypeScript types are unchanged, so access to declared fields still type-checks. `challenge`, `oauthMetadata` and `NeedsAuthorizationError.requirements` are now copies of the objects passed in, not the same objects. Changing a passed object afterwards no longer changes the error. `requirements` keeps every other field, including its bounded `challenge`. Code that read the dropped fields can get the full parsed values from `probeAuthChallenge()`, `discoverOAuthMetadata()` or `discoverAuthorizationRequirements()`. This is a field allowlist, not a content scrub: the declared strings, such as `realm`, `error_description` and the OAuth endpoints, are still seller-supplied and untrusted.

**Durable deferred-settlement checkpoints no longer store `errorInstance`.** It used to be persisted as a plain-object copy, so a replayed result carried a value that was not an `Error`, with no `message` or `idempotencyKey`. Replay now rebuilds the typed error from the stored `adcpError` and the request's idempotency key. For example, `IDEMPOTENCY_CONFLICT` replays as an `IdempotencyConflictError`. A copy stored by an older checkpoint is dropped on replay. Errors without a seller error code, such as authentication errors, are not restored on replay.
