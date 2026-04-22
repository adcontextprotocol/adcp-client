---
'@adcp/client': minor
---

feat(server): response validation defaults to `'strict'` outside production

`createAdcpServer({ validation: { responses } })` previously defaulted to
`'warn'` when `NODE_ENV !== 'production'`. It now defaults to `'strict'`
in dev/test/CI so handler-returned schema drift fails with
`VALIDATION_ERROR` (with the offending field path in `details.issues`)
instead of logging a warning the caller can silently ignore.

Production behaviour is unchanged: the default stays `'off'` when
`NODE_ENV === 'production'`, so prod request paths pay no validation
cost. Pass `validation: { responses: 'warn' }` to restore the previous
dev-mode behaviour; `validation: { responses: 'off' }` opts out
entirely.

Why: the `compliance:skill-matrix` harness has repeatedly surfaced
`SERVICE_UNAVAILABLE` from agents whose responses fail the wire schema.
The dispatcher's response validator catches this drift with a clear
field pointer, one layer that every tool inherits automatically. Making
that the default catches it during handler development rather than in a
downstream consumer.

Migration: handler tests that use sparse fixtures (e.g.
`{ products: [{ product_id: 'p1' }] }`) will start returning
`VALIDATION_ERROR`. Either fill in the missing required fields to match
the AdCP schema, or set `validation: { responses: 'off' }` on the test
server to keep the fixture intentionally minimal. Note that Node's
test runner does **not** set `NODE_ENV`, so test suites running under
`node --test` (with `NODE_ENV=undefined`) fall into the dev/test
bucket and will start validating responses — this is intentional.

Also: the `VALIDATION_ERROR` envelope's `details.issues[].schemaPath`
is now gated behind `exposeErrorDetails` (same policy as the existing
`SERVICE_UNAVAILABLE.details.reason` field). Production responses no
longer leak `#/oneOf/<n>/properties/...` paths that fingerprint the
handler's internal `oneOf` branch selection — buyers still get
`pointer`, `message`, and `keyword`, which is sufficient to fix a
drifted payload.

Closes #727 (A).
