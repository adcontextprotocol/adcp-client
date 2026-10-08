# Verifying Inbound Webhooks

This recipe is for buyers and orchestrators receiving AdCP webhooks from
seller agents. It covers the spec-current RFC 9421 profile and the legacy
HMAC profile that remains for older `push_notification_config.authentication`
registrations.

New integrations should use RFC 9421. The HMAC branch below is only for
operations that were explicitly registered with legacy
`push_notification_config.authentication`.

## Invariants

| Invariant | Requirement |
|---|---|
| Raw body | Verify the exact bytes received on the wire, before JSON parsing or re-serialization. |
| Per-agent isolation | Choose the expected sending agent from trusted state: operation ID, route segment, tenant table, or the outbound request you created. Do not let `keyid` choose the counterparty. |
| Replay protection | A `(keyid, target-uri, nonce)` accepted once must be rejected everywhere until it expires. Multi-replica deployments need a shared replay store. |
| Dual scheme | RFC 9421 and legacy HMAC are separate profiles. If one is present and fails, reject. Do not fall back to the other scheme after a failed verification. |

## Payload Anatomy

Delivery reporting webhooks are sent as a complete async webhook envelope. The
delivery report is the nested `result`, not the top-level POST body.

Full wire payload sent as the webhook POST body:

```json
{
  "idempotency_key": "whk_20260526_example_000031",
  "operation_id": "delivery_report_67_2026-04",
  "task_id": "delivery_report_67_2026-04_000031",
  "task_type": "media_buy_delivery",
  "status": "completed",
  "timestamp": "2026-05-26T09:00:44.582Z",
  "message": "Scheduled media buy delivery report available",
  "result": {
    "notification_type": "scheduled",
    "sequence_number": 31,
    "reporting_period": {
      "start": "2026-05-25T00:00:00Z",
      "end": "2026-05-25T23:59:00Z"
    },
    "currency": "USD",
    "media_buy_deliveries": []
  }
}
```

Inner delivery result only:

```json
{
  "notification_type": "scheduled",
  "sequence_number": 31,
  "reporting_period": {
    "start": "2026-05-25T00:00:00Z",
    "end": "2026-05-25T23:59:00Z"
  },
  "currency": "USD",
  "media_buy_deliveries": []
}
```

That inner object is valid delivery report content, but it is not valid as the
top-level webhook POST body. Receivers should reject it before dispatch because
it is missing the async transport fields.

Status fields have different scopes: top-level `status` is the async task or
webhook event status; nested `media_buy_deliveries[].status` is the media buy's
delivery status. `idempotency_key` is unique per webhook event and stable across
retries of that event. Signatures cover the exact raw JSON bytes being sent, so
verify before parsing or re-serializing.

## Recommended RFC 9421 Setup

Create one verifier per expected sending agent. The resolver is bound to that
agent's canonical URL and protocol, so a webhook for one seller cannot be
verified with another seller's keys.

```ts
import {
  ResolvedAgentJwksResolver,
  createWebhookVerifier,
  type BrandAgentType,
  type RequestLike,
} from '@adcp/sdk/signing/server';

const verifiers = new Map<string, ReturnType<typeof createWebhookVerifier>>();

type SenderRecord = {
  operationId: string;
  agentUrl: string;
  protocol: 'mcp' | 'a2a';
  agentId: string;
  publisherPins?: readonly import('@adcp/sdk/signing/server').PublisherSigningKeyPin[];
  agentType: BrandAgentType;
  webhookAuth: 'rfc9421' | 'legacy-hmac';
  legacyHmacSecret?: string;
};

function verifierFor(sender: SenderRecord) {
  const cacheKey = `${sender.operationId}#${sender.agentUrl}#${sender.agentType}:${sender.agentId}`;
  let verifier = verifiers.get(cacheKey);
  if (!verifier) {
    const jwks = new ResolvedAgentJwksResolver(sender.agentUrl, sender.protocol, {
      agentType: sender.agentType,
      agentId: sender.agentId,
      legacyWebhookFallback: true,
    });
    verifier = createWebhookVerifier({ jwks, publisherPins: sender.publisherPins });
    verifiers.set(cacheKey, verifier);
  }
  return verifier;
}

async function verifyRfc9421Webhook(sender: SenderRecord, request: RequestLike) {
  return verifierFor(sender)(request);
}
```

Discovery fetches the seller's `get_adcp_capabilities` through the official
protocol client and uses its `identity.brand_json_url`. Canonical URL matching
selects the agent; type and id only narrow that match. `key_origins` is checked
for pinned keys too. Cached mappings are re-confirmed within the brand.json
cache lifetime. The explicitly enabled 3.x fallback uses the agent host's
`/.well-known/brand.json`, then its eTLD+1 only when the host serves no record.
A present `brand_json_url` is always used, including when it is invalid or unreachable.

Populate `publisherPins` from your **own stored media-buy inventory**, including
every applicable publisher. Never choose publishers from the incoming payload.
A key must be published in the agent JWKS and match every applicable pin by
RFC 7638 thumbprint; a matching `kid` alone is insufficient. Each pin's `refresh`
callback must bypass the publisher's adagents.json cache and throw on failure.
Reuse each callback bound to its seller and tenant context across deliveries;
concurrent refreshes and retries share a 30-second cooldown.
Return `null` only when a successful authoritative fetch confirms removal of the
pin. Cache verifier instances per operation because different buys may have
different publishers, and remove them when the operation is retired.

```ts
const publisherPins = mediaBuy.publisherAuthorizations.map(authorization => ({
  publisher: authorization.publisherDomain,
  signingKeys: authorization.signingKeys,
  refresh: async () => {
    const current = await publisherStore.refreshAgentAuthorization(
      authorization.publisherDomain, sender.agentUrl, { bypassCache: true }
    );
    return current.signingKeys ?? null;
  },
}));
```

`mediaBuy` and `publisherStore` are application-owned trusted records and a
publisher-document fetcher. Pin misses force-refresh before final rejection,
after signature authentication, and fail with `webhook_signature_key_unknown`.
Use `onKeyResolutionError` to log the specific `request_signature_*` cause locally.

`createWebhookVerifier` defaults replay and revocation stores once at factory
creation time. That is safe for a single process. It is not enough behind a
load balancer.

`SenderRecord`, `lookupSenderForOperation()`, and `processWebhook()` are
application-owned. Persist the expected `agentId`, `agentType`,
`agentUrl`, protocol, and exact `webhookAuth` mode when you
initiate or register the operation. The webhook receiver should read that
state by operation ID before looking at any signature header.

## Express Receiver

Capture the raw body and build an absolute URL that matches the URL the seller
signed. The example uses `requestContextFromExpress()` so the host allowlist
and HTTPS checks live in the SDK helper instead of handwritten string
assembly. If you terminate TLS at a proxy, configure `app.set('trust proxy',
...)` with your trusted proxy addresses before relying on `req.protocol`.

```ts
import express from 'express';
import { verifyWebhookRequest } from '@adcp/sdk/webhooks';
import { requestContextFromExpress, type RequestLike } from '@adcp/sdk/signing/server';

const app = express();
app.set('trust proxy', 'loopback');

app.post(
  '/adcp/webhooks/:agent_id/:operation_id',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    const sender = await lookupSenderForOperation(req.params.operation_id);
    if (!sender || sender.agentId !== req.params.agent_id) {
      return res.status(404).end();
    }

    const rawBody = req.body as Buffer;

    try {
      const hasRfc9421 = hasRfc9421Headers(req.headers);
      const hasLegacyHmac = hasLegacyHmacHeaders(req.headers);

      if (sender.webhookAuth === 'rfc9421') {
        if (!hasRfc9421 || hasLegacyHmac) {
          return res.status(401).json({ error: 'unexpected_signature_scheme' });
        }
        const context = requestContextFromExpress(req, {
          hostAllowlist: ['buyer.example.com'],
        });
        const request: RequestLike = {
          ...context,
          headers: normalizeHeaders(req.headers),
          body: rawBody.toString('utf8'),
        };
        await verifyRfc9421Webhook(sender, request);
      } else {
        if (!hasLegacyHmac || hasRfc9421 || !sender.legacyHmacSecret) {
          return res.status(401).json({ error: 'unexpected_signature_scheme' });
        }
        const result = verifyWebhookRequest({
          rawBody,
          secret: sender.legacyHmacSecret,
          headers: req.headers,
        });
        if (!result.ok) {
          return res.status(401).json({ error: result.reason });
        }
      }
    } catch {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    await processWebhook(sender, payload);
    res.status(204).end();
  }
);

function hasRfc9421Headers(headers: Record<string, unknown>): boolean {
  return Boolean(headers.signature || headers['signature-input']);
}

function hasLegacyHmacHeaders(headers: Record<string, unknown>): boolean {
  return Boolean(headers['x-adcp-signature'] || headers['x-adcp-timestamp']);
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out[key] = value.map(String);
    else if (value !== undefined) out[key] = String(value);
  }
  return out;
}
```

Important details:

- `lookupSenderForOperation()` is the trust boundary. It should read the sender
  you registered when you initiated the task, not a value from the signature.
- `sender.webhookAuth` is per operation. During migrations, choose one expected
  scheme for each operation and reject the other, even if the sender also has
  legacy credentials on file.
- A failed RFC 9421 signature returns `401`; it does not retry HMAC.
- Legacy HMAC is allowed only when the sender record says that operation was
  registered with a legacy secret.
- Parse JSON only after verification succeeds.

## Multi-Replica Replay Store

For more than one receiver process, pass a shared replay store to every
verifier instance.

Postgres:

```ts
import { Pool } from 'pg';
import {
  ResolvedAgentJwksResolver,
  PostgresReplayStore,
  createWebhookVerifier,
  getReplayStoreMigration,
  sweepExpiredReplays,
} from '@adcp/sdk/signing/server';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(getReplayStoreMigration());
setInterval(() => sweepExpiredReplays(pool).catch(console.error), 60_000);

const replayStore = new PostgresReplayStore(pool);

function buildVerifier(sender: SenderRecord) {
  return createWebhookVerifier({
    jwks: new ResolvedAgentJwksResolver(sender.agentUrl, sender.protocol, {
      agentType: sender.agentType,
      agentId: sender.agentId,
      legacyWebhookFallback: true,
    }),
    replayStore,
    publisherPins: sender.publisherPins,
  });
}
```

Redis:

```ts
import { createClient } from 'redis';
import { ResolvedAgentJwksResolver, RedisReplayStore, createWebhookVerifier } from '@adcp/sdk/signing/server';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const replayStore = new RedisReplayStore(redis, {
  // Must be unique to this deployment when Redis is shared.
  keyPrefix: 'adcp:replay:prod-eu:',
});

function buildVerifier(sender: SenderRecord) {
  return createWebhookVerifier({
    jwks: new ResolvedAgentJwksResolver(sender.agentUrl, sender.protocol, {
      agentType: sender.agentType,
      agentId: sender.agentId,
      legacyWebhookFallback: true,
    }),
    replayStore,
    publisherPins: sender.publisherPins,
  });
}
```

Redis handles expiry itself. Postgres needs the sweeper because it has no
native row TTL. Outside development and test, `RedisReplayStore` rejects an
omitted, blank, or SDK-default prefix. If the selected Redis database is
operationally dedicated to one deployment, pass
`acknowledgeIsolatedDatabase: true` instead; warning suppression is not an
isolation acknowledgement.

## Legacy HMAC

Legacy HMAC validates `x-adcp-timestamp` and `x-adcp-signature:
sha256=<hex>` over `${timestamp}.${rawBody}`.

```ts
import { verifyWebhookRequest } from '@adcp/sdk/webhooks';

const result = verifyWebhookRequest({
  rawBody,
  secret: sender.legacyHmacSecret,
  headers: req.headers,
});

if (!result.ok) {
  return res.status(401).json({ error: result.reason });
}
```

Keep secrets per sending agent or per operation registration. A single global
secret breaks per-agent isolation: compromising one sender's secret lets it
sign payloads that look like another sender's webhooks.

Legacy HMAC provides freshness, not nonce-based replay protection. Deduplicate
by `idempotency_key` or by your operation state before applying side effects:

```ts
const payload = JSON.parse(rawBody.toString('utf8'));

if (payload.idempotency_key) {
  const firstSeen = await dedupStore.setIfAbsent(`adcp:webhook:${payload.idempotency_key}`, 86_400);
  if (!firstSeen) return res.status(204).end();
}

await processWebhook(sender, payload);
```

## Failure Responses

Use `WebhookSignatureError.retryable` when deciding whether a failed RFC 9421
verification can be retried. Capabilities or brand.json discovery failures with
HTTP 408, 429, or 5xx are retryable, as are DNS failures, timeouts, and connection
resets. Other HTTP 4xx and SSRF policy refusals remain terminal; a temporary
discovery failure still requires successful signature verification before
processing the webhook.
Retry transient failures with backoff.

Use `401` for signature failures. Do not include resolved private IPs, raw
signature bases, JWKS bodies, secrets, or raw payload bytes in the response.
Log correlation IDs and typed error codes; keep detailed material in a secure
debug sink with redaction.

## Receiver Checklist

- [ ] Webhook route includes or resolves an operation ID.
- [ ] Operation state stores the expected sender agent and auth scheme.
- [ ] Raw body bytes are captured before JSON parsing.
- [ ] RFC 9421 resolver is bound to the expected sender's `brand.json`.
- [ ] Legacy HMAC secret is per sender/registration, not global.
- [ ] Multi-replica deployments use Redis or Postgres replay storage.
- [ ] Signature failure never falls back to another auth scheme.
- [ ] JSON parsing and side effects happen only after verification succeeds.

Legacy HMAC receivers can call `preflightWebhookRequest({ headers }, { maxSkewSeconds: 300 })`
from `@adcp/sdk/webhooks` before secret lookup. Success checks syntax/freshness;
then authenticate with `verifyWebhookRequest` using the secret and exact raw body.
