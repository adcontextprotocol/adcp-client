---
'@adcp/client': minor
---

Add `refs_resolve` cross-step storyboard validation (adcp#2597, adcp-client#670). A new check that asserts every ref in a source set (e.g., `products[*].format_ids[*]` from a prior `get_products`) resolves to a member of a target set (e.g., `formats[*].format_id` from the current `list_creative_formats`), using configurable `match_keys`. Supports `[*]` wildcard path segments via a new `resolvePathAll` helper, scope filtering by key (with `$agent_url` substitution for the agent under test), and three out-of-scope grading modes (`warn`, `ignore`, `fail`). Failed checks name the exact unresolved ref tuples in `actual.missing` and dedupe on the projected tuple so one bad ref across 50 products shows up once. `runValidations()` now accepts `storyboardContext` on its `ValidationContext` argument so cross-step checks can read prior-step outputs; existing call sites pass it through from the runner.

Hardening for untrusted inputs:
- `resolvePathAll` caps output at 10,000 terminal values to prevent wildcard fan-out OOM from a malicious agent response shaped for exponential expansion.
- Path segments `__proto__`, `constructor`, and `prototype` are skipped, and `hasOwnProperty` gates each object lookup so a storyboard path cannot surface prototype-chain state into compliance reports.
- Path strings over 1 KiB return an empty segment list rather than burning CPU on pathological input.
- `scope.equals` normalizes trailing slashes on both sides when the scope key ends in `url`, so a storyboard author can pass a literal URL or `$agent_url` interchangeably.
- `refsMatch` rejects a match when either side is missing a declared `match_key`, preventing two refs that both omit a key from fuzzy-matching on the others.
