# Request Signing (RFC 9421)

AdCP 3.0 supports [HTTP Message Signatures (RFC 9421)](https://www.rfc-editor.org/rfc/rfc9421) for cryptographic request authentication. A buyer signs outbound requests so the seller can verify who sent them and that the payload wasn't tampered with. A seller signs outbound webhooks so the buyer can verify authenticity.

Signing is **optional in AdCP 3.0** — sellers populate `request_signing.required_for` selectively during per-counterparty pilots. AdCP **4.0** (the next breaking-changes window) requires signed requests on **spend-committing operations** (`create_media_buy`, `acquire_*`, etc.). Agents that don't sign yet must still tolerate signature headers (`Signature`, `Signature-Input`, `Content-Digest`) on inbound requests without breaking.

## When You Need This

| You are a... | You need to... | Why |
|---|---|---|
| **Buyer** (calls seller tools) | Sign outbound requests | Sellers may require proof that the request came from you |
| **Buyer** (receives webhooks) | Verify inbound webhook signatures | Confirm the webhook came from the seller, not a spoofed source |
| **Seller** (receives tool calls) | Verify inbound request signatures | Confirm the buyer is who they claim to be |
| **Seller** (sends webhooks) | Sign outbound webhooks | Let buyers verify webhook authenticity |
| **Orchestrator** (proxies to sellers) | Sign outbound requests + verify inbound webhooks | You're the buyer from the seller's perspective |

## Concepts

### Signature Coverage

The AdCP signing profile always covers:

- `@method` — HTTP method (POST)
- `@target-uri` — full request URL
- `@authority` — host header
- `content-type` — media type (application/json)

`content-digest` (SHA-256 or SHA-512 hash of the request body) is covered **conditionally**, controlled by the seller's `covers_content_digest` capability:

- `'required'` — signers MUST cover `content-digest`. Body-unbound signatures rejected with `request_signature_components_incomplete`. **Recommended for spend-committing operations** in production.
- `'either'` (default) — signer chooses per-request; verifier accepts both forms.
- `'forbidden'` — signers MUST NOT cover `content-digest`. Opt-out for legacy infrastructure that can't preserve body bytes.

If any covered component changes after signing, verification fails.

### Key Separation

Every agent needs **separate keys per purpose**:

- `adcp_use: "request-signing"` — for signing outbound tool calls
- `adcp_use: "webhook-signing"` — for signing outbound webhooks

Reusing a key across purposes is forbidden by the spec. Each key has a unique `kid` (key ID) that verifiers use to look it up.

### Discovery Chain

Verifiers find your public key through a three-step chain:

```
Your domain (e.g., agent.example.com)
  -> /.well-known/brand.json           # brand manifest with agent declarations
     -> agents[].jwks_uri              # pointer to your key store
        -> /.well-known/jwks.json      # JSON Web Key Set with public keys
```

`@adcp/client` provides `BrandJsonJwksResolver` which handles this entire chain automatically, with caching and refresh.

## Step 1: Generate a Signing Key

### CLI (recommended)

```bash
adcp signing generate-key --alg ed25519 --kid my-agent-2026 \
  --private-out ./private.jwk --public-out ./public-jwks.json
```

This generates an Ed25519 keypair and writes:
- `private.jwk` — the private key (JWK with `d` field). Keep this secret.
- `public-jwks.json` — the public key in JWKS format. Publish this.

### Programmatic

```typescript
import { generateKeyPair, exportJWK } from 'jose';

const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
const publicJwk = await exportJWK(publicKey);
const privateJwk = await exportJWK(privateKey);

// Tag with metadata
const kid = 'my-agent-2026';
publicJwk.kid = kid;
publicJwk.use = 'sig';
publicJwk.key_ops = ['verify'];
```

### Supported Algorithms

| Algorithm | `alg` value | Key type | Notes |
|---|---|---|---|
| Ed25519 | `ed25519` | `OKP` / `Ed25519` | Preferred. Fast, small signatures. |
| ECDSA P-256 | `ecdsa-p256-sha256` | `EC` / `P-256` | Widely supported. GCP KMS recommended. |

### Storing the Private Key

The private key must be available to your application at runtime. Options:

- **Environment variable**: `ADCP_SIGNING_PRIVATE_KEY='{"kid":"...","kty":"OKP",...}'`
- **Secret manager** (GCP Secret Manager, AWS Secrets Manager, etc.): Load at boot, keep in memory for the process lifetime
- **File**: For development only. Never commit to version control.

## Step 2: Publish Your Public Keys

### JWKS Endpoint

Serve a JSON Web Key Set at a stable HTTPS URL:

```
GET https://agent.example.com/.well-known/jwks.json
```

```json
{
  "keys": [
    {
      "kid": "my-agent-2026",
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "<base64url-encoded-public-key>",
      "use": "sig",
      "key_ops": ["verify"],
      "adcp_use": "request-signing"
    }
  ]
}
```

Only public keys go here — no `d` field. Set `Cache-Control: max-age=3600` or similar.

If you serve both request-signing and webhook-signing keys, include both in the same JWKS with different `kid` values and `adcp_use` tags.

### brand.json

Serve at `/.well-known/brand.json` on your brand domain. This is the entry point for key discovery:

```json
{
  "name": "My Company",
  "domain": "example.com",
  "agents": [
    {
      "type": "sales",
      "id": "acme_sales",
      "url": "https://agent.example.com",
      "jwks_uri": "https://agent.example.com/.well-known/jwks.json"
    }
  ]
}
```

Required per agent: `type`, `id`, `url`. The `type` enum is `brand | rights | measurement | governance | creative | sales | buying | signals` — pick the one matching this agent's role. `jwks_uri` is optional but recommended; verifiers default to `/.well-known/jwks.json` on the origin of `url` when absent.

## Step 3: Sign Outbound Requests (Buyer / Orchestrator)

### Wrapping fetch

`createSigningFetch` wraps any `fetch`-compatible function to sign outbound requests:

```typescript
import { createSigningFetch } from '@adcp/client/signing';

const privateJwk = JSON.parse(process.env.ADCP_SIGNING_PRIVATE_KEY);

const signingFetch = createSigningFetch(fetch, {
  keyid: 'my-agent-2026',
  alg: 'ed25519',
  privateKey: privateJwk,
});

// Use signingFetch anywhere you'd use fetch.
// Signature, Signature-Input, and Content-Digest headers are added automatically.
await signingFetch('https://seller.example.com/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
```

### Agent-aware signing (recommended)

For the common single-seller case, `createAgentSignedFetch` bundles capability detection, capability caching, and signing into one call. It only signs when the target seller advertises `signed-requests` support — so the `get_adcp_capabilities` priming call itself is always unsigned, as the spec requires.

```typescript
import { createAgentSignedFetch } from '@adcp/client/signing';

const signedFetch = createAgentSignedFetch({
  signing: {
    kid: 'my-agent-2026',
    alg: 'ed25519',
    private_key: privateJwk,
    agent_url: 'https://agent.example.com',
  },
  sellerAgentUri: 'https://seller.example.com',
});

await signedFetch('https://seller.example.com/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
```

For multi-seller adapters, construct one preset per seller, or drop down to `buildAgentSigningFetch` directly with a request-dispatching `getCapability` callback:

```typescript
import { buildAgentSigningFetch, CapabilityCache } from '@adcp/client/signing/client';

const capabilityCache = new CapabilityCache();
const signingFetch = buildAgentSigningFetch({
  signing: { kid: 'my-agent-2026', alg: 'ed25519', private_key: privateJwk, agent_url: 'https://agent.example.com' },
  getCapability: () => capabilityCache.get('https://seller.example.com'),
});
```

## Step 3.5: Production Key Storage — KMS / HSM / Vault

Holding a private JWK in process memory is fine for development and testing but it's not where you want production signing keys to live. A process compromise leaks the signing key, and the only remedy is rotation across every counterparty that's cached your public key (within their TTL). The AdCP spec recommends storing keys in a managed key store (HSM or KMS); the SDK supports this directly via the `SigningProvider` interface.

### When to switch

- **Stay in-process** for local development, integration tests, and pilot deployments where the signed traffic isn't financially significant.
- **Move to KMS** before going live with mutating operations — `create_media_buy`, `acquire_*`, `sync_audiences`, anything that commits spend or changes shared state. RFC 9421 signing is recommended at AdCP 3.0 and **required for mutating ops at 3.1+**, so the threshold to care arrives soon.

### The interface

```typescript
import type { SigningProvider } from '@adcp/client/signing';

export interface SigningProvider {
  sign(payload: Uint8Array): Promise<Uint8Array>;
  readonly keyid: string;
  readonly algorithm: 'ed25519' | 'ecdsa-p256-sha256';
  readonly fingerprint: string;
}
```

`sign(payload)` receives the canonical RFC 9421 signature base; the provider returns wire-format signature bytes (64-byte raw for Ed25519, 64-byte `r‖s` IEEE P1363 for ECDSA-P256 — **not** DER). `keyid` flows into `Signature-Input`; `algorithm` is the wire string; `fingerprint` is a stable opaque token (e.g., `projects/.../cryptoKeyVersions/N`) used by the SDK for transport-cache isolation. The SDK defensively hashes the fingerprint, so a buggy adapter that returns a low-entropy string can't collapse multi-tenant cache isolation.

### Wiring a provider into your config

`AgentRequestSigningConfig` is a discriminated union on `kind`. Existing literals continue to work — `kind` defaults to `'inline'` so adding the field isn't required. Switch to a KMS-backed signer by replacing the `private_key` block with `{ kind: 'provider', provider }`:

```typescript
import { createAgentSignedFetch } from '@adcp/client/signing';
import { createGcpKmsSigningProvider } from './gcp-kms-signing-provider'; // see examples/

const provider = await createGcpKmsSigningProvider({
  versionName: process.env.ADCP_KMS_VERSION!,
  kid: 'my-agent-2026',
  algorithm: 'ed25519',
  client: kmsClient,
});

const signedFetch = createAgentSignedFetch({
  signing: {
    kind: 'provider',
    provider,
    agent_url: 'https://agent.example.com',
  },
  sellerAgentUri: 'https://seller.example.com',
});
```

The wire format is unchanged. Sellers can't tell the difference between a request signed in-process and one signed by KMS — the SDK's canonicalization is shared between the sync (in-process) and async (provider) paths via the same helpers.

### GCP KMS reference adapter

A complete reference lives at [`examples/gcp-kms-signing-provider.ts`](https://github.com/adcontextprotocol/adcp-client/blob/main/examples/gcp-kms-signing-provider.ts). The adapter handles two GCP-specific quirks:

- **DER → IEEE P1363 conversion** for ECDSA. GCP KMS returns ECDSA signatures DER-encoded; AdCP and RFC 9421 §3.3.1 want raw `r‖s`. The SDK exports `derEcdsaToP1363(der, componentLen)` so any KMS adapter (GCP, AWS for ECDSA, Azure) can normalize at the boundary.
- **Pre-flight algorithm check.** The adapter calls `getPublicKey` once at construction and throws `SigningProviderAlgorithmMismatchError` if the declared `algorithm` doesn't match the underlying key's algorithm. Without this, a misconfigured key produces signatures the verifier rejects with a generic `request_signature_invalid` — useless for diagnosis. Pre-flight failure is loud and specific.

The published `@adcp/client` package keeps `@google-cloud/kms` out of its dependencies — copy the example into your project and `npm i @google-cloud/kms` yourself. Mirror the same shape for AWS KMS (`@aws-sdk/client-kms`), Azure Key Vault, or HashiCorp Vault Transit.

### Setting up GCP KMS — the parts that actually matter

1. **Key purpose.** Asymmetric sign. Algorithm: `EC_SIGN_P256_SHA256` is the well-trodden default; `EC_SIGN_ED25519` is GA but availability varies by region — verify before pinning.
2. **Protection level.** Software is fine for AdCP — keeps the private scalar inside Google's KMS service (your process never sees it). HSM (~10× cost) is only required if you have a regulatory mandate.
3. **IAM.** Grant `roles/cloudkms.signer` on the **key** (versions inherit the policy; per-version IAM isn't a knob GCP exposes). Treat the key as single-purpose — RFC 9421's `tag` parameter protects verifiers, not signers, so reusing the same KMS key across protocols creates a cross-protocol oracle. Bind IAM so only the AdCP signing path can call `asymmetricSign`.
4. **JWKS publication.** Pull the public key (`gcloud kms keys versions get-public-key 1 --output-file=pub.pem`), convert PEM → JWK (the `jose` package's `importSPKI` + `exportJWK` is one line each), publish at your agent's `jwks_uri`. The `kid` you use in the `SigningProvider` must match what's published. Keep `kid` short and stable (e.g. `addie-2026-04`) — don't put the full GCP resource name on the wire; that's what `versionName` is for.
5. **Rotation.** GCP KMS asymmetric keys don't auto-rotate. Pin `versionName` to a specific `cryptoKeyVersions/N`, redeploy when you cut a new version. This is consistent with publishing both versions in your JWKS during the transition.

### Authentication when your runtime is outside GCP

If your agent runs on Cloud Run / GKE / Compute Engine, ADC handles auth automatically — `new KeyManagementServiceClient()` finds credentials via the metadata service.

If your agent runs **outside GCP** (Fly.io, Railway, AWS, your own VMs), you have two options, neither of them frictionless today:

- **Service-account JSON key + Fly secret.** Simplest path. Create a service account, grant it `roles/cloudkms.signer` on the key, generate a JSON key, set as a Fly secret (or equivalent), construct the client with explicit credentials. The signing key still lives in KMS (never in your process); only the access credential lives in your secret store. Rotate the SA key every ~90 days as hygiene. **Caveat:** GCP orgs commonly enforce `constraints/iam.disableServiceAccountKeyCreation`, which blocks this — you'll need a temporary org-policy exception (project owner can grant themselves `orgpolicy.policyAdmin` and toggle the constraint for the project; takes seconds with the right role).
- **Workload Identity Federation.** The right answer long-term, but requires the runtime to issue OIDC tokens GCP can trust. Fly currently issues Macaroons, not OIDC, so WIF doesn't drop in. Worth revisiting when Fly ships native OIDC.

For non-GCP runtimes that lack OIDC and where the org policy blocks SA keys, the operationally clean fallback is a **Cloud Run remote-signer sidecar** — a tiny GCP-hosted service that exposes `POST /sign`, runs as the signer SA (gets ADC for free), authenticates incoming calls via shared secret. Adds 30–100 ms per signed request; no SA key in the off-cloud secret store.

### Threat model upgrade — what you actually buy

| Compromise | In-process key | KMS-backed signer (any auth path) |
|---|---|---|
| Process memory dump | Signing key gone — full impersonation until JWKS rotates everywhere | Signing key untouched — only the auth credential leaks (revocable in seconds) |
| Recovery | Rotate the JWK + push to all counterparties + wait out their cache TTL | Revoke the SA key (or KMS access) — signing stops immediately, JWK unchanged |
| Auditability | Whatever your app logs | Cloud audit log: every `asymmetricSign` call, by identity, with version |

### Testing — `InMemorySigningProvider`

The SDK ships `InMemorySigningProvider` under a separate import path so production imports surface the KMS path first:

```typescript
import { InMemorySigningProvider } from '@adcp/client/signing/testing';

const provider = new InMemorySigningProvider({
  keyid: 'test-2026',
  algorithm: 'ed25519',
  privateKey: testJwk,
});
```

The constructor refuses to instantiate when `NODE_ENV=production` unless `ADCP_ALLOW_IN_MEMORY_SIGNER=1` is set explicitly — defense-in-depth so a copy-paste from a test file doesn't accidentally ship to prod. The gate is a self-discipline aid for the bundled implementation; the SDK can't enforce hygiene on third-party providers.

### Validating a signer before going live — `adcp grade signer`

Before pushing live signed traffic from a KMS-backed signer, exercise the full signing path through the SDK's verifier so misconfigurations surface as specific RFC 9421 error codes (the same codes a counterparty would reject with) rather than the generic `request_signature_invalid` you'd see in the seller's monitoring after the fact.

```bash
# KMS-backed signer via an HTTPS signing oracle (no private key handed to the CLI):
adcp grade signer https://addie.example.com \
  --signer-url https://signer.internal/sign \
  --signer-auth "Bearer ${SIGNER_TOKEN}" \
  --kid addie-2026-04 \
  --alg ed25519 \
  --jwks-url https://addie.example.com/.well-known/jwks.json
```

The grader produces a sample signed AdCP request through your signer, then verifies it against your published JWKS. PASS means a counterparty verifier will accept your signatures. FAIL produces a specific `error_code` and `step` matching the verifier-checklist semantics, so DER-vs-P1363 / kid-mismatch / wrong-key / algorithm-mismatch each surface as a distinct diagnostic.

The signing-oracle protocol is intentionally minimal — `POST {payload_b64, kid, alg}` returns `{signature_b64}` — so any KMS adapter can put a small handler in front of `provider.sign()` for grading without exposing the underlying KMS.

For local dev / non-KMS testing, `--key-file <jwk-path>` accepts an in-process JWK directly. Same grader, same report.

## Step 4: Verify Inbound Signatures (Seller)

### Express middleware

```typescript
import { createExpressVerifier, StaticJwksResolver } from '@adcp/client/signing';
import { mcpToolNameResolver } from '@adcp/client/server';

app.post(
  '/mcp',
  rawBodyMiddleware(),
  createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: 'required',
      required_for: ['create_media_buy', 'update_media_buy'],
    },
    jwks: new StaticJwksResolver(buyerPublicKeys),
    resolveOperation: mcpToolNameResolver,
  }),
  handler
);
```

`replayStore` and `revocationStore` default to in-memory implementations — fine for single-process deployments.

**For multi-instance verifier deployments, the in-memory default is a real gap.** Each process has its own cache; an attacker who captures a signed request can replay it against a sibling instance whose cache hasn't seen the nonce. The replay-protection invariant is "this `(keyid, scope, nonce)` tuple has not been seen before" — that has to hold across the fleet, not per-process. RFC 9421 expiry bounds the window to 5 minutes, but that's plenty of time for an in-flight replay. Use a shared backend.

The SDK ships `PostgresReplayStore` for this:

```typescript
import { Pool } from 'pg';
import { PostgresReplayStore, getReplayStoreMigration, sweepExpiredReplays } from '@adcp/client/signing/server';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(getReplayStoreMigration());                    // run once at boot

const replayStore = new PostgresReplayStore(pool);

// Postgres has no native TTL — schedule the sweeper somewhere to delete
// expired rows. Once a minute is fine for moderate traffic; tune down if
// the verifier sees thousands of signed requests per second.
setInterval(() => sweepExpiredReplays(pool).catch(console.error), 60_000);

app.use(createExpressVerifier({
  capability: { ... },
  jwks,
  replayStore,                                                  // <-- shared across instances
  resolveOperation: mcpToolNameResolver,
}));
```

The schema is one table with `(keyid, scope, nonce)` as the primary key plus indexes on `expires_at` and `(keyid, scope, expires_at)`. Lookups are O(log n) on the composite index; insert is one round-trip CTE that handles the replay/cap/insert decision atomically. The sweeper exists because Postgres has no native row-level TTL — it's a `DELETE FROM replay_cache WHERE expires_at <= now()` you call on a schedule. Other backends (Redis, KeyDB, anything supporting atomic insert-if-absent with TTL) can implement the `ReplayStore` interface the same way.

On successful verification, `req.verifiedSigner` contains `{ keyid, agent_url?, verified_at }`. On failure, the middleware returns `401` with `WWW-Authenticate: Signature error="<code>"`.

### Composing with bearer auth

`requireAuthenticatedOrSigned` bundles signature verification with credential fallback in one call: when signature headers are present, only signature auth runs (no bearer fallback — that prevents bypass attacks); when absent, the credential authenticator runs as normal; and `requiredFor` enforces the spec's `request_signature_required` 401 on mutating operations that arrive unsigned without other credentials.

```typescript
import { MUTATING_TASKS } from '@adcp/client';
import {
  serve,
  verifyApiKey,
  verifySignatureAsAuthenticator,
  requireAuthenticatedOrSigned,
  mcpToolNameResolver,
} from '@adcp/client/server';
import { BrandJsonJwksResolver } from '@adcp/client/signing/server';

serve(createAgent, {
  authenticate: requireAuthenticatedOrSigned({
    signature: verifySignatureAsAuthenticator({
      capability: { supported: true, required_for: ['create_media_buy'], covers_content_digest: 'either' },
      jwks: new BrandJsonJwksResolver(),
      resolveOperation: mcpToolNameResolver,
    }),
    fallback: verifyApiKey({ keys: { 'sk_live_abc': { principal: 'acct_42' } } }),
    requiredFor: ['create_media_buy', 'update_media_buy'],
    resolveOperation: mcpToolNameResolver,
  }),
});
```

Set `requiredFor` to the AdCP operations you want to gate behind signatures — start narrow during pilots, then widen. The spec stance for 3.0 is "empty by default; populate selectively per counterparty." 4.0 will require all spend-committing operations to be in this list. `MUTATING_TASKS` (exported from `@adcp/client`) is the full mutating set if you want to spread it as the upper bound: `requiredFor: [...MUTATING_TASKS]` — note that includes audit-class operations like `sync_audiences` and `report_usage` that 4.0's mandate does NOT cover, so it's stricter than the spec floor.

### JWKS resolution options

| Resolver | Use case |
|---|---|
| `StaticJwksResolver` | Fixed set of known buyer keys. Good for dev/testing. |
| `HttpsJwksResolver` | Fetches JWKS from a URL with caching and refresh. |
| `BrandJsonJwksResolver` | Full discovery chain: brand.json -> jwks_uri -> JWKS. Production recommended. |

## Step 5: Verify Inbound Webhooks (Buyer / Orchestrator)

When sellers send webhooks, verify the signature to confirm authenticity:

```typescript
import {
  verifyWebhookSignature,
  BrandJsonJwksResolver,
  InMemoryReplayStore,
} from '@adcp/client/signing/server';

const jwks = new BrandJsonJwksResolver();
const replayStore = new InMemoryReplayStore();

app.post('/webhook', async (req, res) => {
  try {
    await verifyWebhookSignature(req, { jwks, replayStore });
  } catch (err) {
    return res.status(401).json({ error: 'invalid webhook signature' });
  }

  // Process the verified webhook...
});
```

## Step 6: Sign Outbound Webhooks (Seller)

Configure `createAdcpServer` with a webhook signing key:

```typescript
serve(() => createAdcpServer({
  name: 'My Seller',
  version: '1.0.0',
  webhooks: {
    signerKey: {
      keyid: 'my-seller-webhook-2026',
      alg: 'ed25519',
      privateKey: webhookPrivateJwk,
    },
  },
  mediaBuy: { /* ... */ },
}));
```

The framework signs every outbound webhook automatically using the configured key.

## Step 7: Declare the Capability

If your seller agent verifies inbound signatures, declare `request_signing` in your capabilities so buyers know to sign:

```typescript
createAdcpServer({
  capabilities: {
    overrides: {
      request_signing: {
        supported: true,
        required_for: ['create_media_buy', 'update_media_buy'],
        supported_for: ['sync_creatives', 'sync_audiences'],
        covers_content_digest: 'required',
      },
    },
  },
  mediaBuy: { /* ... */ },
});
```

The capability key is `request_signing` (not `signed_requests`) — that's what `AdcpCapabilitiesOverrides` and the spec's `get_adcp_capabilities` response advertise. The wrong key is silently dropped, leaving the verifier wired up but invisible to buyers.

## Key Rotation

The JWKS endpoint supports multiple keys simultaneously, enabling zero-downtime rotation:

1. Generate a new keypair with a new `kid`
2. Add the new public key to JWKS (both old and new are published)
3. Update signing configuration to use the new private key
4. After 24-48 hours, remove the old public key from JWKS

## Testing

### Conformance vectors

The library ships 39 test vectors in `compliance/cache/3.0.0/test-vectors/request-signing/`:

- **12 positive vectors**: Valid signed requests your verifier must accept (non-4xx response)
- **27 negative vectors**: Invalid requests your verifier must reject with `401` and the correct error code

### Grading your verifier

```bash
adcp grade request-signing https://agent.example.com/mcp --auth-token $TOKEN
```

### Debugging a single vector

```bash
adcp signing verify-vector \
  --vector compliance/cache/3.0.0/test-vectors/request-signing/positive/001-basic-post.json
```

### Error codes

When verification fails, return `401` with `WWW-Authenticate: Signature error="<code>"`. These are the codes the conformance vectors at `compliance/cache/3.0.0/test-vectors/request-signing/negative/` exercise — they're a separate signature-error namespace surfaced via `WWW-Authenticate`, not entries in the AdCP `enums/error-code.json`:

| Code | Meaning |
|---|---|
| `request_signature_required` | Signature headers absent on an operation listed in `required_for` |
| `request_signature_invalid` | Signature doesn't verify against the public key |
| `request_signature_window_invalid` | `created` outside the acceptable freshness window |
| `request_signature_replayed` | (`keyid`, `nonce`) tuple was already used |
| `request_signature_key_revoked` | Key marked revoked in the revocation store |
| `request_signature_key_unknown` | `keyid` not found in JWKS |
| `request_signature_alg_not_allowed` | `alg` outside the AdCP-permitted set (`ed25519`, `ecdsa-p256-sha256`) |
| `request_signature_components_incomplete` | `covers_content_digest: 'required'` but `content-digest` missing from coverage |
| `request_signature_components_unexpected` | `covers_content_digest: 'forbidden'` but `content-digest` was covered anyway |
| `request_signature_digest_mismatch` | `content-digest` header doesn't match the body bytes |
| `request_signature_header_malformed` | `Signature` / `Signature-Input` parse error |
| `request_signature_key_purpose_invalid` | Key's `adcp_use` doesn't permit request signing |
| `request_signature_params_incomplete` | Missing required parameters (`created`, `nonce`, `tag`) |
| `request_signature_rate_abuse` | Same `keyid` exceeded the verifier's rate ceiling |
| `request_signature_tag_invalid` | `tag` parameter doesn't match the AdCP request-signing tag |

## Related

- [AdCP signing spec](https://adcontextprotocol.org/docs/building/implementation/security#signed-requests-transport-layer)
- [VALIDATE-YOUR-AGENT.md](./VALIDATE-YOUR-AGENT.md) — full compliance validation including signing
- [`examples/signals-agent.ts`](../../examples/signals-agent.ts) — agent example
- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) — HTTP Message Signatures specification
