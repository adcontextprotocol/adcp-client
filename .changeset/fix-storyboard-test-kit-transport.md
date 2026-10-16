---
'@adcp/sdk': patch
---

Run successful test-kit-authenticated storyboard steps through the configured official MCP or A2A client. Preserve HTTP development transport settings and routing headers while isolating step credentials from the suite's authentication.

The suite's request-signing identity is excluded from isolated steps, and a suite header is withheld when its name looks like a credential — now including separator-less spellings such as `XApiKey` and `X-AuthToken` — or when its value carries a credential the run holds, including the Base64 form of a Basic pair and the payload of a scheme-prefixed header. Curated routing header names (`X-AdCP-Tenant`, `x-routing-key`, `x-idempotency-key`) are exempt from the name test so they keep routing; if such a header's _value_ collides with a run credential the step fails closed with a header-name-only error rather than silently rerouting or forwarding the credential. A secret under an unrecognised name with an unlearnable value still cannot be detected — use non-credential routing header names such as `X-AdCP-Tenant`.

Non-Basic steps declaring `auth.from_test_kit` as a named-principal key path are now refused instead of silently resolving to the primary test-kit key.
