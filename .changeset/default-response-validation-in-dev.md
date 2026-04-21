---
'@adcp/client': minor
---

`createAdcpServer` now defaults `validation.responses` to `'warn'` when `process.env.NODE_ENV !== 'production'`. Previously both sides defaulted to `'off'`, leaving schema drift to surface downstream as cryptic `SERVICE_UNAVAILABLE` or `oneOf` discriminator errors far from where the offending field lives.

The new default catches handler-returned drift at wire-validation time with a clear field path, in dev/test/CI, where you want the signal. Production behavior is unchanged — set `NODE_ENV=production` and both sides stay `'off'`.

Override explicitly via `createAdcpServer({ validation: { responses: 'off' | 'warn' | 'strict', requests: ... } })` — an explicit config always wins over the environment-derived default.

This is the first half of the architecture fix tracked in [#727](https://github.com/adcontextprotocol/adcp-client/issues/727) — validation belongs at the wire layer, not in response builders. Tightening generated TS discriminated unions so `tsc` catches sparse shapes is the remaining half.

Cost: one AJV compile per tool on cold start + one validator invocation per response in dev. No effect on production.
