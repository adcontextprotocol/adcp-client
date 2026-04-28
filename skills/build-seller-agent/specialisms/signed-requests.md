# Specialism: signed-requests

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `signed-requests`.


Storyboard: `signed_requests`. Transport-layer security specialism — certifies that your agent correctly verifies incoming RFC 9421 HTTP Signatures on mutating AdCP operations.

**If you run this behind OAuth or combine it with idempotency,** also read [§ Composing OAuth, signing, and idempotency](#composing-oauth-signing-and-idempotency) for middleware mount order, 401 disambiguation (Bearer vs Signature challenge), and how the verified signing `keyid` threads into the idempotency principal.

The specialism yaml still carries `status: preview`, but the conformance grader shipped. Phases are `capability_discovery`, `positive_vectors`, `negative_vectors`. Test vectors live at `compliance/cache/latest/test-vectors/request-signing/`; the test kit is `test-kits/signed-requests-runner.yaml`.

**Grading model.** The runner constructs signed HTTP requests per each vector and sends them to your agent. Your verifier's responses are compared against the vector's `expected_outcome`:

- **Positive vectors** must produce a non-4xx response — the agent accepted the signed request.
- **Negative vectors** must produce `401` with `WWW-Authenticate: Signature error="<code>"`, where `<code>` matches the vector's `expected_outcome.error_code` byte-for-byte.

The `WWW-Authenticate` header is the grading surface — return the right error code there, not just any 401.

**Prerequisites.** Claim this specialism only if:

1. `get_adcp_capabilities` advertises `request_signing.supported: true` along with the full `VerifierCapability` (`required_for`, `supported_for`, `covers_content_digest`).
2. Your JWKS accepts the runner's test keypairs (`test-ed25519-2026`, `test-es256-2026`) as a registered test counterparty with `adcp_use: "request-signing"`.
3. For negative vectors `016` (replayed nonce), `017` (revoked key), `020` (per-keyid cap), your verifier is pre-configured per `signed-requests-runner.yaml` — the runner cannot set that state from outside. Missing prerequisites grade as **FAIL**, not SKIP.

**Use the SDK's server verifier.** Don't write signature parsing or canonicalization yourself — `@adcp/sdk/signing/server` ships the full pipeline. The canonical wiring lives in [§ Composing OAuth, signing, and idempotency](#composing-oauth-signing-and-idempotency) which feeds `verifyRequestSignature` through `serve({ preTransport })`; don't hand-roll an Express middleware chain alongside it. What you need that's specific to this specialism is the capability advertisement and the revocation-store pre-state:

**Auto-wiring via `createAdcpServer`.** When you're already using `createAdcpServer`, pass `signedRequests: { jwks, replayStore, revocationStore }` and add `'signed-requests'` to `capabilities.specialisms` — the framework builds the verifier preTransport for you and `serve()` auto-mounts it. `createAdcpServer` throws at startup when `signedRequests` is set without the specialism claim (buyers wouldn't sign), and logs a loud error in the other direction (leaving the legacy manual `serve({ preTransport })` path working). Keep `request_signing` in capabilities separately — it's still how buyers discover your `required_for` policy.

```typescript
createAdcpServer({
  // ...handlers...
  capabilities: {
    request_signing: capability,
    specialisms: ['signed-requests'],
  },
  signedRequests: {
    jwks,
    replayStore,
    revocationStore,
    // required_for defaults to every mutating AdCP tool (MUTATING_TASKS).
    // Narrow it to match the capability.required_for policy:
    required_for: capability.required_for,
    covers_content_digest: capability.covers_content_digest,
  },
});
```

```typescript
import { InMemoryRevocationStore, StaticJwksResolver, type VerifierCapability } from '@adcp/sdk/signing/server';

// Policy that ships in your get_adcp_capabilities response under capabilities.request_signing:
const capability: VerifierCapability = {
  supported: true,
  required_for: ['create_media_buy', 'update_media_buy', 'acquire_rights'],
  supported_for: ['sync_creatives', 'sync_audiences', 'sync_accounts'],
  covers_content_digest: 'required',
};

// JWKS takes an array of JWKs; each must carry its own `kid`:
const jwks = new StaticJwksResolver([
  { kid: 'test-ed25519-2026', kty: 'OKP', crv: 'Ed25519' /* x from test-vectors/request-signing/keys.json */ },
  { kid: 'test-es256-2026', kty: 'EC', crv: 'P-256' /* x, y */ },
  { kid: 'test-revoked-2026', kty: 'OKP', crv: 'Ed25519' /* x — present so parsing succeeds, revoked below */ },
]);

// Vector 017 requires `test-revoked-2026` to be pre-revoked before the runner sends its signed request.
// The in-memory store seeds from its constructor snapshot — no insert() method exists; load the set up front:
const revocationStore = new InMemoryRevocationStore({
  issuer: 'https://seller.example.com/mcp',
  updated: new Date().toISOString(),
  next_update: new Date(Date.now() + 24 * 3600_000).toISOString(),
  revoked_kids: ['test-revoked-2026'],
  revoked_jtis: [],
});

// Wire capability + jwks + stores into serve({ preTransport }) per §Composing.
```

**Advertise your policy in `get_adcp_capabilities`.** Put your `VerifierCapability` under `capabilities.request_signing`. Client SDKs fetch this on first call, cache it for 300s, and use it to decide whether to sign outbound calls. If you don't advertise, the grader skips you (and so do auto-signing clients). If you advertise without actually verifying, negative vectors will fail.

**Don't claim unless tested.** Before claiming, run the grader against a local instance that has the test kit pre-wired (`test-revoked-2026` revoked, per-keyid cap set to match the test kit):

```bash
npx tsx agent.ts &
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp signed_requests --json
```

Every negative vector must return the exact `expected_outcome.error_code` in `WWW-Authenticate: Signature error="<code>"`. A non-claiming agent is not graded against this specialism.

