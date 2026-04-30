# OAuth provider wiring

If buyers authenticate via OIDC `client_credentials`, wire an introspection callback so the framework resolves `auth.client_id` from incoming bearer tokens.

```ts
import { serve, verifyIntrospection } from '@adcp/sdk/server';

serve(() => server, {
  port,
  authenticate: verifyIntrospection({
    introspectionUrl: process.env.OIDC_INTROSPECTION_URL,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
  }),
});
```

Framework projects `auth.client_id` → `ctx.authInfo.clientId` in your handlers, and into the default idempotency principal resolver.

For multi-tenant deployments where each tenant has its own OIDC issuer, see `MULTI-TENANT.md` (resolveTenant uses the issuer to route).

See `REFERENCE.md` for full OAuth section.
