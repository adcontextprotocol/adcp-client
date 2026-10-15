# Experimental AdCP 3.3 agent identity

The experimental identity rollout is tracked in
[adcp-client#3233](https://github.com/adcontextprotocol/adcp-client/issues/3233).
This release implements the rollout behind explicit experimental configuration.
The SDK's default `ADCP_VERSION` remains **3.2.4**. Experimental client/server
instances select the 3.3 carrier and apply the pinned draft overlays to the
released bundle; they do not regenerate or replace the public 3.2 types.
Upstream PRs remain open, so the experiment can change before graduation.

The dedicated API is `@adcp/sdk/identity-3.3`. Existing RFC configuration remains
supported through 3.x and emits a one-time deprecation warning when used.

## Canonical agent origins

```ts
import { canonicalAgentOrigin } from '@adcp/sdk/signing/client';

const origin = canonicalAgentOrigin('HTTPS://User@Buyer.Example.COM.:443/mcp?x=1');
// https://buyer.example.com
```

The helper is also exported from `@adcp/sdk/signing/server` and
`@adcp/sdk/signing`. It reuses the existing authority canonicalization rules:
scheme and host case normalization, one trailing DNS root dot removed,
userinfo and default ports stripped, and non-default ports preserved. Path,
query, and fragment do not participate in origin comparison. Malformed
authorities, raw authority backslashes or control characters, and IPv6 zone
identifiers are rejected. Producer inputs with IDN
U-labels normalize to Punycode A-labels. Wire comparers must separately reject
raw non-ASCII hostnames before comparing, as the existing `canonicalAgentUrl`
helper does.

The existing `canonicalizeOrigin` / `originsEqual` primitives and
`identity.key_origins` comparisons use this same authority validation. A
single trailing DNS root dot now compares equal to its dotless form;
malformed authorities that the URL parser previously repaired are rejected.
`CanonicalizeError` is exported from the same signing entry points. Origin
errors use fixed messages and redact the input in `meta.input`, including
userinfo, path, and query values.

Origin normalization does not verify a signature or grant authority. Continue
to use full canonical agent URLs for existing RFC 9421 identities, governance
JWS issuers, and path-mounted agents. The WBA profile permits one agent
per origin; origin equality alone must not merge existing principals.

## Resolver request context

Both `JwksResolver.resolve(keyid, signerOrigin?)` and the optional
`resolveWithMetadata(keyid, signerOrigin?)` accept an origin locator. Existing
one-argument implementations and calls remain compatible. Static and HTTPS
resolvers remain pinned to their configured keys or URL; the additional
argument does not turn them into identity-discovery resolvers.

`ResolvedAgentJwksResolver` checks a supplied origin against the origin of its
configured agent URL before discovery or cached-key access. A mismatch or
malformed locator is rejected with `request_signature_key_unknown`; raw
non-ASCII context hostnames are rejected before origin comparison. Matching
origins retain the full capability-confirmed `agentUrl` in discovery metadata.
Percent-encoded context hostnames are also rejected so escaped U-labels
cannot bypass wire validation; percent escapes in stripped userinfo remain
accepted. Producer origin normalization retains its existing behavior.
`BrandJsonJwksResolver` forwards the context through both lookup methods,
including after legacy onboarding has selected and pinned an agent URL.
When legacy brand configuration omits `agentUrl`, initial onboarding must
complete the configured operator, capability, and JWKS discovery chain to
confirm and pin an agent URL before it compares origin context. Subsequent
lookups check the pinned origin before fetching keys. The
context never changes the onboarding fetch target.

Custom wrappers must forward both the argument and discovery metadata:

```ts
import type { JwksResolver } from '@adcp/sdk/signing/server';

function wrapResolver(inner: JwksResolver): JwksResolver {
  return {
    resolve: (keyid, signerOrigin) => inner.resolve(keyid, signerOrigin),
    ...(inner.resolveWithMetadata && {
      resolveWithMetadata: (keyid: string, signerOrigin?: string) =>
        inner.resolveWithMetadata!(keyid, signerOrigin),
    }),
  };
}
```

Origin-aware caches and concurrent-lookup coalescing must use
`(canonicalAgentOrigin(signerOrigin), keyid)` as their key. A shared `kid`
must never select another origin's key or metadata. Keep context-free lookups
separate. Use a structured key, such as nested maps or `JSON.stringify([origin, keyid])`,
to prevent delimiter collisions. Treat the origin as an unverified locator until signature
verification succeeds. Validate request-derived locators against the wire
rules before forming a cache key; producer normalization alone does not
reject raw IDN U-labels. On request verification, metadata remains necessary
to reject webhook-only fallback keys and expired operator delegations.

## Buyer signing and webhook registration

```ts
import { SingleAgentClient } from '@adcp/sdk';
import { jwkThumbprint } from '@adcp/sdk/identity-3.3';

const client = new SingleAgentClient({
  ...seller,
  request_signing: {
    profile: 'web-bot-auth',
    agent_url: 'https://buyer.example.com',
    kid: jwkThumbprint(privateJwk),
    alg: 'ed25519',
    private_key: privateJwk,
  },
}, {
  experimentalIdentity33: true,
  webhookSigningProfile: 'web-bot-auth',
  webhookVerification: {
    webBotAuth: { directory, isRevoked: (origin, kid) => revocations.isRevoked(origin, kid) },
  },
});
```

The official MCP/A2A transports receive the SDK's signed fetch wrapper. The
seller must advertise `request_signing.profiles` containing `web-bot-auth`.
Provider configurations additionally supply `public_key`; the provider's
thumbprint kid and algorithm must match that public key. The wrapper signs the
final UTF-8 body, covers the selected `Signature-Agent` member and digest,
uses a fresh nonce, and refuses automatic HTTP redirects. `signWebBotAuth`
also supports `relay: true` with a new label; the verifier validates every
layer regardless of dictionary ordering.

`SignatureDirectoryResolver` derives the directory from the covered canonical
origin. It validates a possession signature for every key and the exact body
digest before caching keys. Its audit proof retains the signed body and
headers. Verification requires this resolver so context-free JWKS adapters cannot
attribute a key to an arbitrary origin. Discovery uses HTTPS, DNS pinning, no redirects, a 256 KiB cap, a
5-second connect bound and 10-second total bound, at most 64 keys, and bounded
single-flight/negative caches. Successful refresh replaces the key set;
failed refresh cannot prove removal, and never extends possession-proof
expiry. Published vector keys are rejected in production.

Publish an origin revocation list even when no keys are revoked. For example:

```sh
adcp identity revocations --origin https://buyer.example.com --keys private-jwks.json --output revocations.jws
```

Serve the exact JWS at `/.well-known/governance-revocations.json` and refresh it
before `next_update` (the command defaults to five minutes). Pass `--snapshot`
to sign a list of revoked key thumbprints and optional reasons/dates.
`createSignedOriginRevocationList` provides the same authoring API. The SDK
supports Ed25519 and P-256 identity keys. Observed key revocations are permanent;
refresh failures use the last verified list only within the published grace
window. Staleness follows the list's signed `next_update`, never the polling
interval: the verifier re-polls at least every polling interval (at most 30
minutes) and fails closed only after `next_update` plus four polling
intervals. Publishers MUST NOT declare `next_update` more than 30 minutes ahead
(the authoring helper refuses it), but a verifier tolerates a longer cadence
from other implementations: each successful fetch of such a list stays valid
for at most 30 minutes plus grace, so an outage cannot extend acceptance past
that. A list whose `updated` is more than 60 seconds ahead of the verifier
clock, or whose `next_update` has passed, is refused. `OriginRevocationResolver.status()` reports `revoked`, `current`
(including within grace), `absent` (the origin answers 404/410: the identity is
established but cannot be bound for spend) or `unknown` (no verifiable list and
grace has passed: the identity is not established, so the request is handled as
unverified). History-store failures throw `revocation_persistence_failed`, an
infrastructure outage handled by the application layer. `isRevoked()` remains as
a compatibility wrapper that throws `revocation_unavailable` for `absent` and
`unknown`.

For positively negotiated 3.3 sellers advertising signed webhooks, experimental
clients omit injected reporting/task webhook HMAC authentication even when a
client secret exists. Explicit caller authentication preserves the legacy
choice. Older, unknown-version, and unsigned-webhook sellers preserve existing
behavior. `update_media_buy` and artifact registrations are validated with the
same negotiated draft rules. The selected asymmetric profile is persisted in
the trusted callback registration and survives Redis/Postgres storage and
restart. An incoming header cannot change that selection. Reporting routes
use the configured registration lifetime; keep it long enough for delivery.
Sellers must persist `reporting_webhook.signing_profile` with their media-buy
record and pass it to later `emitWebhook` calls; the request context forwards
it automatically only for deliveries emitted during that request.

WBA webhook verification pins the signer to the registered seller origin.
Registrations requiring legacy delegated-operator resolution or publisher JWS
pins must select the RFC webhook profile; the SDK rejects that combination
under WBA. Configure a shared replay store across replicas.

## Seller authorization and durable state

Signature verification establishes an origin, never a principal or spend
permission. Trust evaluation runs at binding, grants, and open onboarding,
never during cryptographic verification. Wire `signedRequests.webBotAuth` (or
`verifySignatureAsAuthenticator.webBotAuth`) with a signed directory,
origin-revocation resolver, and `createIdentity33PrincipalResolver`.

```ts
import {
  createIdentity33StateStores, TrustEvaluator, OriginIdentityLifecycle,
  SignatureDirectoryResolver, OriginRevocationResolver,
  createIdentity33PrincipalResolver, createIdentity33PrincipalScopeResolver, createIdentity33Authorization,
  withIdentity33PrincipalHandlers,
} from '@adcp/sdk/identity-3.3';

const stores = createIdentity33StateStores({ store: sharedStateStore, tenantId });
const trust = new TrustEvaluator({ authorityHistory: stores.authorityHistory });
const lifecycle = new OriginIdentityLifecycle({
  store: stores.identity,
  trust,
  onboarding,
  lookupLegacyPrincipals: app.lookupLegacyPrincipals,
  checkRequirement: app.checkOnboardingRequirement,
  hasBillingRelationship: app.hasBillingRelationship,
  notify: app.publishPrincipalInvalidation,
});
// Configure principalRuntime's resolvePrincipal with this mapping. Both its
// authorization scope and public record id must use the audited binding.
const resolvePrincipalScope = createIdentity33PrincipalScopeResolver({
  lifecycle, tenantId, legacy: app.resolveLegacyPrincipal,
});

const directory = new SignatureDirectoryResolver();
const revocations = new OriginRevocationResolver({ directory, store: stores.revocations });
const authorize = createIdentity33Authorization({
  lifecycle,
  grants: { evaluator: trust, resolveBrandHouse: app.resolveVerifiedBrandHouse },
  resolveClaims: app.resolveAuthorizedAccountClaims, // Read-only account lookup; never provision here.
});

const server = createAdcpServerFromPlatform(platform, {
  ...serverOptions,
  identity33: { authorize },
  protocol: withIdentity33PrincipalHandlers(principalRuntime.protocol, lifecycle),
  signedRequests: {
    ...legacyVerifierOptions,
    assertLegacyOriginAllowed: url => lifecycle.assertLegacyAllowed(url),
    webBotAuth: {
      directory,
      isRevoked: (origin, kid) => revocations.isRevoked(origin, kid),
      resolvePrincipal: createIdentity33PrincipalResolver({ lifecycle }),
    },
  },
});
```

`sharedStateStore` must implement atomic `getWithVersion`/`putIfMatch`; the SDK's
Postgres store supplies these. Hoist stores outside request factories and bind
`tenantId` to trusted routing. The adapters retain bindings/audits, operator
quotas, authoritative trust history, applications/outbox notifications, and
monotonic revocation facts across restarts. In-memory stores are for development.
`resolveClaims` runs before account resolution and receives the authenticated server context: for `sync_accounts`,
return every proposed claim before provisioning; for spend, use the existing
seller-resolved account's brand/operator/billing/sandbox, never request
reassignment. Authorization runs before idempotency lookup and handler effects.
Keep the normal buyer registry's suspension, blocking, sandbox and billing
gates enabled; grants do not replace them.

`bindPrincipal` requires seller audit evidence. Existing RFC mappings require
explicit migration approval and an unambiguous origin. `sync_principal` may
create only a new principal under declared open tiers; legacy-ledger lookup is
mandatory. Quotas apply to the operator domain. PRIVATE PSL origins can open
sandbox access only. Open agent billing is never automatic; production operator
or advertiser billing additionally requires the seller's existing billing
relationship with that billed domain. Unknown requirements remain unsatisfied;
wrong-direction requirements are ignored, with message/URL fallback for humans.

Set the seller's `platform.capabilities.account.agentOnboarding`, supported
billing and sandbox fields, and declare `account.agent_onboarding` in
`platform.capabilities.overrides.experimental_features`. Declare request
profiles through `overrides.request_signing`. Server construction validates
posture semantics; unbound `get_principal` reads remain `unconfigured` and
never run the durable principal runtime. Caller-only relationships may exist
before binding. Notification reasons are `relationship_changed` and
`relationship_expiring`. Queue state is committed before publish; reuse the
provided notification ID as the emitter's delivery ID. Call
`flushRelationshipNotifications` after restart and schedule
`notifyRelationshipExpiring` with your seller-declared lead time.

## Trust, grants, and revocation

The operator is derived using the pinned ICANN+PRIVATE PSL, never a document
field or authoritative hop host. Trust reads allow one document hop, zero HTTP
redirects, 2 MiB, depth 32, and no duplicate JSON keys. Exactly one canonical
origin must carry the required role. Cache lifetime is the configured revocation
poll interval (60–1800 seconds), negatives at most 60 seconds. Failures are not
absence. Share authoritative-history state when retaining legacy fallback.

Demand grants come from the verified brand or house record. Implicit authority
requires brand, account operator, and signer operator to share a registrable
domain. Otherwise only a direct grant with the account operator equal to the
signer, or a two-link chain through the account operator, is accepted. The
intersection must cover the actual brand IDs, countries, scope, signer-origin
narrowing and temporal window. A restrictive published grant cannot be
superseded by seller fallback. A trust 200 disables brand.json authority;
authoritative absence alone permits explicit legacy policy. An established
identity lacking a grant gets `PERMISSION_DENIED` with
`{ scope: 'agent', reason: 'grant_absent' }`. No account or live buy is changed.

Origin key revocations use `/.well-known/governance-revocations.json`, signed
with `typ: adcp-gov-revocation+jws`, as ratified R3 specifies. This origin key
list does not migrate governance-context, designated-task response or rights
JWS discovery: those retain the RFC chain in 3.3. Polling fails closed, revoked
keys remain revoked forever, `keyCompromise` cannot be weakened, and the earliest
`invalidity_date` is retained. Revocation never pauses or cancels committed buys.

Permanent revocation storage reserves separate bounded capacity for audited bound
origins and anonymous/self-service origins, so first-contact traffic cannot exhaust the bound
pool. Storage failures deny reads and mutations without outage grace; inspect the
non-enumerable error cause and raise `createIdentity33StateStores.revocationLimits`
when capacity is exhausted. Existing facts must remain stored. When the shared
refresh limiter is full (attacker-selected origins can occupy it), an origin
whose last verified list is still inside `next_update` plus grace keeps that
status, exactly as if its own fetch had failed; past grace it fails closed.

## Authoring and pinned sources

```sh
adcp identity trust-validate trust.json
adcp identity directory --origin https://buyer.example.com \
  --keys private-jwks.json --output directory-response.json
```

Serve the output's exact body and headers at the directory well-known path.
Re-run after rotation and before proof expiry. The helper publishes public
thumbprint keys only; keep the input private key file private. The SDK also
exports `createSignedSignatureDirectory`, `createTrustRecord`, and
`validateTrustRecord` for applications. Trust records contain no key discovery.

The implementation pins these upstream heads, rather than claiming they are
released schemas:

| PR | Pinned head | Surface |
| --- | --- | --- |
| [7894](https://github.com/adcontextprotocol/adcp/pull/7894) | `656bd080f01cc2fca4a1e623af44e96cfd827ba5` | WBA wire profile, profile selectors, directory and request/relay vectors |
| [8121](https://github.com/adcontextprotocol/adcp/pull/8121) | `f5973ac0267b1b94d714c55fc4e3ad8fc2511350` | Origin identity and key-free trust v1 |
| [8162](https://github.com/adcontextprotocol/adcp/pull/8162) | `5c9914c5c382cc32f3d2ad7842942e548c414705` | Ratified identity, coexistence, revocation |
| [8168](https://github.com/adcontextprotocol/adcp/pull/8168) | `45540941dfd61e80ab8a463f780cb147c82a32f0` | Relationship and principal response arms |
| [8169](https://github.com/adcontextprotocol/adcp/pull/8169) | `3ce6a14d7afaa71fa78ddf2223ed0421e01205ae` | Grants, trust schema, grant_absent |
| [8170](https://github.com/adcontextprotocol/adcp/pull/8170) | `8d3591e70e9a717c7fdfb513360a796fba24ca9a` | Onboarding additions only; its old trust key fields are excluded |
| [8177](https://github.com/adcontextprotocol/adcp/pull/8177) | `b663f8e4235fe4276c73fb9bac6db491b2252bbf` | Reporting authentication omission |

Ratified R2 defaults replay to 429. Older vector negative/002 expects 403;
`replayStatus: 403` is an explicit compatibility test option, not the default.
Older #7894 governance vectors propose a superseded migration and are retained
with their non-applicability recorded in `test/fixtures/wba-profile/PINNED.json`.
The buyer default onboarding field is `profiles.adcp.onboarding`, matching the
schema; the design's `record_profiles` wording names the schema definition.

The process-local trust evaluator bounds authority history and conservatively disables legacy fallback after history eviction. Production sellers should supply `authorityHistory` from the shared state stores so history survives restarts and cache eviction.

Open `sync_principal` commits the newly approved origin binding before the caller notification-configuration handler runs. A later configuration failure does not undo that binding; retry applies configuration to the same principal. This allocation never grants spend authority: every mutating request still passes tier, relationship and grant checks before provisioning or idempotency.

`resolveClaims` must perform its own read-only lookup of the existing seller account; `ctx.account` is unset because authorization precedes account resolution and provisioning. Always use `createIdentity33PrincipalResolver` with this authorization hook so verified WBA requests carry the protected identity claim.

Before enabling persisted webhook profile selection, rerun `getWebhookRegistrationMigration()` against existing PostgreSQL registration tables. It adds the optional `signing_profile` and `delivery_kind` columns; existing NULL rows retain the RFC verifier and their existing provenance. Redis and memory records preserve the optional fields directly.

Reusing a reporting or artifact URL extends its matching registration's expiry.
Use a new callback URL when changing its signing profile while old deliveries are
still outstanding. A live URL's verifier remains immutable; changing it requires
explicitly deleting the old registration, which also stops accepting old deliveries.

Compute the deletion key with `deliveryWebhookRegistrationId` from
`@adcp/sdk/identity-3.3`, then call
`store.delete(agentId, deliveryWebhookRegistrationId('reporting', callbackUrl))`.

The standard principal resolver automatically fences RFC signatures for already-bound origins. Custom resolvers must supply `assertLegacyOriginAllowed`; legacy keys must resolve an unambiguous agent origin. Preserve an existing operator principal during approved migration by passing `principalKind: "operator"` to `bindPrincipal`. WBA authenticators enforce signature presence and must use `requireSignatureWhenPresent` for bearer coexistence.

Signing capabilities include the experimental `wba_draft_revision` field next to `profiles`, identifying `draft-ietf-webbotauth-httpsig-protocol-00` as required by ratified R2. Reporting and artifact callback choices are persisted by destination before dispatch, including update calls; their receivers pass the trusted request URL and `taskType` (`media_buy_delivery` or `artifact_delivery`) to `verifyAndParseWebhook`. These deliveries preserve the original payload in `result` after authentication and schema validation; `envelope` adds SDK routing/status metadata. PostgreSQL migrations also add optional `delivery_kind`.

Revocation stores allocate no permanent row for an empty list. Each audited/unbound pool reserves a tenant-wide CAS budget (10,000 origins and 100,000 keys; each operator is limited to 256 origins and 16,384 keys per pool). Audited bindings promote existing facts without deleting them; self-service `openAccess` bindings stay in the unbound pool. Failed writes may conservatively reserve capacity; facts are never evicted to regain it. Store/quota failures return `SERVICE_UNAVAILABLE` for every operation. In-memory revocation storage is for development/tests and is bounded per origin, per operator (registrable domain, default 16,384 keys) and in total, so wildcard subdomains of one operator cannot fill it alone (several operators still can, and a refused merge fails closed); production sellers use shared persistent stores.

Unbound callers use an internal per-origin anonymous scope to isolate task/proposal state; this is not a durable principal and is never returned by `get_principal`. Only the explicit anonymous tool policy is allowed.
