---
'@adcp/sdk': patch
---

fix(discovery): validateAdAgents polish from #1718 review (closes #1720)

Follow-ups from the multi-reviewer pass on PR #1718 (`validateAdAgents`):

**Real fix surfaced by new test:**

- HTTP 200 with an empty (zero-byte) body decodes to `null` and was crashing
  the `data.authoritative_location` check. Added a `coerceAdAgentsObject`
  guard at all three entry points (direct, `authoritative_location` follow,
  manager-domain hop) that rejects non-object JSON values and returns a
  clean `parse_error`-shaped failure instead of throwing.

**Code-quality cleanups:**

- `describeOutcome` accepts `FetchFailure` only (was a wider union with a
  dead `'ok'` arm).
- BOM strip in `parseManagerDomain` uses `charCodeAt(0) === 0xfeff` +
  `slice` instead of a literal-U+FEFF regex.

**New JSDoc safety warnings** on `AdAgentsValidationResult`:

- `manager_domain` — chained callers re-invoking `validateAdAgents` are
  responsible for their own loop guard. The one-hop guarantee is
  per-call, not per-chain.
- `adagents` — counterparty-controlled JSON. Treat as untrusted input
  before splicing into LLM prompts, log indices, or any text-as-instruction
  context.

**New regression tests:**

- HTTP 200 + empty body → terminal `invalid JSON` failure on direct path
- Manager-domain pointer file with its OWN `authoritative_location` — NOT
  recursed (RFC's "one hop only" rule)
- Manager domain returns 5xx → terminal failure on managerdomain path
- Mixed-case publisher domain lowercased through to result
