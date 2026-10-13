# AdCP 3.3 agent identity (experimental)

AdCP 3.3 adds a second way for agents to sign and be identified: the
[Web Bot Auth](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/00/)
(WBA) profile. Identity is the signer's canonical origin, keys live in that
origin's key directory, and no capabilities call is needed. The operator's
`trust.json` attests roles and grants and is evaluated only at binding,
grants, and `open` onboarding, never on the signature path. The work is
tracked in [adcp-client#3233](https://github.com/adcontextprotocol/adcp-client/issues/3233);
the design is the spec's `specs/agent-identity-3-3.md` and DR-0023 / DR-0025.

Everything on this page is **experimental and opt-in**:

- The wire pin stays AdCP 3.2.x. Nothing advertises 3.3.
- The RFC 9421 profile (`adcp/request-signing/v1`) keeps working unchanged
  through 3.x. It is deprecated in 3.3 and removed in 4.0; RFC 9421-only
  signing and verifier configuration emit a one-time `DeprecationWarning`
  (`ADCP_RFC9421_SIGNING_PROFILE`, `ADCP_RFC9421_VERIFICATION_PROFILE`).
- No signer emits `Signature-Agent` unless you select the WBA profile, and
  automatic signing then requires the seller to list `web-bot-auth` in
  `request_signing.profiles`. Some verifiers (the Go SDK today) reject extra
  covered components, so keep the opt-in until every counterparty tolerates it.
- JWS document signing (governance `iss`, designated-task response signing,
  rights attestations) stays on the RFC 9421 chain. AdCP 3.4 moves it.
- The WBA wire rules and vectors are pinned to adcp#7894 at
  `656bd080` (`test/fixtures/wba-profile-vectors`). The preview schemas
  (trust.json v1, onboarding posture, principal relationship) are pinned to
  draft commits in `schemas/identity-preview/UPSTREAM.json`, byte-identical
  to the Python SDK's preview (adcp-client-python#1502). Regenerate types with
  `npx tsx scripts/generate-identity-preview.ts`; verify the vendored copies
  with `--verify-upstream <path to adcp checkout>`.

## Buyer: publish keys and sign

Give each agent its own HTTPS origin (one agent per origin; a governance
agent is its own agent). Generate a key and publish the signed directory:

```bash
npx @adcp/sdk signing generate-key --profile web-bot-auth --private-out wba.pem --public-out wba.json
npx @adcp/sdk signing key-directory --origin https://buyer.agency.com --key wba.pem --out-dir ./public
```

Serve `./public/http-message-signatures-directory` byte for byte at
`https://buyer.agency.com/.well-known/http-message-signatures-directory`
with the headers in `http-message-signatures-directory.headers.json`.
Each key signs the response once, covering `"@authority";req` and
`content-digest` (WBA Appendix B.1). The signatures expire (one day by
default): run the same command on a schedule. It re-signs only when the
current directory is within `--renew-before` seconds of expiry (default one
hour), so a cron job is safe. Publish a new key before signing with it;
verifiers cache directories for at most five minutes.

The same is available as library calls from `@adcp/sdk/signing/client`:

```ts
import { signKeyDirectory, keyDirectoryNeedsRenewal } from '@adcp/sdk/signing/client';

const directory = signKeyDirectory({ agentOrigin: 'https://buyer.agency.com', privateKeys: [pem] });
// serve directory.body with directory.headers; re-sign before directory.expires
```

List the origin in the operator's `trust.json` with the role `adcp:buying`,
and validate what you publish (no keys in agent entries, one agent per
origin, every agent under the operator's registrable domain):

```bash
npx @adcp/sdk signing trust-json validate trust.json --operator-domain agency.com
```

Then opt the agent config into the profile. `kid` must be the key's RFC 7638
thumbprint (printed by `generate-key`), and `agent_url`'s origin is the
identity named in `Signature-Agent`:

```ts
const agent = {
  id: 'seller',
  agent_uri: 'https://seller.example.com/mcp',
  protocol: 'mcp',
  request_signing: {
    profile: 'web-bot-auth',
    kid: '<thumbprint>',
    alg: 'ed25519',
    private_key: privateJwk,
    agent_url: 'https://buyer.agency.com',
  },
};
```

Signed requests cover `@method`, `@target-uri`, `@authority`, the
`Signature-Agent` member, and for a body `content-type` and `content-digest`,
with `tag="web-bot-auth"`, a 256-bit nonce, `created`/`expires` (300 s), and
the thumbprint `keyid`. When the seller does not list `web-bot-auth` in
`request_signing.profiles`, the client throws before sending instead of
downgrading. Provider (KMS) configs work the same way; the provider's
`keyid` must be the thumbprint. For a hand-rolled transport, use
`signWebBotAuthRequest` / `signWebBotAuthRequestAsync`.

## Seller: verify, establish, bind

```ts
import {
  OriginBindings,
  OriginRevocationChecker,
  TrustRecordEvaluator,
  WebBotAuthKeyDirectoryResolver,
} from '@adcp/sdk/signing/server';

const keys = new WebBotAuthKeyDirectoryResolver({ legacy: existingRfc9421Jwks });
const bindings = new OriginBindings(); // one process; supply a durable OriginBindingStore in production
const trustRecords = new TrustRecordEvaluator({ pollingIntervalSeconds: 60 });

createAdcpServer({
  // ...
  signedRequests: {
    jwks: existingRfc9421Jwks,
    replayStore, // shared store for several replicas
    revocationStore,
    webBotAuth: { keys, bindings, trustRecords, revocation: new OriginRevocationChecker(keys) },
  },
});
```

The same option exists on `createExpressVerifier({ webBotAuth })`, and
`verifyWebBotAuthRequest` is the standalone verifier.

- **Profile selection.** A request carrying `Signature-Agent` or the
  `web-bot-auth` tag is verified under WBA only. A failure never falls back
  to the RFC 9421 profile, and an uncovered `Signature-Agent` is never
  attributed. Without `webBotAuth`, behavior is unchanged: a WBA signature
  fails the RFC 9421 tag check.
- **Keys.** `WebBotAuthKeyDirectoryResolver` resolves `(origin, thumbprint)`
  from the covered `Signature-Agent` origin's signed directory: HTTPS,
  resolved-address checks, no redirects, 256 KiB, 10 s, a five-minute
  positive cache bounded by the signatures' `expires`, a 60 s negative cache,
  and per-origin coalescing. It never calls capabilities or reads brand.json
  or trust.json. The verifier itself checks that the resolved key came from
  the named origin, so a resolver that looks keys up by `kid` alone cannot
  attribute a foreign key. `legacy` handles context-free RFC 9421 lookups on
  the same endpoint and is never a fallback for a failed WBA discovery.
- **Checks.** Every `web-bot-auth` signature must verify; a relay must cover
  the earlier labels' `signature-agent`, `signature-input`, and `signature`
  members and every component they cover. Nonces are required (at least 128
  bits) and claimed per identity origin in the replay store, so key rotation
  cannot replay. Duplicate dictionary members or parameters, repeated
  signature header lines, and non-strict JSON bodies are rejected.
- **Errors.** Failures answer WBA statuses: `400` (headers do not parse),
  `403` with `Accept-Signature` (sign again; a replay gets a fresh nonce), and
  `429`. The body is the generic `AUTH_INVALID` / `RATE_LIMITED` error with
  no signature-specific detail. `request_signature_*` codes stay with the
  RFC 9421 profile.
- **Revocation.** `OriginRevocationChecker` reads
  `https://O/.well-known/governance-revocations.json`
  (`adcp-gov-revocation+jws`, compact or JSON serialization) signed with a key
  from O's directory, polls on `next_update` (60 s floor, 30 min ceiling),
  fails closed past `next_update + 4×interval`, refuses rollback to an older
  list, keeps every revoked key, and keeps the most severe
  `revocation_details` entry per key (`keyCompromise`, earliest
  `invalidity_date`). `exposes(origin, kid, receivedAt)` answers R9's
  "suspect request" question using seller receipt time. Admission is bounded
  (256 origins, 8 per operator); failed first discoveries hold only a 60 s
  negative entry. A revoked key gets an AdCP authorization error
  (`PERMISSION_DENIED`, no `Accept-Signature`). Revocation alone never
  unwinds committed buys. Persist revocation history across restarts in a
  durable checker.
- **Identity-established.** A verified origin with no binding gets no
  credential: `BuyerAgentRegistry` resolves no agent for it, even one that
  shares its URL, and it may only call `webBotAuth.unboundFor` (default
  `get_adcp_capabilities`, `get_principal`). Match that to your anonymous
  surface, and add `sync_principal` only with an explicit `open` policy.
  `BuyerAgentRegistry.signingOnly/mixed({ onIdentityEstablished })` (or
  `webBotAuth.onIdentityEstablished`) receives each such origin, for example
  to queue one-click approval; rate-limit per operator domain.
- **Binding.** Bind only after the operator's record lists the origin with
  the required role:

  ```ts
  await trustRecords.bind(verifiedSigner, { principalId: 'principal_123', bindings });
  // existing RFC 9421 principal: { existingRfc9421Principal: true, migrationApproved: true }
  ```

  An origin binds to one principal and is never rebound. A bound origin
  authenticates as that principal (`authInfo.clientId`, and an `http_sig`
  credential with `profile: 'web-bot-auth'` and `principal_id`) while
  `trustRecords` still lists it with `webBotAuth.bindingRole` (default
  `adcp:buying`), re-evaluated within the polling interval. Delisting removes
  authority but not the binding, and a bound origin is refused on the RFC
  9421 profile (no downgrade). Persist bindings in your registry.

## Trust records and grants

`TrustRecordEvaluator` derives `https://{eTLD+1}/.well-known/trust.json`
from the pinned ICANN+PRIVATE PSL snapshot (IP literals and public suffixes
have no record), fetches under the SSRF rules with a 2 MiB cap and no
redirects, parses strictly (duplicate keys rejected, depth 32), follows one
`authoritative_location` hop whose target cannot point again, validates
against the pinned schema while preserving unknown onboarding requirement
kinds for readers, and caches no longer than the polling interval. The
operator is always the evaluated origin's registrable domain, never a value
inside the document. Fetch failures fail closed and are cached for 60 s. A
200 permanently marks the host as published for the evaluator's lifetime.
`isPrivateSuffixOperator(origin)` flags PRIVATE-section operators, which are
sandbox-only under `open` onboarding.

Grants (DR-0025) are evaluated by `TrustGrantEvaluator` and wired into the
decisioning runtime with `accounts.trustGrants`:

```ts
import { createTrustGrantGate } from '@adcp/sdk/server';
import { TrustGrantEvaluator } from '@adcp/sdk/signing/server';

accounts: {
  resolve, upsert,
  trustGrants: createTrustGrantGate({
    evaluator: new TrustGrantEvaluator(trustRecords, {
      legacyAuthorization: async claim => brandJsonAuthorizes(claim), // brand.json while no trust.json
    }),
  }),
},
```

- The brand's record authorizes. Authority is implicit when
  `account.operator`, the brand, and the signer's operator share a registrable
  domain. Otherwise a chain must reach the signer's operator with
  `account.operator` on it: the brand grants the signer's operator (who is
  `account.operator`), or the brand grants `account.operator`, whose own
  record grants the signer's operator. No third link is followed.
- Every link must cover the scope (default `adcp:media_buying`), brand,
  countries, agent narrowing (by canonical origin), and validity window;
  effective expiry is the earliest `valid_until`. `exclusive_grants: true`
  makes the record exhaustive for the scopes it names; otherwise
  `sellerAuthorization` (your onboarding records, never brand.json) decides.
- `legacyAuthorization` (brand.json `authorized_operators`) runs only while
  the brand has never served trust.json and its fetch returns 404/410. A 200
  disables it; fetch failures never reach it. A WBA signer's authority always
  requires its operator's role entry.
- The gate checks every natural-key `sync_accounts` declaration before any
  upsert, and re-checks the resolved account on account-scoped calls
  (`claimForAccount` defaults to the account's `brand` and `operator`).
  Operations outside media buying need an explicit scope. A missing grant is
  `PERMISSION_DENIED` with `{ scope: "agent", reason: "grant_absent" }` for an
  established agent, and a bare `PERMISSION_DENIED` otherwise (oracle clamp).
  No account is created and no status changes.

## Types

Draft types are exported from `@adcp/sdk/signing/server` and as the
`ExperimentalIdentity` namespace from `@adcp/sdk/types`: `TrustRecord`,
`TrustDocument`, `TrustRecordAgent`, `TrustRecordGrant`, `AgentOnboarding`
(`account.agent_onboarding`), `AgentOnboardingTier`,
`AgentOnboardingRequirement`, `AgentOnboardingMode`,
`AgentOnboardingRequirementKind`, `BuyerOnboardingPosture`,
`BuyerOnboardingMode`, `PrincipalRelationship` (`get_principal`
`relationship`), `ExperimentalPrincipalChangedReason`
(`relationship_changed`, `relationship_expiring`), `GrantAbsentDetails`,
`RevocationDetails`, and the `profiles` additions on `request_signing` /
`webhook_signing`. Validate values against the pinned drafts with
`identityPreviewSchemaErrors(value, schemaPath)`.

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
JWS issuers, and path-mounted agents. The future WBA profile permits one agent
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

The WBA verifier enforces the verified origin itself, independently of
custom wrapper forwarding, before attributing identity or accepting keys.

## Not yet included

- Server-side emission of `get_principal.relationship` and the new
  `principal.changed` reasons: the pinned 3.2 response schema closes the
  `unconfigured` result, so strict response validation would reject them
  until the 3.3 schema bundle is adopted. Types are available now.
- WBA-signed webhooks (`signing_profile: web-bot-auth`): the verifier is
  profile-generic, but webhook emission and registration still use the
  AdCP webhook profile.
- The house-record lookup for brands with a house portfolio, P7 grant-chain
  and trust-record conformance vectors, and the final 3.3 schema bundle.

## Rollback

Roll back opt-in signing only for origins no seller has bound. A bound
origin is refused on the RFC 9421 profile, so moving it back requires the
seller to migrate the principal explicitly.
