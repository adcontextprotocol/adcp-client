---
"@adcp/sdk": patch
---

`adcp diagnose-auth` no longer leaks or trusts token material (#3299).

- **Signature redacted:** the report's decoded tokens now redact the raw signature segment unless `includeTokens` / `--include-tokens` is set. For compact-JSON issuers, the decoded header, claims and signature reassembled into a working token.
- **Output escaped:** the CLI report escapes terminal control characters in every value that comes from the agent or its authorization server: URLs, errors, `WWW-Authenticate`, `iss`, `aud`, notes and hypothesis text.
- **No crash on bad `exp`:** an `exp` that isn't a finite NumericDate in the `Date` range is printed as `(invalid: …)` instead of crashing the command.
