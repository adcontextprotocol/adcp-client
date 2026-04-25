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

`replayStore` and `revocationStore` default to in-memory implementations — fine for single-process deployments. Replace with a shared store (Redis-backed, etc.) for horizontally scaled fleets so replay detection works across instances.

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
