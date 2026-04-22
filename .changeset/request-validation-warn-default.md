---
'@adcp/client': minor
---

feat(server): request validation defaults to `'warn'` outside production

`createAdcpServer({ validation: { requests } })` previously defaulted to
`'off'` everywhere. It now defaults to `'warn'` when
`NODE_ENV !== 'production'`, mirroring the asymmetric default already in
place for `responses` (`'strict'` in dev/test, `'off'` in production).

Production behaviour is unchanged: the default stays `'off'` when
`NODE_ENV === 'production'`, so prod request paths pay no AJV cost.

What operators will see: in dev/test/CI, each incoming request that
doesn't match the bundled AdCP request schema logs a single
`Schema validation warning (request)` line through the configured
logger, with the tool name and the field pointer. Nothing is rejected —
the request still flows to the handler exactly as before. Node's test
runner does not set `NODE_ENV`, so suites running under `node --test`
fall into the dev/test bucket and will start emitting these warnings.

How to opt out: pass `validation: { requests: 'off' }` on the server
config, or set `NODE_ENV=production` for the process.

Why: keeps request and response defaults symmetric, and prepares seller
operators for upstream AdCP schema tightenings (e.g. adcp#2795, which
introduces a required `asset_type` discriminator — buyer agents still
on RC3 fixtures will lack it). Surfacing those drifts as warnings
during development beats discovering them in a downstream consumer's
`VALIDATION_ERROR` after deploy.

Related: #694 (original intent for `requests: 'warn'`) and #727 A
(response-side default precedent).
