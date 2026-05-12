---
'@adcp/sdk': patch
---

fix(cli): basic-auth UX polish (closes #1723 — CLI bundle)

Final slice of #1723 follow-up to PR #1719. Picks up the CLI-side review
items that didn't fit the SDK-layer cache-key fix (landed separately).

**Refactor-safety: `injectBasicAuthHeader` helper.** The basic-auth path
relies on a subtle invariant: the encoded `Authorization` header is
injected into `mergedHeaders` AFTER `mergeHeaders()` runs, so the
reserved-key filter (case-insensitive `authorization` strip) doesn't
drop it. The invariant lived in prose only. Extract a tiny helper with
the warning baked into the docstring, and add an end-to-end invariant
test (`test/lib/cli-auth-scheme.test.js`) that hand-edits a saved
config to smuggle an `authorization` header, then asserts the merge
filter strips it on read. A future refactor that moved injection
inside or before `mergeHeaders` would fail this test before reaching
the wire test that catches the symptom.

**Env-var asymmetry warning.** `ADCP_AUTH_SCHEME=basic` is silently
no-op when no token resolves to the request — adopters wouldn't see
why their Basic gateway keeps 401ing. Surface a stderr warning at the
direct-invocation site when `ADCP_AUTH_SCHEME` is set in the env but
the resolved scheme didn't end up applied. The inverse (token-without-
scheme → silent bearer) is the safe direction and stays silent.

**`--auth-scheme=basic` single-token form.** Pre-existing
inconsistency: the long-form path treated `--auth-scheme=basic` as an
unknown arg and silently fell through to env-var lookup. Equals-form
is now first-class at both the top-level `parseAuthSchemeFlag` and the
`--save-auth` flag parser. Source label in error messages distinguishes
flag vs env-var when validation fails so operators know which to fix.

**`--list-agents` pretty-print.** Old format: `Auth: token configured
(basic (user:pass))` — nested parens, inner placeholder non-informative.
New format: `Auth: HTTP Basic (user=<username>)` for basic, `Auth:
bearer token configured` for bearer. The username is already on disk
in cleartext; surfacing it makes multi-tenant aliases immediately
distinguishable. The password stays hidden. Regression test asserts
the password value NEVER appears in `--list-agents` output.

**`--save-auth` honors `ADCP_AUTH_SCHEME`.** CI scripts that set
`ADCP_AUTH_SCHEME` globally previously had to repeat `--auth-scheme
basic` on every `adcp --save-auth` invocation. The env var now feeds
the save path as well. The CLI flag wins on conflict (consistent with
the runtime path).

**Root `--help` density.** Collapsed the 4-line `--auth-scheme` block
in `printUsage` to 3 lines and pointed at `adcp --save-auth --help`
for full detail. Keeps the niche case from competing with `--oauth`
for visual weight in the main usage screen.

**Decode-source message clarity.** `buildResolvedAuthOption`'s
second-line decode now uses the source label `resolved basic credential
(saved alias or --auth)` instead of the generic `auth credential`, so a
malformed hand-edited config surfaces with the right hint.

Tests added (`test/lib/cli-auth-scheme.test.js`):
- `--list-agents` pretty-print (HTTP Basic with user, bearer plain
  label, no nested parens, no password leak)
- `--auth-scheme=basic` single-token form parsing
- `ADCP_AUTH_SCHEME` env var feeds the save path
- Env-var ineffective warning fires (spawns a local 401 server)
- Helper invariant: `mergeHeaders` strips smuggled `authorization`
  (refactor-safety guard)

24/24 cross-suite passing (cli-auth-scheme + cli-header-flag).

Source: code-reviewer (helper extraction), DX-reviewer (list-agents,
help density, env warn), security-reviewer L3 (equals-form parsing),
from PR #1719 follow-ups.
