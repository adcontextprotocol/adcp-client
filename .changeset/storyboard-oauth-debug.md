---
'@adcp/client': minor
---

Improve OAuth ergonomics for `adcp storyboard run`.

- **Fix classification**: capability-discovery failures whose error message says `"requires OAuth authorization"` (the wording `NeedsAuthorizationError` emits) now classify as `auth_required` with the `Save credentials: adcp --save-auth <alias> <url> --oauth` remediation hint, instead of falling through to `overall_status: 'unreachable'` with no actionable advice. The keyword list in `detectAuthRejection` now matches `"authorization"` and `"oauth"` in addition to `401/unauthorized/authentication/jws/jwt/signature verification`.
- **Surface the hint earlier**: the OAuth remediation observation now fires whenever the error text looks OAuth-shaped, not only when `discoverOAuthMetadata` successfully walks the well-known chain — an agent that 401s before its OAuth metadata is resolvable still gets a useful hint.
- **Inline OAuth flow**: `adcp storyboard run <alias> --oauth` now opens the browser to complete PKCE when the saved alias has no valid tokens, then proceeds with the run. Matches the existing `adcp <alias> get_adcp_capabilities --oauth` behavior so the two-step dance (`--save-auth --oauth` then `storyboard run`) is no longer required. Raw URLs still need `--save-auth` first; MCP only.

Docs: `docs/CLI.md` and `docs/guides/VALIDATE-YOUR-AGENT.md` document both flows and add a troubleshooting row for the `Agent requires OAuth` failure.
