---
'@adcp/sdk': patch
---

fix(invariant): no_secret_echo only fails on string-valued suspect-named fields (#1713)

The default `context.no_secret_echo` invariant flagged any response field
whose name was in `SUSPECT_PROPERTY_NAMES` (`'authorization'`, `'api_key'`,
`'apikey'`, `'bearer'`, `'x-api-key'`) regardless of the field's value.
This over-rejected spec-legitimate structured fields — notably the
`authorization` object on `validation-result.json` (a structured
authorization-validation payload, not a credential) and any seller-side
extension fields named `authorization` under
`sync_accounts_response.accounts[]` (`additionalProperties: true`).

Symptom: BidMachine's `sync_accounts` failures in
adcontextprotocol/adcp#4419 all surfaced as `context.no_secret_echo`.
Diagnosis in #4419 pointed at Zod `.strict()` codegen lag, but
verification of the published SDK tarballs (5.25.1 / 6.12.0 / current)
shows `SyncAccountsResponseSchema.accounts[]` already uses
`.passthrough()`. Zod silently accepts the `authorization` field; the
NAME dragnet in this invariant is the actual rejection.

Fix: narrow `findSecretEcho` so the suspect-name check only fires when
the field VALUE is a non-empty string. Structured object/array values
on suspect-named fields pass through to the recursive walk, which still
scans nested strings against `BEARER_TOKEN_PATTERN` and caller-supplied
secret literals. The actual leak shapes the invariant was designed to
catch (bearer tokens, API keys, caller secret echoes) remain caught.

Adds five new test cases covering:

- Suspect name with object value passes (the BidMachine case)
- Suspect name with array value passes
- Suspect name with empty string passes (no leak)
- Suspect name with non-empty string value still fails (existing dragnet)
- Bearer literal nested inside a structured suspect-named object still
  fails via the value-scan regression guard

Sequencing relative to other in-flight work:

- adcp-client#1709 (PR #1712, merged) — Zod-reject error attribution.
  Addresses a different misattribution path (when Zod DOES reject).
  This fix addresses the case where Zod ACCEPTS but the invariant
  over-rejects on field name.
- adcp-client#1707 — dynamic schema fetch + strict→passthrough +
  codegen regen. Real architectural cleanup; does NOT unblock
  BidMachine (the published SDK already uses passthrough).
- adcp-client#1711 (fgranata) — BidMachine's report. The "Zod
  `.strict()` codegen lag" diagnosis was incorrect for the published
  SDK; this fix is the actual unblocker. Closes once fgranata retests.

Coordinated stance: adcp-client#1685 (the SDK is a witness, not a
translator). Same anti-pattern: the SDK fabricated a credential-leak
signal against a structured non-credential field that the spec legally
permits.
