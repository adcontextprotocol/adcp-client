# AdCP 3.3 agent identity foundations

The experimental identity rollout is tracked in
[adcp-client#3233](https://github.com/adcontextprotocol/adcp-client/issues/3233).
The SDK currently provides origin normalization and resolver request context
as preparation for that rollout. RFC 9421 signing and verification continue
to use capability-bound agent URL discovery and the AdCP 3.2 wire pin.

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
authorities and IPv6 zone identifiers are rejected. Producer inputs with IDN
U-labels normalize to Punycode A-labels. Wire comparers must separately reject
raw non-ASCII hostnames before comparing, as the existing `canonicalAgentUrl`
helper does.

The existing `canonicalizeOrigin` / `originsEqual` primitives and
`identity.key_origins` comparisons use this same authority validation. A
single trailing DNS root dot now compares equal to its dotless form;
malformed authorities that the URL parser previously repaired are rejected.

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
`BrandJsonJwksResolver` forwards the context through both lookup methods,
including after legacy onboarding has selected and pinned an agent URL.
When legacy brand configuration omits `agentUrl`, initial onboarding must
read the configured operator record to select an agent URL before it can
compare origin context. Subsequent lookups check the pinned origin. The
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
separate, and treat the origin as an unverified locator until signature
verification succeeds. On request verification, metadata remains necessary
to reject webhook-only fallback keys and expired operator delegations.

## Remaining rollout

The current RFC 9421 verifiers do not read or attribute `Signature-Agent`,
and these helpers do not enable a WBA discovery mode. The WBA signer,
profile selection, signed directory verification, origin revocation,
trust-record evaluation, principal binding, grants, onboarding and relationship
schemas, CLI publishing tools, and WBA conformance vectors remain tracked
by #3233. Those paths need explicit experimental configuration and the
upstream profile and schema changes; adding resolver context is not a
substitute for those checks.

The future verifier must enforce the verified origin itself, independently
of custom wrapper forwarding, before attributing identity or accepting keys.
