import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { AccountReference } from '../types';
import type { AdcpErrorInfo } from '../core/ConversationTypes';
import type { WholesaleFeedSyncClient } from './types';
import type {
  LegacyWholesaleFeedEvent,
  LegacyWholesaleFeedWebhook,
  LegacyWholesaleProduct,
  LegacyWholesaleSignal,
} from './protocol-types';
import { parseWholesaleFeedWebhookNotification } from './webhook-notification';

export type WholesaleFeedMirrorItem = LegacyWholesaleProduct | LegacyWholesaleSignal;
/** accountKey must include the caller/principal and account overlay, even for public catalogs. */
export interface WholesaleFeedMirrorScope {
  agentUrl: string;
  accountKey: string;
  entity: 'product' | 'signal';
}
export interface WholesaleFeedMirrorSnapshot {
  revision: number;
  items: WholesaleFeedMirrorItem[];
  wholesaleFeedVersion?: string;
  pricingVersion?: string;
  cacheScope: 'public' | 'account';
  lastSyncedAt?: string;
  lastWebhookEventId?: string;
  lastWebhookIdempotencyKey?: string;
  error?: AdcpErrorInfo;
}
export interface WholesaleFeedMirrorCommit {
  upserts: WholesaleFeedMirrorItem[];
  deletes: string[];
  wholesaleFeedVersion?: string;
  pricingVersion?: string;
  cacheScope: 'public' | 'account';
  lastSyncedAt: string;
  lastWebhookEventId?: string;
  lastWebhookIdempotencyKey?: string;
  /** Persist this delivery receipt atomically with the row/token commit. */
  webhookReceipt?: { eventId: string; idempotencyKey: string };
}
/** Consistent reads; atomically check/increment revisions with rows, tokens, and receipts. */
export interface WholesaleFeedMirrorStore {
  read(scope: WholesaleFeedMirrorScope): Promise<WholesaleFeedMirrorSnapshot>;
  hasWebhookReceipt(scope: WholesaleFeedMirrorScope, idempotencyKey: string): Promise<boolean>;
  commit(
    scope: WholesaleFeedMirrorScope,
    expectedRevision: number,
    change: WholesaleFeedMirrorCommit
  ): Promise<boolean>;
  recordError(scope: WholesaleFeedMirrorScope, expectedRevision: number, error: AdcpErrorInfo): Promise<boolean>;
}
export type WholesaleFeedRefreshOutcome =
  | { outcome: 'unchanged'; snapshot: WholesaleFeedMirrorSnapshot }
  | { outcome: 'applied'; snapshot: WholesaleFeedMirrorSnapshot; diff: LegacyWholesaleFeedEvent[] }
  | { outcome: 'degraded'; error: AdcpErrorInfo; cause: Error }
  | { outcome: 'superseded' };
export interface RefreshWholesaleFeedOptions {
  client: WholesaleFeedSyncClient;
  store: WholesaleFeedMirrorStore;
  scope: WholesaleFeedMirrorScope;
  account?: AccountReference;
  /** Disable against sellers that do not advertise wholesale-feed versioning. Defaults to true. */
  conditional?: boolean;
  /** Local cancellation fence; no timer is started by the core. */
  isCurrent?: () => boolean;
}

export class InMemoryWholesaleFeedMirrorStore implements WholesaleFeedMirrorStore {
  private readonly records = new Map<string, WholesaleFeedMirrorSnapshot>();
  private readonly receipts = new Map<string, Set<string>>();
  private receiptCount = 0;
  /** Fail closed at capacity rather than evicting receipts inside the delivery retry window. */
  constructor(private readonly maxWebhookReceipts = 10_000) {
    if (!Number.isSafeInteger(maxWebhookReceipts) || maxWebhookReceipts < 1)
      throw new Error('maxWebhookReceipts must be a positive integer.');
  }
  async hasWebhookReceipt(scope: WholesaleFeedMirrorScope, idempotencyKey: string): Promise<boolean> {
    return this.receipts.get(this.key(scope))?.has(idempotencyKey) ?? false;
  }
  private key(scope: WholesaleFeedMirrorScope): string {
    return JSON.stringify([scope.agentUrl, scope.accountKey, scope.entity]);
  }
  async read(scope: WholesaleFeedMirrorScope): Promise<WholesaleFeedMirrorSnapshot> {
    return structuredClone(this.records.get(this.key(scope)) ?? { revision: 0, items: [], cacheScope: 'public' });
  }
  /** Seed a detached record when restoring a shell snapshot. */
  restore(scope: WholesaleFeedMirrorScope, snapshot: WholesaleFeedMirrorSnapshot): void {
    this.records.set(this.key(scope), structuredClone(snapshot));
  }
  async commit(
    scope: WholesaleFeedMirrorScope,
    expectedRevision: number,
    change: WholesaleFeedMirrorCommit
  ): Promise<boolean> {
    const key = this.key(scope);
    const prior = this.records.get(key) ?? { revision: 0, items: [], cacheScope: 'public' as const };
    if (prior.revision !== expectedRevision) return false;
    const items = new Map(prior.items.map(item => [itemId(scope.entity, item), item]));
    for (const id of change.deletes) items.delete(id);
    for (const item of change.upserts) items.set(itemId(scope.entity, item), structuredClone(item));
    const { upserts: _upserts, deletes: _deletes, webhookReceipt, ...metadata } = change;
    const next = {
      ...prior,
      ...structuredClone(metadata),
      revision: prior.revision + 1,
      items: [...items.values()],
      error: undefined,
    };
    if (webhookReceipt) {
      const receipts = this.receipts.get(key) ?? new Set<string>();
      if (!receipts.has(webhookReceipt.idempotencyKey)) {
        if (this.receiptCount >= this.maxWebhookReceipts)
          throw new Error('Webhook receipt capacity reached; use durable storage or increase maxWebhookReceipts.');
        receipts.add(webhookReceipt.idempotencyKey);
        ++this.receiptCount;
      }
      this.receipts.set(key, receipts);
    }
    this.records.set(key, next);
    return true;
  }
  async recordError(scope: WholesaleFeedMirrorScope, expectedRevision: number, error: AdcpErrorInfo): Promise<boolean> {
    const key = this.key(scope);
    const prior = this.records.get(key) ?? { revision: 0, items: [], cacheScope: 'public' as const };
    if (prior.revision !== expectedRevision) return false;
    this.records.set(key, { ...prior, revision: prior.revision + 1, error: structuredClone(error) });
    return true;
  }
}

/** Refresh one legacy get_products/get_signals feed without owning scheduling or storage. */
export async function refreshWholesaleFeed(options: RefreshWholesaleFeedOptions): Promise<WholesaleFeedRefreshOutcome> {
  return refreshMirror(options);
}
async function refreshMirror(
  options: RefreshWholesaleFeedOptions,
  receipt?: { eventId: string; idempotencyKey: string },
  expectedWebhookVersion?: string
): Promise<WholesaleFeedRefreshOutcome> {
  options = { ...options, scope: structuredClone(options.scope), account: structuredClone(options.account) };
  const { store, scope, client } = options;
  const previous = await store.read(scope);
  if (options.isCurrent && !options.isCurrent()) return { outcome: 'superseded' };
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const items = new Map<string, WholesaleFeedMirrorItem>();
  let wholesaleFeedVersion: string | undefined;
  let pricingVersion: string | undefined;
  let cacheScope = previous.cacheScope;
  let unchanged = false;
  let page = 0;
  try {
    do {
      if (++page > 10_000) throw new Error('Wholesale feed pagination exceeded its page limit.');
      const params = {
        ...(scope.entity === 'product' ? { buying_mode: 'wholesale' } : { discovery_mode: 'wholesale' }),
        pagination: { max_results: 100, ...(cursor && { cursor }) },
        ...(options.account && { account: options.account }),
        ...(!cursor &&
          options.conditional !== false &&
          previous.wholesaleFeedVersion && {
            if_wholesale_feed_version: previous.wholesaleFeedVersion,
            ...(previous.pricingVersion && { if_pricing_version: previous.pricingVersion }),
          }),
      };
      const result = await (scope.entity === 'product'
        ? client.getProducts(params as never)
        : client.getSignals(params as never));
      if (options.isCurrent && !options.isCurrent()) return { outcome: 'superseded' };
      if (
        result.success === false ||
        (result.status !== undefined && !['completed', 'success'].includes(result.status))
      ) {
        throw Object.assign(new Error(result.error ?? 'Wholesale feed refresh failed.'), {
          adcpError: result.adcpError,
        });
      }
      const body = result.data as
        | {
            unchanged?: boolean;
            products?: LegacyWholesaleProduct[];
            signals?: LegacyWholesaleSignal[];
            wholesale_feed_version?: string;
            pricing_version?: string;
            cache_scope?: 'public' | 'account';
            pagination?: { has_more?: boolean; cursor?: string };
          }
        | undefined;
      if (!body) throw new Error('Wholesale feed did not return a completed catalog.');
      if (body.unchanged) {
        if (
          cursor ||
          !('if_wholesale_feed_version' in params) ||
          body.wholesale_feed_version !== previous.wholesaleFeedVersion ||
          ('if_pricing_version' in params && body.pricing_version !== previous.pricingVersion) ||
          (body.cache_scope !== undefined && body.cache_scope !== previous.cacheScope)
        ) {
          throw new Error('Wholesale feed unchanged response must match both requested version tokens.');
        }
        unchanged = true;
      }
      if (
        page > 1 &&
        (body.wholesale_feed_version !== wholesaleFeedVersion ||
          body.pricing_version !== pricingVersion ||
          (body.cache_scope ?? cacheScope) !== cacheScope)
      ) {
        throw new Error('Wholesale feed versions changed during pagination.');
      }
      wholesaleFeedVersion = body.wholesale_feed_version;
      pricingVersion = body.pricing_version;
      cacheScope = body.cache_scope ?? cacheScope;
      if (unchanged) break;
      const rows = scope.entity === 'product' ? body.products : body.signals;
      if (!Array.isArray(rows)) throw new Error('Wholesale feed response is missing its catalog rows.');
      for (const item of rows) {
        const id = itemId(scope.entity, item);
        if (!id) throw new Error('Wholesale feed row is missing its entity id.');
        items.set(id, item);
      }
      cursor = body.pagination?.has_more ? body.pagination.cursor : undefined;
      if (body.pagination?.has_more && (!cursor || cursors.has(cursor)))
        throw new Error('Wholesale feed pagination did not advance.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (
      receipt &&
      expectedWebhookVersion !== undefined &&
      wholesaleFeedVersion === previous.wholesaleFeedVersion &&
      wholesaleFeedVersion !== expectedWebhookVersion
    )
      throw new Error('Wholesale repair has not observed the webhook version; retry delivery.');
  } catch (cause) {
    if (options.isCurrent && !options.isCurrent()) return { outcome: 'superseded' };
    const errorCause = cause instanceof Error ? cause : new Error(String(cause));
    const error = (cause as { adcpError?: AdcpErrorInfo })?.adcpError ?? {
      code: 'SERVICE_UNAVAILABLE',
      recovery: 'transient' as const,
      message: 'Wholesale feed refresh failed.',
      synthetic: true,
    };
    if (!(await store.recordError(scope, previous.revision, error))) return { outcome: 'superseded' };
    return { outcome: 'degraded', error, cause: errorCause };
  }
  const nextItems = unchanged ? previous.items : [...items.values()];
  const next = {
    ...previous,
    items: nextItems,
    wholesaleFeedVersion,
    pricingVersion,
    cacheScope,
    lastSyncedAt: new Date().toISOString(),
    revision: previous.revision + 1,
    error: undefined,
    ...(receipt && {
      lastWebhookEventId: latestEventId(previous.lastWebhookEventId, receipt.eventId),
      lastWebhookIdempotencyKey: receipt.idempotencyKey,
    }),
  };
  const change = rowDiff(scope.entity, previous.items, nextItems);
  if (options.isCurrent && !options.isCurrent()) return { outcome: 'superseded' };
  if (
    !(await store.commit(scope, previous.revision, {
      ...change,
      wholesaleFeedVersion,
      pricingVersion,
      cacheScope,
      lastSyncedAt: next.lastSyncedAt,
      ...(receipt && {
        webhookReceipt: receipt,
        lastWebhookEventId: next.lastWebhookEventId,
        lastWebhookIdempotencyKey: receipt.idempotencyKey,
      }),
    }))
  )
    return { outcome: 'superseded' };
  return unchanged
    ? { outcome: 'unchanged', snapshot: next }
    : {
        outcome: 'applied',
        snapshot: next,
        diff: diffWholesaleFeed(scope.entity, previous.items, nextItems, cacheScope, true),
      };
}

export interface ApplyWholesaleFeedWebhookOptions extends RefreshWholesaleFeedOptions {
  webhook: LegacyWholesaleFeedWebhook;
  /** Expected subscription route, supplied after authentication by the receiver. */
  webhookScope?: { accountId?: string; subscriberId?: string };
}
/** Apply an authenticated legacy delta, or repair from the seller on bulk change/order/version mismatch. */
export async function applyWholesaleFeedWebhook(
  options: ApplyWholesaleFeedWebhookOptions
): Promise<WholesaleFeedRefreshOutcome> {
  options = {
    ...options,
    scope: structuredClone(options.scope),
    account: structuredClone(options.account),
    webhookScope: structuredClone(options.webhookScope),
    webhook: structuredClone(options.webhook),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await applyWebhookOnce(options);
    if (outcome.outcome !== 'superseded' || (options.isCurrent && !options.isCurrent())) return outcome;
  }
  return { outcome: 'superseded' };
}
async function applyWebhookOnce(options: ApplyWholesaleFeedWebhookOptions): Promise<WholesaleFeedRefreshOutcome> {
  const { webhook, scope, store } = options;
  parseWholesaleFeedWebhookNotification(webhook);
  const event = webhook.event;
  if (!event || webhook.notification_type !== event.event_type || webhook.notification_id !== event.event_id)
    throw new Error('Wholesale webhook event identity does not match its envelope.');
  const entity =
    event.event_type === 'wholesale_feed.bulk_change'
      ? (event.payload as { affected_entity_type?: string }).affected_entity_type
      : event.event_type.startsWith('product.')
        ? 'product'
        : event.event_type.startsWith('signal.')
          ? 'signal'
          : undefined;
  if (entity !== scope.entity) throw new Error('Wholesale webhook entity does not match this mirror.');
  const accountId =
    options.webhookScope?.accountId ??
    (options.account && 'account_id' in options.account ? options.account.account_id : undefined);
  if (!accountId) throw new Error('Wholesale webhook application requires an expected account_id.');
  if (
    webhook.account_id !== accountId ||
    (options.webhookScope?.subscriberId && options.webhookScope.subscriberId !== webhook.subscriber_id)
  )
    throw new Error('Wholesale webhook subscription does not match this mirror.');
  const applies = (event.payload as { applies_to?: { scope?: string; account_ids?: string[] } }).applies_to;
  if (
    (applies?.scope && applies.scope !== webhook.cache_scope) ||
    (webhook.cache_scope === 'account' && applies?.account_ids && !applies.account_ids.includes(accountId))
  )
    throw new Error('Wholesale webhook cache scope does not match this mirror.');
  const previous = await store.read(scope);
  if ((await store.hasWebhookReceipt(scope, webhook.idempotency_key)) || previous.lastWebhookEventId === event.event_id)
    return { outcome: 'unchanged', snapshot: previous };
  if (previous.cacheScope !== webhook.cache_scope)
    return refreshMirror(
      { ...options, conditional: false },
      { eventId: event.event_id, idempotencyKey: webhook.idempotency_key },
      webhook.wholesale_feed_version
    );
  const stale =
    previous.lastWebhookEventId &&
    isUuidV7(event.event_id) &&
    isUuidV7(previous.lastWebhookEventId) &&
    event.event_id.toLowerCase() <= previous.lastWebhookEventId.toLowerCase();
  if (
    event.event_type === 'wholesale_feed.bulk_change' ||
    stale ||
    !previous.wholesaleFeedVersion ||
    webhook.previous_wholesale_feed_version !== previous.wholesaleFeedVersion
  ) {
    return refreshMirror(
      options,
      { eventId: event.event_id, idempotencyKey: webhook.idempotency_key },
      stale ? undefined : webhook.wholesale_feed_version
    );
  }
  const items = applyWholesaleFeedEvent(scope.entity, previous.items, event);
  // Metadata-only updates lack enough information to safely replace a row.
  if (!items)
    return refreshMirror(
      options,
      { eventId: event.event_id, idempotencyKey: webhook.idempotency_key },
      webhook.wholesale_feed_version
    );
  const next: WholesaleFeedMirrorSnapshot = {
    ...previous,
    items,
    revision: previous.revision + 1,
    wholesaleFeedVersion: webhook.wholesale_feed_version,
    cacheScope: webhook.cache_scope,
    lastSyncedAt: new Date().toISOString(),
    lastWebhookEventId: event.event_id,
    lastWebhookIdempotencyKey: webhook.idempotency_key,
    error: undefined,
  };
  if (options.isCurrent && !options.isCurrent()) return { outcome: 'superseded' };
  if (
    !(await store.commit(scope, previous.revision, {
      ...rowDiff(scope.entity, previous.items, items),
      wholesaleFeedVersion: next.wholesaleFeedVersion,
      pricingVersion: next.pricingVersion,
      cacheScope: next.cacheScope,
      lastSyncedAt: next.lastSyncedAt!,
      lastWebhookEventId: event.event_id,
      lastWebhookIdempotencyKey: webhook.idempotency_key,
      webhookReceipt: { eventId: event.event_id, idempotencyKey: webhook.idempotency_key },
    }))
  )
    return { outcome: 'superseded' };
  return { outcome: 'applied', snapshot: next, diff: [event] };
}

export function applyWholesaleFeedEvent(
  entity: WholesaleFeedMirrorScope['entity'],
  previous: WholesaleFeedMirrorItem[],
  event: LegacyWholesaleFeedEvent
): WholesaleFeedMirrorItem[] | undefined {
  const items = new Map(previous.map(item => [itemId(entity, item), item]));
  const payload = event.payload as {
    product_id?: string;
    signal_agent_segment_id?: string;
    product?: LegacyWholesaleProduct;
    signal?: LegacyWholesaleSignal;
    pricing_options?: unknown[];
  };
  const id = entity === 'product' ? payload.product_id : payload.signal_agent_segment_id;
  if (!id) return undefined;
  if (event.event_type.endsWith('.removed')) items.delete(id);
  else if (event.event_type.endsWith('.priced')) {
    const prior = items.get(id);
    if (!prior || !Array.isArray(payload.pricing_options)) return undefined;
    items.set(id, { ...prior, pricing_options: payload.pricing_options } as WholesaleFeedMirrorItem);
  } else {
    const item = entity === 'product' ? payload.product : payload.signal;
    if (!item || itemId(entity, item) !== id) return undefined;
    items.set(id, item);
  }
  return [...items.values()];
}

export function diffWholesaleFeed(
  entity: WholesaleFeedMirrorScope['entity'],
  previous: WholesaleFeedMirrorItem[],
  next: WholesaleFeedMirrorItem[],
  cacheScope: 'public' | 'account',
  includeAllChanges = false
): LegacyWholesaleFeedEvent[] {
  const before = new Map(previous.map(item => [itemId(entity, item), item]));
  const after = new Map(next.map(item => [itemId(entity, item), item]));
  const events: LegacyWholesaleFeedEvent[] = [];
  const emit = (id: string, action: string, data: object) =>
    events.push({
      event_id: randomUUID(),
      event_type: `${entity}.${action}`,
      entity_type: entity,
      entity_id: id,
      created_at: new Date().toISOString(),
      payload: {
        [entity === 'product' ? 'product_id' : 'signal_agent_segment_id']: id,
        ...data,
        applies_to: { scope: cacheScope },
      },
    } as LegacyWholesaleFeedEvent);
  for (const [id, item] of after) {
    const prior = before.get(id);
    if (!prior) emit(id, 'created', { [entity]: item });
    else if (!isDeepStrictEqual(prior.pricing_options, item.pricing_options)) {
      emit(id, 'priced', { pricing_options: item.pricing_options ?? [] });
      if (includeAllChanges && !isDeepStrictEqual({ ...prior, pricing_options: item.pricing_options }, item))
        emit(id, 'updated', { [entity]: item });
    } else if (!isDeepStrictEqual(prior, item)) emit(id, 'updated', { [entity]: item });
  }
  for (const id of before.keys()) if (!after.has(id)) emit(id, 'removed', {});
  return events;
}
function itemId(entity: WholesaleFeedMirrorScope['entity'], item: WholesaleFeedMirrorItem): string {
  return entity === 'product'
    ? (item as LegacyWholesaleProduct).product_id
    : (item as LegacyWholesaleSignal).signal_agent_segment_id;
}
function rowDiff(
  entity: WholesaleFeedMirrorScope['entity'],
  previous: WholesaleFeedMirrorItem[],
  next: WholesaleFeedMirrorItem[]
) {
  const before = new Map(previous.map(item => [itemId(entity, item), item]));
  const ids = new Set(next.map(item => itemId(entity, item)));
  return {
    upserts: next.filter(item => !isDeepStrictEqual(before.get(itemId(entity, item)), item)),
    deletes: [...before.keys()].filter(id => !ids.has(id)),
  };
}
function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function latestEventId(previous: string | undefined, next: string): string {
  return previous && isUuidV7(previous) && (!isUuidV7(next) || previous.toLowerCase() >= next.toLowerCase())
    ? previous
    : next;
}
