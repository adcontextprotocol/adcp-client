# Migrating from SDK 14.0 to 14.1

SDK **14.1.0** still uses AdCP **3.2.1** on the wire. Its signature verification
adopts the AdCP 3.3 agent-resolution algorithm; this does not upgrade your wire
protocol or require enabling a new media-buy lifecycle.

```sh
npm install @adcp/sdk@14.1.0
```

Account policies and strict account references keep their 14.0 defaults. Check
the applicable rows below before rolling out: some TypeScript types change,
and signature verification rejects identities or keys it cannot confirm.

## Required changes when applicable

| If your integration… | Change for 14.1 |
|---|---|
| Exhaustively switches over `WholesaleFeedSyncState` | Add a `degraded` case. A failed refresh preserves an existing mirror and marks it degraded; an initial failure still sets `error`. |
| Reads registry refresh fence fields as required values | Handle `undefined` on the deprecated fields in `AgentComplianceDetail.refresh_availability` and the `refreshAgent` 503 response. For example, use `refresh_availability.code ?? 'unknown'` for a local display label. The live registry no longer returns these fields; removal from SDK types is planned for the next major release. |
| Uses a standalone `BrandJsonJwksResolver` with A2A | Set `protocol: 'a2a'`. Capability discovery defaults to MCP; the onboarding record does not select the transport. |
| Supplies a natural-key account reference to an implicit seller | Resolve the complete key within the authenticated caller's synced roster. Include brand identity, operator, operator unit, currency, timezone, and sandbox. An unknown supplied reference must return `null`, never fall back to another account. See [account resolution](./guides/account-resolution.md#implicit-deep-dive). |
| Stores non-canonical issuer URLs in governance principal, replay, or revocation indexes | Migrate those keys to the canonical issuer identity before switching verification. Preserve replay and revocation history; use the [signature migration guide](./migration-agent-resolution-3.3.md) to check normalization rules. |
| Configures JWKS or operator discovery cache limits | Review the bounds in the [signature migration guide](./migration-agent-resolution-3.3.md). Brand discovery requires positive `maxAgeSeconds`; non-finite or negative cache options fail configuration validation. Expired mappings and keys are refused rather than reused. |
| Repairs wholesale mirrors from webhook deliveries | Acknowledge only after `refresh()` or repair succeeds. Failed catalog reads now reject, preserving the mirror and leaving the delivery eligible for retry. |

For the complete list of newly optional registry fields, see the
[14.1.0 changelog](../CHANGELOG.md#1410).

## Security behavior to verify

Existing resolver constructor signatures remain supported, but accepting a key
now requires a confirmed canonical agent identity and the capabilities-selected
operator record. Ambiguous onboarding and unconfirmed cross-domain mappings
fail closed. Prefer supplying the expected `agentUrl` already recorded by your
integration.

Publisher-pinned webhook keys must also appear in the agent JWKS as the same
public key. Resolve pins from your persisted registration and media-buy record
for every affected publisher, rather than selecting publishers from the webhook
payload. Refresh callbacks must throw on fetch failure; `null` confirms removal
of a pin. Follow the [publisher-pin migration guidance](./migration-agent-resolution-3.3.md#publisher-pin-context).

`SingleAgentClient` and `BrandJsonJwksResolver` retain legacy 3.x webhook
fallback by default. A standalone `ResolvedAgentJwksResolver` requires explicit
opt-in. That fallback does not authorize request signatures.

Signed MCP and A2A HTTP 401 errors now retain signature diagnostics and repair
guidance. Explicit Signature-challenge rejections skip unsigned authentication
probes and credential refresh retries. Bare signed 401s retain the existing
single client-credentials refresh attempt.

## Optional adoption

| Feature | Default and adoption path |
|---|---|
| Buyer account registry | `accountPolicy` remains `'off'`. Set `'auto'` or `'strict'` to enforce setup, or configure registry storage/scope/capacity to opt into memoized `resolveAccount()`. Without opt-in, that helper still sends `sync_accounts` on each call. See [first call to a seller](./guides/FIRST-CALL-TO-A-SELLER.md). |
| Product cache | Opt in with `createProductCache`. Public and account-scoped responses stay separate; missing `cache_scope` prevents caching. See [buyer setup and caching](./guides/FIRST-CALL-TO-A-SELLER.md). |
| Strict seller account references | `strictAccountReferences` remains false; compatibility paths warn. Move reference authorization into `resolveAccount`, then set it to true. It becomes the default in the next major release. See [strict account references](./guides/account-resolution.md#strict-account-references-strictaccountreferences). |
| Additive implicit account sync | `InMemoryImplicitAccountStore` keeps replacement sync semantics and its 24-hour TTL. Set `mergeOnUpsert: true` for additive batches; `delete_missing: true` still requests replacement. Use `remove(ref, ctx)` for individual revocation. |

Account resolvers now receive `ctx.provisioning`. Discovery and negotiation
must remain lookup-only; gate any lazy account creation on this flag. The
[seller account guide](./guides/account-resolution.md) includes an example.

## Check your rollout

- Compile your application to catch the new state and optional registry fields.
- Exercise signed requests and webhooks against your actual agent/operator
  records, including key rotation and any publisher pins.
- Check that supplied unknown or unauthorized account references are refused,
  and that discovery does not create accounts.
- If you handle `sync_accounts` results, handle per-account notification
  event-type failures. In strict request validation, valid siblings can proceed;
  with `delete_missing: true`, the invalid batch is refused before writes.
  Warn-mode validation remains advisory, as in 14.0.
- Exercise failed feed refreshes and webhook redelivery without losing the last
  good mirror.

The published 14.1.0 artifact passed reporting core **4/4** and full lifecycle
**4/4** qualification, with integrity and provenance verified. This covers
Python producers and TypeScript consumers. It does not establish reverse-direction
parity or Python version-skew coverage; broader work remains in
[#3027](https://github.com/adcontextprotocol/adcp-client/issues/3027).
See the [published release and qualification evidence](https://github.com/adcontextprotocol/adcp-client/releases/tag/%40adcp/sdk%4014.1.0).
