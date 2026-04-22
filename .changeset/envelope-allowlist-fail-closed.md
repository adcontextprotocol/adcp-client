---
'@adcp/client': minor
---

Envelope hygiene: colocate the two error-envelope allowlists into a
single source of truth, and flip `wrapEnvelope` to a fail-closed default
for unregistered error codes.

Security-review follow-ups from #788 (M3 + M4):

- **#800 (M4)**: `ERROR_ENVELOPE_FIELD_ALLOWLIST` (sibling-keys allowlist
  used by `wrapEnvelope`) and the former `CONFLICT_ALLOWED_ENVELOPE_KEYS`
  (inside-adcp_error allowlist used by the
  `idempotency.conflict_no_payload_leak` invariant) now live side-by-side
  in the new `src/lib/server/envelope-allowlist.ts` module. The latter
  is renamed to `CONFLICT_ADCP_ERROR_ALLOWLIST` to make the "keys inside
  the adcp_error block" scope obvious. Both are exported from
  `@adcp/client/server` so callers with custom error envelopes can
  inspect / extend the sets.
- **#799 (M3)**: `wrapEnvelope` now fails closed on unregistered error
  codes. A code with no explicit entry in `ERROR_ENVELOPE_FIELD_ALLOWLIST`
  uses `DEFAULT_ERROR_ENVELOPE_FIELDS` — `context` only — instead of
  inheriting success-envelope semantics. Sellers that want `replayed`
  or `operation_id` on a bespoke error code must register it explicitly.
  The fail-closed posture matches the framework's own internal behavior:
  `create-adcp-server.ts` error paths only ever echo `context` via
  `finalize()`; `injectReplayed` is never called on error responses.

**Who is affected**: consumers calling `wrapEnvelope` with an
`adcp_error.code` other than `IDEMPOTENCY_CONFLICT` (the only code
registered today) AND relying on `replayed` or `operation_id` to
round-trip. On upgrade, those fields silently drop — only `context`
echoes. `IDEMPOTENCY_CONFLICT` is unchanged.

**Upgrade path**: for bespoke error codes that genuinely need
`replayed` or `operation_id` on the envelope, build the envelope
directly instead of calling `wrapEnvelope`, or open an issue so the
code can be added to `ERROR_ENVELOPE_FIELD_ALLOWLIST`. The allowlist
is intentionally frozen at the module level — extending it requires a
spec-and-SDK conversation, not a local override.

Breaking change (minor — `wrapEnvelope` was just shipped in 5.11.0):
narrow external surface, days-old on npm.

Closes #799, closes #800.
