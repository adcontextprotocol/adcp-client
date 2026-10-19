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
    webBotAuth: { directory, revocation: revocations },
  },
});
```

The official MCP/A2A transports receive the SDK's signed fetch wrapper. The
seller must advertise `request_signing.profiles` containing `web-bot-auth`.
Provider configurations additionally supply `public_key`; the provider's
thumbprint kid and algorithm must match that public key. The wrapper signs the
final UTF-8 body, covers the selected `Signature-Agent` member and digest,
uses a fresh 64-byte nonce, and refuses automatic HTTP redirects. A request
carries exactly one `web-bot-auth` signature and one `Signature-Agent` member:
relays were removed from the profile, `signWebBotAuth` throws on `relay: true`
and on a request that already carries signature fields. The verifier reads
only the `Signature-Input` member tagged `web-bot-auth` and ignores members
with other tags, such as a CDN's own signature. It answers a second
`web-bot-auth` signature or a second `Signature-Agent` member with 403.
Signing keys are Ed25519 only; ES256 stays on the AdCP RFC 9421 profile, and
`createWebBotAuthFetch`, `createWebhookEmitter` and `createAdcpServer` refuse
a P-256 or RSA Web Bot Auth key at wire-up.

This also changes two helpers outside the experiment. `verifySignature` and
`verifySignatureAsync`, which `@adcp/sdk/signing/server` exports, no longer
verify `rsa-pss-sha512`: they return `false` for it, as for any algorithm they
don't support. Only Web Bot Auth used it, and the AdCP RFC 9421 profile allows
only `ed25519` and `ecdsa-p256-sha256`. A caller that verifies RSA-PSS
signatures with these helpers needs to verify them with `node:crypto` or
WebCrypto instead.

The covered `Signature-Agent` member must be exactly the canonical https origin
string, compared as received: a lowercase host, no default port, and no path
(not even `/`), query, fragment, or userinfo. Any other value, including an
`http://` origin, is a 403 before any directory fetch. The signers apply the
same rule: `signWebBotAuth`, `createSignedSignatureDirectory` and
`createWebBotAuthFetch` canonicalize the agent origin they are given and throw a
`TypeError` when it is not https, such as `http://localhost:3000`. There is no
http opt-in. The member's `type`
parameter is a Token (WBA section 5.2.1), and the verifier accepts
`type=directory` as a Token or as a String. It ignores a member of any other
type, which leaves no member to resolve (403).

`SignatureDirectoryResolver` derives the directory from the covered canonical
origin. Directories must be signed (WBA Appendix B.1): it validates a
possession signature for every key the profile can use, covering
`"@authority";req` and `content-digest`, and the exact body digest before
caching keys. It ignores keys the profile cannot use, such as a P-256 key, and
any signature they made (RFC 7517 section 5). An unsigned directory, one
with no usable key, or one that publishes private key material for any key,
usable or not, is a discovery failure. Its audit proof retains the signed body and
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
signs and verifies revocation lists with Ed25519 directory keys, as EdDSA. Observed key revocations are permanent;
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
      // Revocation and binding run after verification, in the identity layer.
      resolvePrincipal: createIdentity33PrincipalResolver({ lifecycle, revocation: revocations }),
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
Fetches to an operator's own hosts are rate-limited per (operator, host);
`authoritative_location` hops to hosts outside the operator's registrable domain
share one separate per-host budget. A hop therefore never spends the target
operator's own budget, and many operators cannot multiply fetches to one host.
A host-rate refusal is a retryable outage that is not cached as the operator's
failure.

A record that cannot be read (transport error, outage, rate, invalid content)
raises `TrustRecordUnavailableError`; a current record that does not list the
origin with the required role raises `TrustMembershipError`. Both extend
`IdentityAuthorizationError`. For a bound origin:

- **Delisted:** the last record read does not list the origin with the role
  (operators retire agents by publishing an empty `agents[]`). The origin is
  identity-established for every request, task polling and cancellation
  included: the principal resolver demotes it to the per-origin anonymous
  scope with no credential and no registry-resolved `ctx.agent`, and it gets
  the anonymous tool policy plus `get_principal` (which reports
  `unconfigured`). The binding is kept: `open` onboarding cannot re-bind it and
  RFC 9421 stays refused for the origin. Spend gets `PERMISSION_DENIED` with no
  details. A known delisting stays a delisting through a later failed refresh.
- **Unreachable:** a record that cannot be read, including a 404/410 after a
  record was read (or for any bound origin, on every replica), is a discovery
  failure, never a removal; the last record read stays authoritative.
  Spend-committing calls get a retryable `SERVICE_UNAVAILABLE`. As seller
  policy, reads and identity configuration continue under the binding while
  the last record read listed the origin and is within
  `TrustEvaluator({ maxOutageContinuationSeconds })` (default four polling
  intervals) of its freshness; after that nothing is served (`503`).

After every signature verifies, authorization outcomes use the standard AdCP
error envelope, never a 403 with `Accept-Signature`. That includes a principal
resolver that throws: a transient (or uncoded) error is an outage answered
`503 SERVICE_UNAVAILABLE` by the server, and any other coded error is
`PERMISSION_DENIED`, delivered on the tool call (other requests are refused with
that envelope and no challenge).

Demand grants come from the verified brand or house record. Implicit authority
requires brand, account operator, and signer operator to share a registrable
domain. Otherwise only a direct grant with the account operator equal to the
signer, a direct grant from a self-operated brand (the brand is its own account
operator) to the signer's operator, or a two-link chain through the account
operator, is accepted. The
intersection must cover the actual brand IDs, countries, scope, signer-origin
narrowing and temporal window. A restrictive published grant cannot be
superseded by seller fallback. A trust 200 disables brand.json authority;
authoritative absence alone permits explicit legacy policy. An established
identity lacking a grant gets `PERMISSION_DENIED` with
`{ scope: 'agent', reason: 'grant_absent' }`. No account or live buy is changed.
A grantor that once served trust.json and is now unreachable (404/410
included) never falls back to brand.json `authorized_operators[]`, and it is
not a grant removal: spend gets a retryable `SERVICE_UNAVAILABLE`.

Origin key revocations use `/.well-known/governance-revocations.json`, signed
with `typ: adcp-gov-revocation+jws`, as ratified R3 specifies. The same list
revokes the keys a WBA identity signs its JWS artifacts with (see
[JWS artifacts](#jws-artifacts)). Polling fails closed, revoked
keys remain revoked forever, `keyCompromise` cannot be weakened, and the earliest
`invalidity_date` is retained. Revocation never pauses or cancels committed buys.

### JWS artifacts

Governance contexts, designated-task responses and rights attestations from a
WBA identity are signed with keys from that identity's key directory (R4 as
amended by adcontextprotocol/adcp#8299). `O` is the canonical origin of the
signing agent's URL: `iss` for a governance context, `agent_url` for a
designated-task response, `rights_agent.url` for a rights attestation. Pass it
from your own context, never from the unverified token.

- `selectJwsArtifactProfile(agentUrl, trust)` derives the trust record from
  `O`. When it lists `O`, the artifact is verified on the WBA path; when the
  operator has not published a record, or the record does not list `O`, it
  stays on the 3.2 profile. A trust-record fetch failure throws
  `JwsArtifactError` (`jws_key_unavailable`): it is never absence and never
  selects 3.2. A 404/410 from an operator that once served a record is an
  outage too, but the evaluator remembers that 200 only in process unless you
  give it durable `authorityHistory` (`createIdentity33StateStores`). Public,
  multi-replica and serverless verifiers must, as for grants.
- `verifyWebBotAuthJwsArtifact(token, origin, { typ, directory, revocation })`
  requires the `typ` the surface accepts, `alg` `EdDSA` and a `kid` equal to the
  key's JWK thumbprint, applies no `use`/`key_ops`/`adcp_use` check, and checks
  `O`'s revocation list. Purpose separation is by origin, so one key at `O` may
  sign every artifact `O` issues and `typ` tells them apart. `revocation` is
  required; pass `false` only if you check the returned `kid` yourself. It
  verifies key and signature only; the surface keeps its own claim checks.
- `verifyGovernanceAuthorization({ ..., webBotAuth: { trust, directory,
  revocation } })` applies the rule to governance contexts. Every other check is
  unchanged, including the `buyerIdentity` cross-check that `iss` is the buyer's
  governance agent; only the key source moves. `revocation` is required, and an
  origin that serves no list fails closed, since a governance context
  authorizes spend. Outages (trust record, directory, revocation list) set
  `retryable: true` on the failure. Without `webBotAuth` the verifier is 3.2
  only, as before.
- `verifyHistoricalGovernanceContext({ token, expectedIssuer, webBotAuth: {
  ..., archive } })` verifies a retained governance context for audit. A key
  rotated out of the directory is read from the governance key archive at `O`
  (`/.well-known/jwks-archive.json`, `GovernanceKeyArchiveResolver`), on the
  same `EdDSA` and thumbprint rules. A revoked key still verifies here: the
  result reports `revocation: 'revoked'` and the stored R9 detail (`reason`,
  `invalidity_date`) for the audit to weigh. Expiry, audience, replay and the
  request binding are not checked.

The SDK has no designated-task response or rights-attestation verifier of its
own; a verifier for either uses the two primitives above.

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
| [7894](https://github.com/adcontextprotocol/adcp/pull/7894) | `e59294701d733b0ea2a004a2f0c091c8eccdcaae` | WBA wire profile (`wba-profile.mdx`), profile selectors, directory and request vectors |
| [8121](https://github.com/adcontextprotocol/adcp/pull/8121) | `f5973ac0267b1b94d714c55fc4e3ad8fc2511350` | Origin identity and key-free trust v1 |
| [8162](https://github.com/adcontextprotocol/adcp/pull/8162) | `5c9914c5c382cc32f3d2ad7842942e548c414705` | Ratified identity, coexistence, revocation |
| [8168](https://github.com/adcontextprotocol/adcp/pull/8168) | `45540941dfd61e80ab8a463f780cb147c82a32f0` | Relationship and principal response arms |
| [8169](https://github.com/adcontextprotocol/adcp/pull/8169) | `3ce6a14d7afaa71fa78ddf2223ed0421e01205ae` | Grants, trust schema, grant_absent |
| [8170](https://github.com/adcontextprotocol/adcp/pull/8170) | `8d3591e70e9a717c7fdfb513360a796fba24ca9a` | Onboarding additions only; its old trust key fields are excluded |
| [8177](https://github.com/adcontextprotocol/adcp/pull/8177) | `b663f8e4235fe4276c73fb9bac6db491b2252bbf` | Reporting authentication omission |

The vectors in `test/fixtures/wba-profile/` are byte-identical to #7894 at that
head (see `PINNED.json`). Every vendored request and directory vector is
graded, and the interop harness (adcontextprotocol/adcp#8298) grades
`scenarios.json`.

Verification runs in Cloudflare's `http-message-sig` (signature base, coverage,
window, algorithm and cryptographic checks); the SDK adds the profile rules in
front of it (one signature, one covered `Signature-Agent` member, the nonce and
lifetime rules, key lookup by origin and thumbprint) and replay state behind it.
`verifyKeyDirectory` and `verifySignatureDirectory` now return promises.

Verifier outcomes follow DR-0023 and WBA §5.5/§6.10. `verifyWebBotAuth` needs
only key discovery and a replay store and returns the verified origins;
revocation, bindings and the origin-binding fence run afterwards in the
identity layer (`createIdentity33PrincipalResolver({ lifecycle, revocation })`),
so verification can run in a CDN or middleware in front of the AdCP server.

- Signature-path errors are WBA statuses and headers only: 400 when
  `Signature`, `Signature-Input` or `Signature-Agent` does not parse as a
  Structured Field; 403 with `Accept-Signature` for every other signature or
  profile failure (a wrongly typed parameter, a short nonce, an uncovered or
  extra `Signature-Agent` member); 429 with `Accept-Signature` carrying a fresh
  `nonce` for a reused signature or nonce. `Accept-Signature` names the label,
  the required components and `created;expires;nonce;keyid;alg;tag`. Any AdCP
  body is the generic authentication error (`AUTH_INVALID`); the specific
  reason is logged, never sent. A 429 for local load shedding (directory fetch
  limiter, replay-store `rate_abuse`) carries `Retry-After` instead.
- Every signed request carries `created`, `expires` (at most 300 seconds
  later), `keyid`, `alg` (`ed25519`) and a `nonce` of 64
  bytes, unpadded Base64URL or canonical padded Base64 (Cloudflare's default).
  The former 16-byte floor is gone: a shorter nonce is a 403. Replay state is
  keyed on the nonce bytes, so the two encodings of one nonce collide.
- `replayStatus` is deprecated and has no effect: a replay is always 429.
- An unsigned request to an operation in `required_for`, from a caller with no
  other accepted credential, is answered by what the verifier advertises in
  `request_signing.profiles`: `['web-bot-auth']` alone gets 403 with
  `Accept-Signature`; alongside `adcp/request-signing/v1` the AdCP RFC 9421 401
  `request_signature_required` also carries `Accept-Signature`. Both
  `createAdcpServer({ signedRequests: { webBotAuth } })` and
  `requireSignatureWhenPresent(verifySignatureAsAuthenticator({ webBotAuth }), ...)`
  apply this; a valid fallback credential still satisfies `required_for`.
- A key-directory fetch failure (transport error or any non-200, 404/410/5xx
  included) is a discovery failure. It never evicts a cached, unexpired
  directory, which keeps verifying. Without one the request is unverified and
  answered 403 with `Accept-Signature` (the SDK's default unverified-request
  policy). A fetched directory without the key is a signature failure.
- Key directories must be signed and served as
  `application/http-message-signatures-directory+json`; a plain JWKS is a
  discovery failure. `requireSignedDirectories` and
  `maxUnsignedDirectoryAgeSeconds` are deprecated and have no effect.
- A revoked key is 403 with the generic authentication error and no
  `Accept-Signature`: the signer must stop using that key. Revocation status
  `unknown` (stale past grace) leaves the identity unverified (403 with
  `Accept-Signature`). An origin that serves no revocation list (`absent`) is
  identity-established and cannot be bound for spend.
- Replay-store and revocation-history-store failures are infrastructure
  outages, raised as `WebBotAuthUnavailableError`. The server integrations
  answer them at the application layer with 503 `SERVICE_UNAVAILABLE` and
  `Retry-After`, never as a signature outcome.
- `webBotAuth.isRevoked`, `requireFreshRevocation` and `deferAuthorizationErrors`
  are deprecated. A server needs either a revocation-aware principal resolver or
  the deprecated `isRevoked`, and the webhook receiver either `revocation` or
  `isRevoked`. The deprecated path cannot express "established but not
  bindable", so it refuses an origin that serves no list (unverified).
- Clients act on the HTTP status and `Accept-Signature`, not the generic body:
  re-sign on 403 with `Accept-Signature`, stop using the key on 403 without it,
  back off on 429 or 503.
- `@target-uri` and `@authority` are taken from the target URI as received
  (RFC 9421 §2.2.2), never canonicalized; canonical origins identify the signer
  only. Web Bot Auth is Ed25519 only, and it also works on Cloudflare workerd.
  `test/fixtures/wba-interop/` holds fixtures verified in both directions against
  Cloudflare's `web-bot-auth`; they already used signed directories and are
  unchanged.
#7894 drops the governance-token checks and the `governance/` vectors from the
WBA profile. Governance moves to the AdCP layer under a separate R4 erratum
(adcontextprotocol/adcp#8299), which moves JWS artifacts, governance included,
to the identity's WBA key directory in 3.3; see [JWS artifacts](#jws-artifacts).
The buyer default onboarding field is `profiles.adcp.onboarding`, matching the
schema; the design's `record_profiles` wording names the schema definition.

Process-local authority history is bounded and never evicts remembered operators. Public deployments must supply `authorityHistory` from the shared state stores so history survives restarts and cache eviction. See [Public deployment limits](#public-deployment-limits) for admission and legacy-fallback behavior.

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

### Public deployment limits

- **Durable authority history is required for public deployments.** Without
  `authorityHistory`, the trust evaluator remembers which operators have served
  a trust record only in process memory. Nothing is evicted, so no operator's
  legacy `authorized_operators[]` fallback changes because of others, but the
  memory is bounded: `maxEntries` (default 1,000) in total, at most half of
  that (`maxPrivateAuthoritativeOperators`) for PSL PRIVATE-section names, and
  `maxAuthoritativeOperatorsPerPrivateSuffix` (default 32) per hosting provider
  (the provider's ICANN registrable domain, so every `*.vercel.app`,
  `*.s3.<region>.amazonaws.com` or `*.<project>.platformsh.site` operator
  shares one budget). An operator over budget cannot have its trust record
  accepted in that process: 32 subdomains under one provider block later operators on that
  provider, and a full `maxEntries` refuses every new trust record publisher.
  When an operator fits its budget, a history slot is reserved on any 200,
  before the body is validated, so a removed or invalid record still prevents
  a legacy downgrade for that remembered operator. An operator refused for
  lack of budget is not remembered: its trust record remains unavailable,
  but a later 404/410 is treated as absence and may invoke explicit legacy
  authorization, as after a process restart. With durable `authorityHistory`,
  every 200 is recorded, the in-memory set is only a cache, and none of these
  admission limits refuse records.
- **The unbound revocation pool can fill.** With the default CAS limits
  (100,000 keys per pool, 16,384 per operator), about seven registrable domains,
  including free PSL PRIVATE-section names, can exhaust the unbound pool. New
  unbound origins with revoked keys then fail closed with `SERVICE_UNAVAILABLE`
  until capacity is raised; the bound pool is unaffected.
- **Delisted origins have no exception.** A bound origin whose operator
  delists it is identity-established for every request, including polling and
  cancelling tasks it created while it was listed.
- **Duplicate structured-field keys are rejected.** Signature-Input,
  Signature and Signature-Agent with a duplicated dictionary member or a
  duplicated parameter (for example `created=1;created=2`) are malformed: 400
  under Web Bot Auth, `request_signature_header_malformed` under RFC 9421. RFC
  8941 parsers keep the last value, which other implementations may not.
- **`createExpressVerifier` does not implement Web Bot Auth.** It answers a
  request carrying `Signature-Agent` or the `web-bot-auth` tag with 403 (no
  challenge) instead of verifying it under RFC 9421. Use `createAdcpServer`
  `signedRequests.webBotAuth` or `verifySignatureAsAuthenticator({ webBotAuth })`.
