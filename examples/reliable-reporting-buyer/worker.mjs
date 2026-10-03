/** Existing-app buyer worker. Supply real application bindings; see README.md. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  createHttpsReportingResourceReader,
  createPostgresReportingConsumerRuntimeV1,
  createReliableReportingConsumerV1,
} from '@adcp/sdk/reporting/consumer';
import {
  PostgresReplayStore,
  WebhookSignatureError,
  getReplayStoreMigration,
  sweepExpiredReplays,
  verifyWebhookSignature,
} from '@adcp/sdk/signing/server';

const MAX_WEBHOOK_BYTES = 1024 * 1024;

export async function startBuyerReporting(bindings) {
  const { db, namespace, accounts, jwks, revocationStore, scopeForVerifiedKey, publicWebhookUrl } = bindings;
  if (!Array.isArray(accounts) || !accounts.length) throw new TypeError('buyer-retained account roster is required');
  if (typeof scopeForVerifiedKey !== 'function') throw new TypeError('trusted signing-key scope lookup is required');
  const callbackUrl = new URL(publicWebhookUrl);
  if (callbackUrl.protocol !== 'https:' || callbackUrl.hash || callbackUrl.username || callbackUrl.password) {
    throw new TypeError('publicWebhookUrl must be an exact HTTPS callback URL without userinfo or fragment');
  }
  const listenPath = bindings.listenPath ?? callbackUrl.pathname + callbackUrl.search;
  if (typeof listenPath !== 'string' || !listenPath.startsWith('/') || listenPath.startsWith('//')) {
    throw new TypeError('listenPath must be a local absolute request path');
  }
  const replaySweepBatchSize = bindings.replaySweepBatchSize ?? 10_000;
  if (!Number.isSafeInteger(replaySweepBatchSize) || replaySweepBatchSize < 1) {
    throw new TypeError('replaySweepBatchSize must be a positive integer');
  }

  const persistence = createPostgresReportingConsumerRuntimeV1({ db, namespace });
  // Enable on one deployment process after schema review, before admitting traffic.
  if (bindings.migrate === true) {
    for (const migration of persistence.migrations.all) await db.query(migration);
    await db.query(getReplayStoreMigration());
  }
  await persistence.probe();
  await db.query('SELECT 1 FROM adcp_replay_cache LIMIT 0');
  const replayStore = new PostgresReplayStore(db);
  const resourceReader = createHttpsReportingResourceReader();
  const mapAccounts = entries => {
    if (!Array.isArray(entries)) throw new TypeError('buyer-retained account roster is required');
    return entries.map(entry => {
      if (!Array.isArray(entry.expectedPeriods)) throw new TypeError('buyer-retained expectedPeriods are required');
      if (typeof entry.evaluateAdjustment !== 'function') throw new TypeError('explicit adjustment policy is required');
      return {
        consumerScope: entry.consumerScope, // seller + authenticated buyer principal; never a credential
        accountId: entry.accountId,
        reconciliation: {
          client: entry.seller, // application-owned official AdCP client
          request: entry.request,
          expectedPeriods: entry.expectedPeriods, // retained from buyer commitments, never seller status
          resourceReader,
          credentialProvider: entry.credentialProvider,
          manifestInspectorOptions: entry.manifestInspectorOptions,
          evaluateAdjustment: entry.evaluateAdjustment,
        },
      };
    });
  };
  const consumer = createReliableReportingConsumerV1({
    persistence,
    ownerToken: randomUUID(),
    runOnStart: bindings.runOnStart,
    accounts: mapAccounts(accounts),
    async onResult(result) {
      const fields = {
        consumerScope: result.consumerScope,
        accountId: result.accountId,
        reason: result.reason,
        state: result.state,
        ...(result.state === 'reconciled' ? { definitive: result.reconciliation.definitive } : {}),
      };
      await bindings.metrics?.recordResult?.(fields);
      console.info('[buyer reporting] result', fields);
    },
    async onError(_error, _accountId, context) {
      const fields =
        _error?.code === 'NOTIFICATION_SCOPE_UNRECOGNIZED' ? { ...context, accountId: 'unrecognized' } : context;
      await bindings.metrics?.recordError?.(fields);
      // Do not log Error.message, stack, webhook body, or credentials.
      console.warn('[buyer reporting] error', fields);
    },
  });

  const server = createServer(async (request, response) => {
    if (request.url !== listenPath || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let body;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_WEBHOOK_BYTES) throw new RangeError('webhook too large');
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    } catch (error) {
      response.writeHead(error instanceof RangeError ? 413 : 400).end();
      return;
    }

    let verified;
    try {
      verified = await verifyWebhookSignature(
        { method: request.method, url: callbackUrl.href, headers: request.headers, body },
        { jwks, replayStore, revocationStore }
      );
    } catch (error) {
      let status = 503;
      if (error instanceof WebhookSignatureError) {
        status =
          error.code === 'webhook_signature_replayed'
            ? 409
            : error.code === 'webhook_signature_rate_abuse'
              ? 429
              : error.code === 'webhook_signature_revocation_stale'
                ? 503
                : 401;
      } else {
        console.warn('[buyer reporting] verifier unavailable');
      }
      response.writeHead(status, status === 429 || status === 503 ? { 'Retry-After': '30' } : {}).end();
      return;
    }

    let consumerScope;
    try {
      consumerScope = await scopeForVerifiedKey(verified.keyid);
    } catch {
      console.warn('[buyer reporting] signing-key registry unavailable');
      response.writeHead(503, { 'Retry-After': '30' }).end();
      return;
    }
    if (typeof consumerScope !== 'string' || consumerScope.length === 0) {
      response.writeHead(403).end();
      return;
    }
    let notification;
    try {
      notification = JSON.parse(body.toString('utf8'));
    } catch {
      response.writeHead(400).end();
      return;
    }
    try {
      const result = await consumer.handleAuthenticatedNotification(notification, { consumerScope });
      const retry = result && ['busy', 'lease_lost', 'stopping'].includes(result.state);
      response.writeHead(retry ? 503 : 204, retry ? { 'Retry-After': '30' } : {}).end();
    } catch (error) {
      const invalid = error?.code === 'INVALID_NOTIFICATION';
      if (!invalid)
        console.warn('[buyer reporting] notification handling failed', {
          consumerScope,
          reason: notification?.notification_type,
          code: typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'UNEXPECTED',
        });
      response.writeHead(invalid ? 400 : 503, invalid ? {} : { 'Retry-After': '30' }).end();
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(bindings.port ?? 8080, done);
  });
  consumer.start();
  let sweepPromise;
  const sweepTimer = setInterval(() => {
    if (sweepPromise) return;
    sweepPromise = sweepExpiredReplays(db, { batchSize: replaySweepBatchSize })
      .catch(() => console.warn('[buyer reporting] replay cleanup failed'))
      .finally(() => {
        sweepPromise = undefined;
      });
  }, 60_000);
  sweepTimer.unref?.();
  let stopPromise;
  return {
    consumer,
    server,
    replaceAccounts(entries) {
      consumer.replaceAccounts(mapAccounts(entries));
    },
    stop() {
      return (stopPromise ??= (async () => {
        clearInterval(sweepTimer);
        const closed = new Promise((done, fail) => server.close(error => (error ? fail(error) : done())));
        await consumer.stop();
        await closed;
        await sweepPromise;
      })());
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const modulePath = process.env.BUYER_REPORTING_BINDINGS_MODULE;
  if (!modulePath) throw new Error('Set BUYER_REPORTING_BINDINGS_MODULE to your existing-app bindings module');
  const { default: bindings } = await import(pathToFileURL(resolve(modulePath)).href);
  const worker = await startBuyerReporting(bindings);
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      worker
        .stop()
        .then(() => bindings.db.end?.())
        .catch(() => {
          process.exitCode = 1;
        });
    });
  }
}
