---
'@adcp/sdk': minor
---

Authorize fresh fixture preparation before any seller contact (#3389).

`prepareStoryboardFixtures()` never consulted `prepared_fixtures_authorizer`, so a host could refuse the _reuse_ of a pinned graph but not the catalog read that pinned it. Reproducing the report on 16.3.0: the hook was consulted only by the reuse gates, the binding was built after discovery and seeding, and `@adcp/sdk/testing` exposes no pure binding builder — so a host could not truthfully call its own hook earlier without duplicating SDK-keyed identity logic or fabricating a reference or profile.

**Preparation now asks the supplied authorizer exactly once, before a client is created** — before `initialize`, capability discovery, controller reset/seeding and the catalog read. Every non-grant answer fails closed with zero seller contact: denied, absent, malformed, throwing and rejecting all raise `PreparedFixturesDeniedError` with `refusalCode: 'authorizer_denied'`, and the canonical refused record goes to `prepared_fixtures_audit_sink`. Omit the authorizer and preparation is unchanged; making one mandatory would refuse every preparation that exists today.

**Public contract change, deliberately reviewed rather than worked around.** The existing lookup could not truthfully describe this stage, so `PreparedFixturesLookup` gains:

- `gate` accepts `'prepare'` alongside `'run' | 'pass' | 'step'`.
- `binding` is now **optional**, absent exactly when `gate === 'prepare'`. Nothing has been prepared at that point, and filling it with a copy of `current` would tell the host that stored state matches when there is no stored state.

**Migration:** an authorizer that reads `lookup.binding.*` unconditionally must handle the `prepare` gate, where it is absent — TypeScript will flag this at compile time. Branch on `gate === 'prepare'` and use `current`, which carries the full SDK-owned identity (storyboard digest, routes, schema artifact, account and brand scope, sandbox, principal, credential fingerprint), none of it seller-derived.

The prepare gate is additional to the reuse gates, never a substitute: a run reusing the state still makes its own `run`, `pass` and `step` lookups, and every-lookup authorization and fail-closed behaviour are unchanged.
