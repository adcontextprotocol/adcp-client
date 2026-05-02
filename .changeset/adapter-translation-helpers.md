---
"@adcp/sdk": minor
---

Add `createTranslationMap` and `createUpstreamHttpClient` to `@adcp/sdk/server`. `createTranslationMap` provides a bidirectional, type-safe key mapping (AdCP wire values ↔ upstream platform values) with `toUpstream`, `toAdcp`, `hasAdcp`, and `hasUpstream` methods. `createUpstreamHttpClient` wraps `fetch` with auth injection (`static_bearer`, `dynamic_bearer`, `api_key`, `none`), query-string serialization, 404→null translation, and typed `get/post/put/delete` methods, replacing the per-adapter `httpJson` boilerplate. `dynamic_bearer.getToken` accepts an optional `AuthContext` forwarded from a per-call `authContext` option, so the same client supports single-key tenant fan-out, per-operator credential lookup, and pass-through of the caller's principal without per-operator client construction.
