---
"@adcp/sdk": patch
---

fix(runner): align with adcp#3987 — non-JSON `payload_must_contain` modes grade `not_applicable` (no terminal-key fallback)

Closes the runner-side gap that adcp#3845 surfaced and adcp#3987 (merged) ratified.

**Before:** `match: present` against non-JSON `content_type` (form-urlencoded, multipart, plain text) fell back to a terminal-key substring search — extract `hashed_email` from `users[*].hashed_email`, substring-match against the raw payload string. That created false positives (a payload mentioning `hashed_email` in any context — URL fragment, comment, unrelated metadata field — would pass), exactly the loophole the anti-façade contract exists to close.

**After:** ALL `payload_must_contain` match modes (`present` / `equals` / `contains_any`) grade `not_applicable` against non-JSON content types, consistent with the `equals` / `contains_any` behavior that already shipped. Storyboards needing a non-JSON value-carried signal use `identifier_paths` — substring-searches storyboard-supplied VALUES (not path-derived strings), which is encoding-agnostic and doesn't suffer the false-positive surface.

**Side effects:**
- `terminalPathKey` helper deleted (no remaining callers).
- Existing test asserting the substring-fallback behavior updated to assert `not_applicable: true` (matches the equals-mode test already in the suite).
- `isJsonContentType` doc updated to reference RFC 6839 §3.1 explicitly — newline-delimited JSON formats (`application/json-seq`, `application/jsonl`) take the non-JSON path; the JSON detection itself was already correct (`application/json` or `*/*+json` suffix).
- `globToRegExp` doc updated to note adcp#3987 ratified the wildcard grammar (was previously documented as "candidate semantics filed against the spec at adcp#3845") and added the no-escape-mechanism clarification per the merged spec.
