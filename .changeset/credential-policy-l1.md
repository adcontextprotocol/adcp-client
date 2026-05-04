---
'@adcp/sdk': minor
---

**Security**: add opt-in `credentialPolicy` server config that scans incoming buyer args for credential-shaped keys at any depth and rejects with `PERMISSION_DENIED` (`details.scope: 'credentials'`) when configured `'authInfo-only'`. Closes the buyer-args credential-smuggling vector class (top-level, nested `context`, nested `ext`) observed across three rounds of review on PR scope3data/agentic-adapters#248. Default `'lax'` preserves existing behavior; opt in to enforce.

Default patterns cover the common credential vocabulary: `_token`, `_secret`, `_password`, `api_key`, `private_key`, `authorization`, `cookie`, `bearer`, `accessToken`, `refreshToken` (case-insensitive). Patterns extensible via `credentialPolicy.patterns.extend` or fully replaceable via `credentialPolicy.patterns.matcher`. Per-tool overrides via `credentialPolicy.tools` (typo-validated against the registered tool set at construction).

Rejection envelope reports paths only (never values) and bypasses `params.context` echo so the offending value does not round-trip through the response. Walker hardened against accessor-property getters: credential-named getters are flagged by name without invoking the getter, defending against throw / side-effect attacks on hand-built non-JSON inputs. `/g` and `/y` regex flags in adopter-supplied `extend` patterns are stripped to prevent `lastIndex`-based skip-alternation. See #1529.
