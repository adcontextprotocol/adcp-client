/**
 * ProposalStore — per-tenant proposal lifecycle persistence.
 *
 * The single ledger for proposal recipes across the entire lifecycle:
 * draft (in-flight refine iterations) → committed (post-finalize, with
 * `expires_at` hold window) → consumed (post-`create_media_buy`).
 *
 * Ports `adcp-client-python.src/adcp/decisioning/proposal_store.py`.
 *
 * State machine the framework drives:
 *
 * ```
 *                              ┌──── releaseConsumption ────┐
 *                              ▼                            │
 *  putDraft ─► DRAFT ─► commit ─► COMMITTED ─► tryReserveConsumption ─► CONSUMING
 *                ▲                                                          │
 *                │                                                          │
 *             (refine                                              finalizeConsumption
 *              iteration)                                                   │
 *                │                                                          ▼
 *                └─ putDraft (overwrite while DRAFT) ─┘                CONSUMED
 *                                                                       (terminal)
 * ```
 *
 * The `COMMITTED → CONSUMING → CONSUMED` two-phase transition prevents the
 * inventory double-spend race that a check-then-act sequence on `COMMITTED`
 * would expose. Two parallel `create_media_buy(proposal_id=X)` calls cannot
 * both reserve the proposal — the second `tryReserveConsumption` raises
 * `PROPOSAL_NOT_COMMITTED` once the first transitions the record. Adapter
 * dispatch runs against the reservation; on success the framework calls
 * `finalizeConsumption`; on failure `releaseConsumption` rolls back to
 * COMMITTED so the buyer can retry.
 *
 * Transitions outside this graph (commit-from-COMMITTED with mismatched
 * payload, finalize-from-DRAFT, etc.) throw `AdcpError` with `INTERNAL_ERROR`
 * — those are framework / adopter bugs, not buyer-facing rejections.
 *
 * @public
 * @packageDocumentation
 */

import type { MaybePromise } from '../../create-adcp-server';
import { AdcpError } from '../async-outcome';
import type { Recipe } from './types';

/**
 * Lifecycle states for a stored proposal.
 *
 * No `EXPIRED` member: the framework computes expiry from
 * {@link ProposalRecord.expiresAt} + the current clock + the adopter's
 * grace window. Storing expiry as a state would create a clock-driven
 * write the framework doesn't actually need.
 *
 * @public
 */
export type ProposalState = 'draft' | 'committed' | 'consuming' | 'consumed';

/**
 * The framework's per-proposal storage row.
 *
 * @public
 */
export interface ProposalRecord<TRecipe extends Recipe = Recipe> {
  /** Stable identifier the buyer receives in the `proposals[]` wire array. */
  proposalId: string;
  /** Account that owns the proposal. Drives the cross-tenant check on `get`. */
  accountId: string;
  /** Current lifecycle state. */
  state: ProposalState;
  /**
   * `productId -> Recipe` mapping. The {@link ProposalManager} returned these
   * alongside products on `getProducts` / `refineProducts`; the framework
   * persists them so `DecisioningPlatform.createMediaBuy` can hydrate
   * `ctx.recipes` from this same record.
   */
  recipes: ReadonlyMap<string, TRecipe>;
  /**
   * The wire `Proposal` shape. Stored so the framework can re-emit it on
   * refine iterations or replay it post-finalize without round-tripping
   * through the manager again.
   */
  proposalPayload: Record<string, unknown>;
  /**
   * Set on `commit`. The inventory hold window; framework rejects
   * `create_media_buy` calls past this deadline (plus the adopter's grace).
   */
  expiresAt?: Date;
  /**
   * Set on `finalizeConsumption` (or legacy `markConsumed`). The accepted
   * proposal's terminal binding to a media buy; reverse-index lookups via
   * `getByMediaBuyId` use this.
   */
  mediaBuyId?: string;
  /**
   * Captured at `putDraft` time. Adopters whose Recipe subtypes add required
   * fields later bump the schema and write a migration (or evict pre-bump
   * records). Framework reads but does not enforce.
   */
  recipeSchemaVersion?: number;
}

/**
 * Per-tenant proposal lifecycle persistence.
 *
 * Methods may return `T` or `Promise<T>` — the framework awaits at call time.
 * Mirrors the in-tree `MediaBuyStore` posture.
 *
 * @public
 */
export interface ProposalStore<TRecipe extends Recipe = Recipe> {
  /**
   * Drives the production-mode gate. `false` for {@link InMemoryProposalStore};
   * `true` for adopter-supplied durable backings (Postgres / Redis).
   */
  readonly isDurable: boolean;

  /**
   * Store / replace a draft proposal.
   *
   * Refine iterations call this with the same `proposalId` to overwrite.
   * Calling on a record currently in COMMITTED, CONSUMING, or CONSUMED is
   * rejected.
   */
  putDraft(args: {
    proposalId: string;
    accountId: string;
    recipes: ReadonlyMap<string, TRecipe>;
    proposalPayload: Record<string, unknown>;
  }): MaybePromise<void>;

  /**
   * Look up a proposal record. Cross-tenant probes return `null` rather
   * than the raw record — required to defeat principal-enumeration via
   * `proposalId` probing. The dispatch path always passes the
   * authenticated principal's `accountId`.
   */
  get(proposalId: string, options?: { expectedAccountId?: string }): MaybePromise<ProposalRecord<TRecipe> | null>;

  /**
   * Promote DRAFT → COMMITTED. Idempotent on re-call with equal `expiresAt`
   * + `proposalPayload`. A second commit with different values raises
   * `INTERNAL_ERROR`.
   */
  commit(proposalId: string, args: { expiresAt: Date; proposalPayload: Record<string, unknown> }): MaybePromise<void>;

  /**
   * Atomic CAS: COMMITTED → CONSUMING.
   *
   * The framework calls this BEFORE dispatching `createMediaBuy`. Holds
   * the reservation until `finalizeConsumption` (success) or
   * `releaseConsumption` (rollback). Two parallel callers cannot both
   * reserve; the loser raises `PROPOSAL_NOT_COMMITTED`. SQL-backed
   * implementations use `SELECT … FOR UPDATE` or equivalent.
   *
   * @throws AdcpError `PROPOSAL_NOT_FOUND` when no record exists,
   *   `PROPOSAL_NOT_COMMITTED` when state is not COMMITTED.
   */
  tryReserveConsumption(proposalId: string, args: { expectedAccountId: string }): MaybePromise<ProposalRecord<TRecipe>>;

  /**
   * Promote CONSUMING → CONSUMED and record the `mediaBuyId` back-reference
   * for `getByMediaBuyId` lookups.
   */
  finalizeConsumption(proposalId: string, args: { mediaBuyId: string; expectedAccountId: string }): MaybePromise<void>;

  /**
   * Rollback path: CONSUMING → COMMITTED. Idempotent on a record already
   * in COMMITTED. Called when the adapter's `createMediaBuy` raises so
   * the buyer can retry without `PROPOSAL_NOT_COMMITTED`.
   */
  releaseConsumption(proposalId: string, args: { expectedAccountId: string }): MaybePromise<void>;

  /**
   * Legacy direct COMMITTED → CONSUMED transition. Preserved for
   * back-compat with v1.5 alpha adopters. New code uses
   * `tryReserveConsumption` + `finalizeConsumption` for race-safe two-phase
   * commit; this method MUST NOT be called from concurrent dispatch paths.
   */
  markConsumed(proposalId: string, args: { mediaBuyId: string }): MaybePromise<void>;

  /**
   * Discard a proposal record. Idempotent — discarding an unknown id is
   * a no-op (no throw).
   */
  discard(proposalId: string): MaybePromise<void>;

  /**
   * Reverse-index lookup. Hydrate the (consumed) proposal that produced
   * this `mediaBuyId` for the given tenant.
   *
   * `expectedAccountId` is required (no default) because `mediaBuyId` is
   * adopter-controlled and can collide across tenants. SQL-backed impls
   * add a uniqueness constraint on `(accountId, mediaBuyId)` where
   * `mediaBuyId IS NOT NULL`.
   */
  getByMediaBuyId(
    mediaBuyId: string,
    args: { expectedAccountId: string }
  ): MaybePromise<ProposalRecord<TRecipe> | null>;
}

// ---------------------------------------------------------------------------
// In-memory reference implementation
// ---------------------------------------------------------------------------

const DEFAULT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_COMMITTED_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Construction options for {@link InMemoryProposalStore}.
 *
 * @public
 */
export interface InMemoryProposalStoreOptions {
  /**
   * How long a draft proposal lives without a commit before being evicted.
   * Default 24h. Pass as milliseconds.
   */
  draftTtlMs?: number;
  /**
   * How long a committed (or consumed) proposal lives past its `expiresAt`
   * before eviction. Default 7 days. Pass as milliseconds.
   */
  committedGraceMs?: number;
  /**
   * Test-injectable clock. Defaults to `() => new Date()`.
   */
  clock?: () => Date;
}

/**
 * Process-local {@link ProposalStore} reference implementation.
 *
 * Storage is a plain `Map` — JS event-loop atomicity covers the critical
 * sections (no preemption between awaits within a method body since there
 * are no awaits). Adequate for local dev, CI, and tests; production
 * deployments wire a durable backing implementing the same interface.
 *
 * Eviction:
 *
 *   - Drafts older than `draftTtlMs` (default 24h) are evicted on every
 *     read / write.
 *   - Committed proposals more than `committedGraceMs` past `expiresAt`
 *     (default 7 days) are evicted.
 *
 * Eviction runs lazily — no background timer thread.
 *
 * Cross-tenant safety: `get` and `getByMediaBuyId` honor `expectedAccountId`
 * — cross-tenant probes return `null`, not the raw record.
 *
 * @public
 */
export class InMemoryProposalStore<TRecipe extends Recipe = Recipe> implements ProposalStore<TRecipe> {
  readonly isDurable = false;

  private readonly records: Map<string, ProposalRecord<TRecipe>> = new Map();
  // Reverse index keyed by `${accountId}::${mediaBuyId}`. Tenant scoping in
  // the key prevents collisions when adopter media_buy_ids overlap across
  // tenants (sequential IDs, deterministic test fixtures).
  private readonly mediaBuyIndex: Map<string, string> = new Map();
  private readonly creationTimes: Map<string, Date> = new Map();
  private readonly draftTtlMs: number;
  private readonly committedGraceMs: number;
  private readonly clock: () => Date;

  constructor(options: InMemoryProposalStoreOptions = {}) {
    this.draftTtlMs = options.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS;
    this.committedGraceMs = options.committedGraceMs ?? DEFAULT_COMMITTED_GRACE_MS;
    this.clock = options.clock ?? (() => new Date());
  }

  private mediaBuyKey(accountId: string, mediaBuyId: string): string {
    return `${accountId}::${mediaBuyId}`;
  }

  private evictExpired(): void {
    const now = this.clock().getTime();
    const toRemove: string[] = [];
    for (const [proposalId, record] of this.records) {
      const created = this.creationTimes.get(proposalId)?.getTime() ?? now;
      if (record.state === 'draft') {
        if (now - created > this.draftTtlMs) toRemove.push(proposalId);
      } else if (record.expiresAt) {
        const deadline = record.expiresAt.getTime() + this.committedGraceMs;
        if (now > deadline) toRemove.push(proposalId);
      }
    }
    for (const proposalId of toRemove) {
      const removed = this.records.get(proposalId);
      this.records.delete(proposalId);
      this.creationTimes.delete(proposalId);
      if (removed?.mediaBuyId) {
        this.mediaBuyIndex.delete(this.mediaBuyKey(removed.accountId, removed.mediaBuyId));
      }
    }
  }

  putDraft(args: {
    proposalId: string;
    accountId: string;
    recipes: ReadonlyMap<string, TRecipe>;
    proposalPayload: Record<string, unknown>;
  }): void {
    this.evictExpired();
    const existing = this.records.get(args.proposalId);
    if (existing && existing.state !== 'draft') {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `Cannot putDraft on proposal ${JSON.stringify(args.proposalId)} in state ` +
          `${JSON.stringify(existing.state)}; refine iterations are only valid on draft ` +
          `proposals. Once committed or consumed, a proposal_id is immutable.`,
      });
    }
    const record: ProposalRecord<TRecipe> = {
      proposalId: args.proposalId,
      accountId: args.accountId,
      state: 'draft',
      recipes: new Map(args.recipes),
      proposalPayload: { ...args.proposalPayload },
    };
    this.records.set(args.proposalId, record);
    // Refine iterations preserve the original creation time so the 24h
    // draft TTL is anchored to the start of the buyer's session, not the
    // most recent iteration.
    if (!this.creationTimes.has(args.proposalId)) {
      this.creationTimes.set(args.proposalId, this.clock());
    }
  }

  get(proposalId: string, options?: { expectedAccountId?: string }): ProposalRecord<TRecipe> | null {
    this.evictExpired();
    const record = this.records.get(proposalId);
    if (!record) return null;
    if (options?.expectedAccountId !== undefined && record.accountId !== options.expectedAccountId) {
      // Cross-tenant probe — return null, not raw record.
      return null;
    }
    return record;
  }

  commit(proposalId: string, args: { expiresAt: Date; proposalPayload: Record<string, unknown> }): void {
    this.evictExpired();
    const record = this.records.get(proposalId);
    if (!record) {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `Cannot commit proposal ${JSON.stringify(proposalId)}: not in store. The ` +
          `framework's finalize dispatch must putDraft before commit.`,
      });
    }
    const payload = { ...args.proposalPayload };
    if (record.state === 'committed') {
      const sameDeadline = record.expiresAt?.getTime() === args.expiresAt.getTime();
      const samePayload = JSON.stringify(record.proposalPayload) === JSON.stringify(payload);
      if (sameDeadline && samePayload) return;
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `Proposal ${JSON.stringify(proposalId)} already committed with a different ` +
          `expires_at or payload — re-commit with different values is a developer bug.`,
      });
    }
    if (record.state !== 'draft') {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `Cannot commit proposal ${JSON.stringify(proposalId)} from state ` +
          `${JSON.stringify(record.state)}; commit requires DRAFT.`,
      });
    }
    this.records.set(proposalId, {
      ...record,
      state: 'committed',
      expiresAt: args.expiresAt,
      proposalPayload: payload,
    });
  }

  tryReserveConsumption(proposalId: string, args: { expectedAccountId: string }): ProposalRecord<TRecipe> {
    this.evictExpired();
    const record = this.records.get(proposalId);
    // Cross-tenant probe collapses to PROPOSAL_NOT_FOUND — same
    // principal-enumeration defense as `get`.
    if (!record || record.accountId !== args.expectedAccountId) {
      throw new AdcpError('PROPOSAL_NOT_FOUND', {
        recovery: 'terminal',
        message: `Proposal ${JSON.stringify(proposalId)} not found.`,
        field: 'proposal_id',
      });
    }
    if (record.state !== 'committed') {
      throw new AdcpError('PROPOSAL_NOT_COMMITTED', {
        recovery: 'correctable',
        message:
          `Proposal ${JSON.stringify(proposalId)} is in state ${JSON.stringify(record.state)}; ` +
          `create_media_buy requires a committed proposal that hasn't been accepted or ` +
          `reserved by another request.`,
        field: 'proposal_id',
      });
    }
    const reserved: ProposalRecord<TRecipe> = { ...record, state: 'consuming' };
    this.records.set(proposalId, reserved);
    return reserved;
  }

  finalizeConsumption(proposalId: string, args: { mediaBuyId: string; expectedAccountId: string }): void {
    const record = this.records.get(proposalId);
    if (!record || record.accountId !== args.expectedAccountId) {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message: `finalizeConsumption: proposal ${JSON.stringify(proposalId)} not found for ` + `the expected tenant.`,
      });
    }
    if (record.state === 'consumed') {
      // Idempotent on already-CONSUMED with the same mediaBuyId.
      if (record.mediaBuyId === args.mediaBuyId) return;
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `Proposal ${JSON.stringify(proposalId)} already consumed by ` +
          `media_buy_id=${JSON.stringify(record.mediaBuyId)}; cannot re-consume as ` +
          `${JSON.stringify(args.mediaBuyId)}.`,
      });
    }
    if (record.state !== 'consuming') {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `finalizeConsumption requires CONSUMING; proposal ${JSON.stringify(proposalId)} ` +
          `is in ${JSON.stringify(record.state)}. Framework must call ` +
          `tryReserveConsumption first.`,
      });
    }
    this.records.set(proposalId, {
      ...record,
      state: 'consumed',
      mediaBuyId: args.mediaBuyId,
    });
    this.mediaBuyIndex.set(this.mediaBuyKey(record.accountId, args.mediaBuyId), proposalId);
  }

  releaseConsumption(proposalId: string, args: { expectedAccountId: string }): void {
    const record = this.records.get(proposalId);
    if (!record || record.accountId !== args.expectedAccountId) {
      // Idempotent — releasing an unknown id is a no-op so the
      // adapter-failure rollback path can be unconditional.
      return;
    }
    if (record.state === 'committed') {
      // Already rolled back.
      return;
    }
    if (record.state !== 'consuming') {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `releaseConsumption requires CONSUMING; proposal ${JSON.stringify(proposalId)} ` +
          `is in ${JSON.stringify(record.state)}.`,
      });
    }
    this.records.set(proposalId, { ...record, state: 'committed' });
  }

  markConsumed(proposalId: string, args: { mediaBuyId: string }): void {
    // Back-compat shim: equivalent to tryReserveConsumption +
    // finalizeConsumption against a single-threaded write.
    this.evictExpired();
    const record = this.records.get(proposalId);
    if (!record) {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message: `Cannot markConsumed proposal ${JSON.stringify(proposalId)}: not in store.`,
      });
    }
    if (record.state === 'consumed') {
      if (record.mediaBuyId === args.mediaBuyId) return;
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `Proposal ${JSON.stringify(proposalId)} already consumed by ` +
          `media_buy_id=${JSON.stringify(record.mediaBuyId)}; cannot re-consume as ` +
          `${JSON.stringify(args.mediaBuyId)}.`,
      });
    }
    if (record.state !== 'committed') {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `Cannot markConsumed proposal ${JSON.stringify(proposalId)} from state ` +
          `${JSON.stringify(record.state)}; markConsumed requires COMMITTED.`,
      });
    }
    this.records.set(proposalId, {
      ...record,
      state: 'consumed',
      mediaBuyId: args.mediaBuyId,
    });
    this.mediaBuyIndex.set(this.mediaBuyKey(record.accountId, args.mediaBuyId), proposalId);
  }

  discard(proposalId: string): void {
    const record = this.records.get(proposalId);
    this.records.delete(proposalId);
    this.creationTimes.delete(proposalId);
    if (record?.mediaBuyId) {
      this.mediaBuyIndex.delete(this.mediaBuyKey(record.accountId, record.mediaBuyId));
    }
  }

  getByMediaBuyId(mediaBuyId: string, args: { expectedAccountId: string }): ProposalRecord<TRecipe> | null {
    this.evictExpired();
    const key = this.mediaBuyKey(args.expectedAccountId, mediaBuyId);
    const proposalId = this.mediaBuyIndex.get(key);
    if (!proposalId) return null;
    const record = this.records.get(proposalId);
    if (!record) {
      // Index drift — clean up.
      this.mediaBuyIndex.delete(key);
      return null;
    }
    return record;
  }
}
