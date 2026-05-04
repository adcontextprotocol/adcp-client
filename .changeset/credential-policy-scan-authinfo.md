---
'@adcp/sdk': minor
---

`credentialPolicy.scanAuthInfo` (default `false`) extends the credential-shaped scan to cover `ctx.authInfo.extra` at any depth, using the same pattern set as the args scan. Closes the leak surface where custom authenticators stamp credential-shaped values into `authInfo.extra` (token-introspection responses, JWT claim sets, OAuth scope blobs) and adopter handler code or log lines propagate them.

```ts
createAdcpServer({
  credentialPolicy: {
    policy: 'authInfo-only',
    scanAuthInfo: true,        // NEW: extend perimeter to authInfo.extra
  },
});
```

**Fully orthogonal to `policy` mode.** Adopters can mix `policy: 'lax' + scanAuthInfo: true` (trust args, defend authInfo log propagation) or any combination. Per-tool `'lax'` overrides only affect the args scan — `scanAuthInfo` fires regardless.

**Wire-envelope discipline.** Args-bag hits report in `details.credential_paths` (existing behavior). `authInfo.extra` hits are LOG-ONLY — paths surface in `logger.warn` server-side; the wire envelope reports a coarse signal (`details.scope: 'credentials'`, `recovery: 'terminal'`) without enumerating which `extra` field tripped the scan. Prevents an info-disclosure oracle on internal authInfo structure the buyer has no read access to.

Default `false` because OAuth introspection blobs and JWT claims in `extra` will false-positive on default patterns like `/_token$/i`. Adopters opt in only when their authenticator keeps `extra` credential-clean. Closes #1539.
