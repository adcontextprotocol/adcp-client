#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';

import { ADCP_VERSION, AgentClient, type AgentConfig } from '@adcp/sdk';
import {
  WholesaleFeedSync,
  WholesaleFeedWebhookNotificationError,
  parseWholesaleFeedWebhookNotification,
  registerWholesaleFeedWebhooks,
  type WholesaleFeedSyncPersistedState,
} from '@adcp/sdk/wholesale-feed-sync';
import {
  BrandJsonJwksResolver,
  WebhookSignatureError,
  createWebhookVerifier,
  type BrandAgentType,
} from '@adcp/sdk/signing/server';

const MAX_WEBHOOK_BYTES = 1024 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalAgentType(value: string | undefined): BrandAgentType {
  const agentType = value?.trim() || 'sales';
  const allowed = new Set<BrandAgentType>([
    'brand',
    'rights',
    'measurement',
    'governance',
    'creative',
    'sales',
    'buying',
    'signals',
  ]);
  if (!allowed.has(agentType as BrandAgentType)) throw new Error(`Unsupported ADCP_SELLER_AGENT_TYPE: ${agentType}`);
  return agentType as BrandAgentType;
}

function optionalProtocol(value: string | undefined): AgentConfig['protocol'] {
  const protocol = value?.trim() || 'mcp';
  if (protocol !== 'mcp' && protocol !== 'a2a') throw new Error(`Unsupported ADCP_SELLER_PROTOCOL: ${protocol}`);
  return protocol;
}

function optionalPort(value: string | undefined): number {
  const port = Number(value ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.map(String) : value === undefined ? undefined : String(value),
    ])
  );
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size <= MAX_WEBHOOK_BYTES) chunks.push(buffer);
    else tooLarge = true;
  }
  if (tooLarge) throw new RangeError(`Webhook body exceeds ${MAX_WEBHOOK_BYTES} bytes`);
  return Buffer.concat(chunks);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  response.end(json);
}

function filePersistence(stateFile: string) {
  return {
    async loadState(): Promise<WholesaleFeedSyncPersistedState | null> {
      try {
        return JSON.parse(await readFile(stateFile, 'utf8')) as WholesaleFeedSyncPersistedState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async saveState(state: WholesaleFeedSyncPersistedState): Promise<void> {
      await mkdir(dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, stateFile);
    },
  };
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => server.close(error => (error ? reject(error) : resolveClose())));
}

async function main(): Promise<void> {
  const sellerUrl = requiredEnv('ADCP_SELLER_URL');
  const sellerAgentId = requiredEnv('ADCP_SELLER_AGENT_ID');
  const accountId = requiredEnv('ADCP_ACCOUNT_ID');
  const subscriberId = requiredEnv('ADCP_SUBSCRIBER_ID');
  const callbackUrl = new URL(requiredEnv('ADCP_WEBHOOK_URL'));
  const brandJsonUrl = requiredEnv('ADCP_SELLER_BRAND_JSON_URL');
  const port = optionalPort(process.env.PORT);
  const stateFile = resolve(process.env.ADCP_MIRROR_STATE_FILE ?? '.adcp/wholesale-feed-state.json');
  const account = { account_id: accountId } as const;

  if (callbackUrl.protocol !== 'https:') {
    throw new Error('ADCP_WEBHOOK_URL must be HTTPS; use a TLS-terminating proxy in front of this process');
  }
  if (callbackUrl.username || callbackUrl.password) throw new Error('ADCP_WEBHOOK_URL must not contain userinfo');
  if (callbackUrl.hash) throw new Error('ADCP_WEBHOOK_URL must not contain a fragment');

  const client = new AgentClient(
    {
      id: sellerAgentId,
      name: sellerAgentId,
      agent_uri: sellerUrl,
      protocol: optionalProtocol(process.env.ADCP_SELLER_PROTOCOL),
      auth_token: process.env.ADCP_AUTH_TOKEN,
    },
    { adcpVersion: ADCP_VERSION }
  );

  const mirror = new WholesaleFeedSync({
    client,
    account,
    webhookScope: { senderId: sellerAgentId, accountId, subscriberId },
    persistenceHooks: filePersistence(stateFile),
    onError: error => console.error('wholesale-feed background error', error),
  });
  mirror.on('event', ({ event, synthetic }) => {
    console.log(synthetic ? 'refreshed feed change' : 'verified webhook change', event.event_type, event.entity_id);
  });
  mirror.on('resyncing', ({ reason }) => console.log('repairing wholesale mirror', reason));

  // Bind verification to a trusted seller record. Never select a seller from
  // the inbound keyid or payload.
  const jwks = new BrandJsonJwksResolver(brandJsonUrl, {
    agentType: optionalAgentType(process.env.ADCP_SELLER_AGENT_TYPE),
    agentId: sellerAgentId,
    ...(process.env.ADCP_SELLER_BRAND_ID && { brandId: process.env.ADCP_SELLER_BRAND_ID }),
  });
  const verifyWebhook = createWebhookVerifier({ jwks });

  // Serialize mirror mutations. A production multi-replica receiver should
  // also provide shared replay and webhook-dedupe stores.
  let applyTail: Promise<void> = Promise.resolve();
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== `${callbackUrl.pathname}${callbackUrl.search}`) {
        response.writeHead(404).end();
        return;
      }
      const rawBody = await readRawBody(request);
      await verifyWebhook({
        method: request.method,
        url: callbackUrl.href,
        headers: normalizeHeaders(request.headers),
        body: rawBody,
      });
      // Parse only after RFC 9421 verification succeeds. The parser checks the
      // envelope/event invariant and returns the legacy mirror payload.
      const notification = parseWholesaleFeedWebhookNotification(rawBody);
      const apply = applyTail.then(() => mirror.applyWebhook(notification.webhook));
      applyTail = apply.catch(() => undefined);
      await apply;
      response.writeHead(204).end();
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        writeJson(response, 401, { error: 'invalid_signature' });
      } else if (error instanceof WholesaleFeedWebhookNotificationError || error instanceof RangeError) {
        writeJson(response, 400, { error: 'invalid_webhook' });
      } else {
        console.error('wholesale-feed webhook failed', error);
        writeJson(response, 500, { error: 'webhook_processing_failed' });
      }
    }
  });

  const shutdown = async () => {
    mirror.stop();
    await close(server);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await listen(server, port);
  try {
    // Bootstrap first. Restored feed tokens make this a cheap conditional read
    // after restart; version gaps and bulk-change webhooks repair automatically.
    await mirror.start();
    console.log(`mirroring ${mirror.products.count} products and ${mirror.signals.count} signals (${mirror.mode})`);

    // list_accounts is the read half of the required declarative read/modify/write.
    const listed = await client.listAccounts({ account });
    if (!listed.success || listed.status !== 'completed') {
      throw new Error(`list_accounts did not complete: ${listed.success ? listed.status : listed.error}`);
    }
    const current = listed.data.accounts.find(row => row.account_id === accountId);
    if (!current) throw new Error(`Account ${accountId} was not returned by list_accounts`);

    const registered = await registerWholesaleFeedWebhooks(client, {
      account,
      currentConfigs: current.notification_configs ?? [],
      revision: current.revision,
      idempotencyKey: randomUUID(),
      subscriber: {
        subscriber_id: subscriberId,
        url: callbackUrl.href,
        active: true,
        event_types: [
          'product.created',
          'product.updated',
          'product.priced',
          'product.removed',
          'signal.created',
          'signal.updated',
          'signal.priced',
          'signal.removed',
          'wholesale_feed.bulk_change',
        ],
      },
    });
    if (!registered.success || registered.status !== 'completed') {
      throw new Error(`sync_accounts did not complete: ${registered.success ? registered.status : registered.error}`);
    }
    if (!('accounts' in registered.data)) {
      throw new Error(`sync_accounts returned an operation error: ${JSON.stringify(registered.data.errors)}`);
    }
    const registration = registered.data.accounts[0];
    if (!registration || registration.action === 'failed') {
      throw new Error(`Webhook registration failed: ${JSON.stringify(registration?.errors ?? [])}`);
    }
    console.log(`registered ${subscriberId} at ${callbackUrl.href}; receiver listening on port ${port}`);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
