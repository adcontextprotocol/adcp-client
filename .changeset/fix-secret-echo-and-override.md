---
'@adcp/client': patch
---

fix(testing): `context.no_secret_echo` walks structured `TestOptions.auth`, and `registerAssertion` accepts `{ override: true }`

- The default `context.no_secret_echo` assertion in `@adcp/client/testing`
  previously treated `options.auth` as a string and added the whole
  discriminated-union object to its secret set. `String.includes(obj)`
  against `[object Object]` matched nothing, so the assertion was
  effectively a no-op for every consumer passing structured auth (bearer,
  basic, oauth, oauth_client_credentials). It now extracts the leaf
  secrets across every variant:
  - bearer: `token`
  - basic: `username`, `password`, and the base64 `user:pass` blob an
    `Authorization: Basic` header would carry
  - oauth: `tokens.access_token`, `tokens.refresh_token`,
    `client.client_secret` (confidential clients)
  - oauth_client_credentials: `credentials.client_id` and
    `credentials.client_secret` — resolving `$ENV:VAR` references to their
    runtime values so echoes of the real secret (not the reference string)
    are caught — plus `tokens.access_token` / `tokens.refresh_token`

  A minimum-length guard (8 chars) skips substring matching on fixture
  values that would otherwise collide with benign JSON.

- `registerAssertion(spec, { override: true })` now replaces an existing
  registration instead of throwing. Lets consumers swap in a stricter
  version of an SDK default (e.g. their own `context.no_secret_echo`)
  without calling `clearAssertionRegistry()` and re-registering every other
  default. Default behaviour (`{ override: false }` / no options) is
  unchanged and still throws on duplicate ids.
