import { createHash, randomUUID } from 'node:crypto';

import type {
  ReportingAdjustmentReceipt,
  ReportingMaterialization,
  ReportingReceipt,
  SyncReportingReceiptsResponse,
} from '../../types';
import { canonicalize } from '../../utils/jcs';
import { isReportingAdjustmentReceiptEvidence, isReportingReceiptEvidence } from '../evidence';
import type { ReportingPgPool } from './postgres';
import type {
  ReportingLedgerAdjustmentV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionV1,
  ReportingManagedDeliveryBindingV1,
  ReportingLedgerStore,
} from './types';
import { REPORTING_LEDGER_AUTHORITY } from './types';
import {
  adjustmentReceiptEvidenceMatches,
  receiptEvidenceMatches,
  type ReportingDestinationAuthorizationV1,
  type ReportingDestinationRevocationLeaseV1,
  type ReportingManagedDeliveryLeaseV1,
  type ReportingManagedDeliveryStore,
  type ReportingReceiptBatchEntryV1,
  type ReportingReceiptBatchInputV1,
} from './managed';

type QueryRow = Record<string, unknown>;
interface PgResult<Row extends QueryRow> {
  rows: Row[];
  rowCount: number | null;
}
interface PgClient {
  query<Row extends QueryRow = QueryRow>(sql: string, values?: unknown[]): Promise<PgResult<Row>>;
  release(error?: Error): void;
}

/**
 * Additive migration owned by #2944. It intentionally does not alter the Core
 * tables so the #2943 notification/activity bridge can evolve that schema
 * independently. Apply after REPORTING_LEDGER_MIGRATION in the same schema.
 */
export const REPORTING_MANAGED_DELIVERY_MIGRATION = `
CREATE TABLE IF NOT EXISTS adcp_reporting_destination_authorizations (
  account_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  generation BIGINT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  cleanup_completed_at TIMESTAMPTZ,
  cleanup_lease_owner TEXT,
  cleanup_lease_generation BIGINT NOT NULL DEFAULT 0,
  cleanup_lease_expires_at TIMESTAMPTZ,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  data JSONB NOT NULL,
  PRIMARY KEY (account_id, destination_ref, generation),
  CHECK (generation > 0),
  CHECK (revoked_at IS NULL OR revoked_at >= authorized_at)
);
ALTER TABLE adcp_reporting_destination_authorizations
  ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_destination_authorizations_current
  ON adcp_reporting_destination_authorizations (account_id, destination_ref)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_destination_authorizations_cleanup
  ON adcp_reporting_destination_authorizations (revoked_at, account_id, destination_ref)
  WHERE revoked_at IS NOT NULL AND cleanup_completed_at IS NULL;

CREATE TABLE IF NOT EXISTS adcp_reporting_managed_bindings (
  configuration_id TEXT PRIMARY KEY REFERENCES adcp_reporting_configurations(configuration_id),
  account_id TEXT NOT NULL,
  delivery_config_id TEXT NOT NULL,
  delivery_config_version INTEGER NOT NULL,
  destination_ref TEXT NOT NULL,
  authorization_generation BIGINT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (account_id, destination_ref, authorization_generation)
    REFERENCES adcp_reporting_destination_authorizations(account_id, destination_ref, generation),
  UNIQUE (account_id, delivery_config_id, delivery_config_version)
);

CREATE TABLE IF NOT EXISTS adcp_reporting_materializations (
  materialization_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  configuration_id TEXT NOT NULL REFERENCES adcp_reporting_managed_bindings(configuration_id),
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  revision_id TEXT NOT NULL REFERENCES adcp_reporting_revisions(revision_id),
  destination_ref TEXT NOT NULL,
  authorization_generation BIGINT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  UNIQUE (configuration_id, revision_id, attempt),
  CHECK (attempt > 0),
  CHECK (status IN ('pending', 'available', 'delivered', 'failed'))
);
CREATE INDEX IF NOT EXISTS adcp_reporting_materializations_claim
  ON adcp_reporting_materializations (created_at, materialization_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS adcp_reporting_materializations_obligation
  ON adcp_reporting_materializations (obligation_id, recorded_at, materialization_id);
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_materializations_success
  ON adcp_reporting_materializations (configuration_id, revision_id)
  WHERE status IN ('available', 'delivered');

CREATE TABLE IF NOT EXISTS adcp_reporting_receipts (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  reporting_receipt_id TEXT NOT NULL,
  receipt_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  supersedes_receipt_id TEXT,
  is_current BOOLEAN NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, reporting_receipt_id),
  CHECK (receipt_kind IN ('revision', 'adjustment'))
);
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_receipts_current
  ON adcp_reporting_receipts (account_id, consumer_id, receipt_kind, subject_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS adcp_reporting_receipts_readback
  ON adcp_reporting_receipts (account_id, consumer_id, recorded_at, reporting_receipt_id);

CREATE TABLE IF NOT EXISTS adcp_reporting_receipt_batches (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  results JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, idempotency_key)
);
`.trim();

const GENERIC_RECEIPT_MESSAGE = 'Receipt does not match authorized current reporting evidence';
const MAX_PLAN = 1_000;
const MAX_MATERIALIZATIONS_PER_ACCOUNT = 100_000;
const MAX_RECEIPT_BATCHES_PER_CONSUMER = 10_000;
const MAX_RECEIPTS_PER_CONSUMER = 100_000;
/** RC3 `maxItems` on `receipts` and on `adjustment_receipts`, applied separately. */
const MAX_RECEIPTS_PER_ARRAY = 100;
/** RC3 `maxItems` on the response `results` array. */
const MAX_RECEIPT_RESULTS = 100;
const MAX_MATERIALIZATION_ATTEMPTS = 5;
/**
 * Idempotent replay is a bounded guarantee, not an unbounded archive. Without a
 * retention bound a consumer that reached MAX_RECEIPT_BATCHES_PER_CONSUMER was
 * wedged out of receipt submission forever, and the per-key rows themselves
 * could hold 100 receipts of up to 64 KiB each. Mirrors the Core ledger's
 * 30-day CHECKPOINT_RETENTION_MS.
 */
const RECEIPT_BATCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Defence in depth on the compact replay row. The compact form is a few dozen
 * bytes per entry, so this can only trip if the shape regresses.
 */
const MAX_RECEIPT_BATCH_RESULT_BYTES = 64 * 1024;

/**
 * Compact, replay-sufficient record of one batch entry.
 *
 * The full receipt bodies are NOT duplicated here: `adcp_reporting_receipts` is
 * the durable source of truth and its rows are append-only, so a replay
 * rehydrates byte-identical bodies by id. Storing them twice made a single
 * idempotency key cost up to 6.4 MiB and the per-consumer cap worth ~64 GiB of
 * authenticated growth. Same shape the Core consumer-status batch cache uses.
 */
type StoredReceiptBatchResult = {
  kind: 'recorded' | 'unchanged' | 'failed';
  id: string;
  entry: ReportingReceiptBatchEntryV1['kind'];
  errorCode?: 'INVALID_REQUEST';
};

type StoredBatch = { results: StoredReceiptBatchResult[]; request_fingerprint: string };

export interface PostgresReportingManagedDeliveryStoreOptions {
  /**
   * The `automated_recovery_window_seconds` this deployment advertises.
   *
   * The capability is agent-wide and immutable once published, while bindings
   * arrive over time, so validating only at startup leaves the window open:
   * an agent advertising 60s starts clean and a 900s binding installed an hour
   * later silently makes the published promise false until the next restart.
   * Set here, `installBinding` refuses any Core configuration whose recovery
   * window exceeds the advertised bound, inside the same transaction that
   * checks binding eligibility. `createReportingManagedDeliveryRuntime` adopts
   * its own advertised value into the store at wiring time, so setting it
   * explicitly is only needed when bindings are installed without a runtime.
   */
  advertisedRecoveryWindowSeconds?: number;
  /**
   * The `status_retention_days` this deployment advertises.
   *
   * Supply it together with `evidenceRetentionDays` so the store can refuse a
   * retention shorter than a horizon you have already promised. Pruning
   * evidence the capability document still says is queryable is a broken
   * promise, not a capacity optimisation.
   */
  statusRetentionDays?: number;
  /**
   * Days of managed evidence an account is still accountable for.
   *
   * MAX_MATERIALIZATIONS_PER_ACCOUNT and MAX_RECEIPTS_PER_CONSUMER are
   * lifetime counts. Left unbounded they are a one-way door: a long-lived
   * account eventually reaches them and then stops planning materializations
   * and refuses every receipt, permanently, with no operator-visible way back
   * — evidence is immutable, so nothing ever frees capacity.
   *
   * Setting this makes the caps active-scope: only evidence recorded inside
   * the window counts against them, and `pruneExpiredEvidence` can delete what
   * falls outside it. Choose a value at least as long as the
   * `status_retention_days` you advertise, since that is the period you
   * promised the metadata stays queryable. Omit it to keep the previous
   * lifetime accounting with no pruning.
   */
  evidenceRetentionDays?: number;
}

export class PostgresReportingManagedDeliveryStore implements ReportingManagedDeliveryStore {
  private readonly evidenceRetentionDays: number | undefined;
  private readonly statusRetentionDays: number | undefined;
  private advertisedRecoveryWindowSeconds: number | undefined;

  /**
   * Records the agent-wide advertised recovery window so later binding
   * installs are held to it. Idempotent for the same value; a disagreement is
   * refused rather than silently taking the newer one, because two runtimes
   * publishing different windows over one store cannot both be honoured.
   */
  adoptAdvertisedRecoveryWindowSeconds(seconds: number): void {
    nonnegativeSafeInteger(seconds, 'automatedRecoveryWindowSeconds');
    if (this.advertisedRecoveryWindowSeconds !== undefined && this.advertisedRecoveryWindowSeconds !== seconds) {
      throw new Error(
        `Managed store is already bound to an advertised recovery window of ` +
          `${this.advertisedRecoveryWindowSeconds}s and cannot also advertise ${seconds}s`
      );
    }
    this.advertisedRecoveryWindowSeconds = seconds;
  }

  constructor(
    private readonly pool: ReportingPgPool,
    options: PostgresReportingManagedDeliveryStoreOptions = {}
  ) {
    if (options.statusRetentionDays !== undefined) positiveInteger(options.statusRetentionDays, 'statusRetentionDays');
    if (options.evidenceRetentionDays !== undefined) {
      positiveInteger(options.evidenceRetentionDays, 'evidenceRetentionDays');
      // Retention has a floor, not just a value. Idempotent receipt replay is
      // promised for RECEIPT_BATCH_RETENTION_MS, and `status_retention_days`
      // is promised on the wire, so evidence may only age out behind both —
      // otherwise pruning silently breaks a replay or a horizon the capability
      // document still advertises.
      const replayFloorDays = Math.ceil(RECEIPT_BATCH_RETENTION_MS / 86_400_000);
      if (options.evidenceRetentionDays < replayFloorDays) {
        throw new RangeError(
          `evidenceRetentionDays must be at least the ${replayFloorDays}-day receipt replay retention`
        );
      }
      if (options.statusRetentionDays !== undefined && options.evidenceRetentionDays < options.statusRetentionDays) {
        throw new RangeError(
          `evidenceRetentionDays must be at least the advertised statusRetentionDays ` +
            `(${options.statusRetentionDays}); pruning inside an advertised horizon breaks it`
        );
      }
    }
    if (options.advertisedRecoveryWindowSeconds !== undefined) {
      nonnegativeSafeInteger(options.advertisedRecoveryWindowSeconds, 'advertisedRecoveryWindowSeconds');
      this.advertisedRecoveryWindowSeconds = options.advertisedRecoveryWindowSeconds;
    }
    this.statusRetentionDays = options.statusRetentionDays;
    this.evidenceRetentionDays = options.evidenceRetentionDays;
  }

  /** SQL fragment scoping a count to the active retention window, if one is set. */
  private activeScope(column: string): string {
    return this.evidenceRetentionDays === undefined
      ? ''
      : ` AND ${column} >= clock_timestamp() - (${this.evidenceRetentionDays}::bigint * INTERVAL '1 day')`;
  }

  /**
   * Deletes managed evidence that has aged out of `evidenceRetentionDays`.
   *
   * Only ever removes evidence the deployment no longer promises: nothing
   * inside the retention window, nothing still `pending` or leased, and no
   * receipt batch inside its own replay retention. Immutable evidence stays
   * immutable while it is retained — this frees capacity at the far end of the
   * window rather than rewriting anything. Returns what it removed so a
   * scheduler can page through with `limit`.
   */
  async pruneExpiredEvidence(input: {
    account_id: string;
    limit?: number;
  }): Promise<{ materializations: number; receipts: number; batches: number }> {
    if (this.evidenceRetentionDays === undefined) {
      throw new Error('pruneExpiredEvidence requires PostgresReportingManagedDeliveryStore({ evidenceRetentionDays })');
    }
    const limit = input.limit ?? 1_000;
    positiveInteger(limit, 'limit');
    const days = this.evidenceRetentionDays;
    return this.transaction(async client => {
      await advisoryLock(client, accountLock(input.account_id));
      // Batches first, so a replay row that has itself expired stops pinning
      // the receipts it names before those receipts are considered.
      const batches = await client.query(
        `DELETE FROM adcp_reporting_receipt_batches
          WHERE account_id = $1
            AND recorded_at < clock_timestamp() - ($2::bigint * INTERVAL '1 millisecond')`,
        [input.account_id, RECEIPT_BATCH_RETENTION_MS]
      );
      // A receipt may be older than the batch that replays it — a later key
      // can name an earlier receipt, and `unchanged` results do exactly that —
      // so age alone is not sufficient. Keep any receipt a surviving replay row
      // still references, or that replay would rehydrate a body that no longer
      // exists and answer a repeated key with a spurious failure.
      const receipts = await client.query(
        `DELETE FROM adcp_reporting_receipts target
          WHERE (target.account_id, target.consumer_id, target.reporting_receipt_id) IN (
            SELECT receipt.account_id, receipt.consumer_id, receipt.reporting_receipt_id
              FROM adcp_reporting_receipts receipt
             WHERE receipt.account_id = $1
               AND receipt.recorded_at < clock_timestamp() - ($2::bigint * INTERVAL '1 day')
               AND NOT EXISTS (
                 SELECT 1 FROM adcp_reporting_receipt_batches batch
                  WHERE batch.account_id = receipt.account_id
                    AND batch.consumer_id = receipt.consumer_id
                    AND batch.results @> jsonb_build_array(
                          jsonb_build_object('id', receipt.reporting_receipt_id))
               )
             ORDER BY receipt.recorded_at LIMIT $3)`,
        [input.account_id, days, limit]
      );
      // Never drop a materialization whose resource is still readable, nor one
      // a retained receipt names as its evidence: both are horizons this
      // deployment is still advertising.
      const materializations = await client.query(
        `DELETE FROM adcp_reporting_materializations target
          WHERE target.materialization_id IN (
            SELECT materialization.materialization_id
              FROM adcp_reporting_materializations materialization
             WHERE materialization.account_id = $1
               AND materialization.recorded_at < clock_timestamp() - ($2::bigint * INTERVAL '1 day')
               AND materialization.status <> 'pending'
               AND materialization.lease_owner IS NULL
               AND COALESCE(
                     (materialization.data -> 'resource' ->> 'expires_at')::timestamptz <= clock_timestamp(),
                     true)
               AND NOT EXISTS (
                 SELECT 1 FROM adcp_reporting_receipts receipt
                  WHERE receipt.account_id = materialization.account_id
                    AND receipt.data ->> 'reporting_materialization_id' = materialization.materialization_id
               )
             ORDER BY materialization.recorded_at LIMIT $3)`,
        [input.account_id, days, limit]
      );
      return {
        materializations: materializations.rowCount ?? 0,
        receipts: receipts.rowCount ?? 0,
        batches: batches.rowCount ?? 0,
      };
    });
  }

  async probe(coreStore: ReportingLedgerStore): Promise<boolean> {
    const authority = coreStore[REPORTING_LEDGER_AUTHORITY];
    if (!authority) {
      throw new Error('Managed reporting requires a Core store that exposes REPORTING_LEDGER_AUTHORITY');
    }
    if (authority.substrate !== this.pool) {
      throw new Error('Managed reporting Core and add-on stores must share the same PostgreSQL pool');
    }
    if (authority.managedDelivery !== true) {
      throw new Error('Managed reporting requires PostgresReportingLedgerStore({ managedDelivery: true })');
    }
    const result = await this.query<QueryRow & { ready: boolean }>(
      `SELECT to_regclass('adcp_reporting_managed_bindings') IS NOT NULL
          AND to_regclass('adcp_reporting_materializations') IS NOT NULL
          AND to_regclass('adcp_reporting_receipts') IS NOT NULL AS ready`
    );
    if (result.rows[0]?.ready !== true) {
      throw new Error(
        'Managed reporting schema is unavailable; apply REPORTING_MANAGED_DELIVERY_MIGRATION after REPORTING_LEDGER_MIGRATION'
      );
    }
    return true;
  }

  async listInstalledRecoveryWindowSeconds(): Promise<number[]> {
    const result = await this.query<QueryRow & { milliseconds: string }>(
      `SELECT DISTINCT configuration.data->'schedule'->>'recoveryWindowMilliseconds' AS milliseconds
         FROM adcp_reporting_managed_bindings binding
         JOIN adcp_reporting_configurations configuration
           ON configuration.configuration_id = binding.configuration_id
        ORDER BY milliseconds`
    );
    return result.rows.map(row => {
      const milliseconds = Number(row.milliseconds);
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new Error('Installed managed Core recovery windows must be non-negative');
      }
      // Core permits any positive integer of milliseconds, and configuration
      // generations are immutable, so a sub-second window already in the
      // database cannot be corrected. Round up to the whole second the
      // capability is expressed in: ceiling keeps the advertised bound at or
      // above the real one, which is the safe direction for a maximum.
      return Math.ceil(milliseconds / 1_000);
    });
  }

  async authorizeDestination(
    input: Omit<ReportingDestinationAuthorizationV1, 'revoked_at' | 'cleanup_completed_at'>
  ): Promise<void> {
    positiveInteger(input.generation, 'generation');
    await this.transaction(async client => {
      await advisoryLock(client, accountLock(input.account_id));
      await advisoryLock(client, authLock(input.account_id, input.destination_ref));
      const current = await client.query<QueryRow & { generation: string }>(
        `SELECT generation::text FROM adcp_reporting_destination_authorizations
          WHERE account_id = $1 AND destination_ref = $2 AND revoked_at IS NULL`,
        [input.account_id, input.destination_ref]
      );
      if (current.rowCount) {
        if (Number(current.rows[0]!.generation) === input.generation) return;
        throw new Error('A destination authorization generation is already current');
      }
      const latest = await client.query<QueryRow & { generation: string | null }>(
        `SELECT MAX(generation)::text AS generation FROM adcp_reporting_destination_authorizations
          WHERE account_id = $1 AND destination_ref = $2`,
        [input.account_id, input.destination_ref]
      );
      if (input.generation <= Number(latest.rows[0]?.generation ?? 0)) {
        throw new Error('Destination authorization generation must increase after revocation');
      }
      await client.query(
        `INSERT INTO adcp_reporting_destination_authorizations
          (account_id, destination_ref, generation, authorized_at, data)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [input.account_id, input.destination_ref, input.generation, input.authorized_at, JSON.stringify(input)]
      );
    });
  }

  async revokeDestination(input: {
    account_id: string;
    destination_ref: string;
    generation: number;
    revoked_at: string;
  }): Promise<boolean> {
    return this.transaction(async client => {
      await advisoryLock(client, accountLock(input.account_id));
      await advisoryLock(client, authLock(input.account_id, input.destination_ref));
      const updated = await client.query(
        `UPDATE adcp_reporting_destination_authorizations
            SET revoked_at = $4::timestamptz,
                changed_at = clock_timestamp(),
                data = data || jsonb_build_object('revoked_at', $4::text)
          WHERE account_id = $1 AND destination_ref = $2 AND generation = $3
            AND revoked_at IS NULL`,
        [input.account_id, input.destination_ref, input.generation, input.revoked_at]
      );
      await client.query(
        `UPDATE adcp_reporting_materializations SET
            status = 'failed',
            data = data || jsonb_build_object(
              'status', 'failed', 'failed_at', $4::text, 'failure_code', 'AUTHORIZATION_REVOKED'
            ),
            changed_at = clock_timestamp(), lease_owner = NULL, lease_expires_at = NULL
          WHERE account_id = $1 AND destination_ref = $2 AND authorization_generation = $3
            AND status = 'pending'`,
        [input.account_id, input.destination_ref, input.generation, input.revoked_at]
      );
      return updated.rowCount === 1;
    });
  }

  async installBinding(binding: ReportingManagedDeliveryBindingV1): Promise<{ inserted: boolean }> {
    positiveInteger(binding.resource_retention_days, 'resource_retention_days');
    if (binding.reconciliation_mode === 'consumer_receipt' && binding.verification_profile !== 'canonical_digest') {
      throw new Error('Reconciled Billing bindings require canonical-digest verification');
    }
    // Recompute before anything compares it. The replay branch used to trust the
    // caller's `semantic_fingerprint`, so changed binding content carrying a
    // copied-over old fingerprint was accepted as an idempotent replay and the
    // immutable binding silently meant something else than the stored row.
    const expectedFingerprint = managedBindingFingerprint(binding);
    if (binding.semantic_fingerprint !== expectedFingerprint) {
      throw new Error('Managed binding semantic fingerprint does not match its immutable content');
    }
    return this.transaction(async client => {
      await advisoryLock(client, accountLock(binding.account_id));
      await advisoryLock(client, `adcp-reporting-binding:${binding.account_id}:${binding.delivery_config_id}`);
      const existing = await client.query<QueryRow & { semantic_fingerprint: string }>(
        'SELECT semantic_fingerprint FROM adcp_reporting_managed_bindings WHERE configuration_id = $1',
        [binding.configurationId]
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.semantic_fingerprint !== expectedFingerprint) {
          throw new Error('Immutable managed binding identity names different content');
        }
        return { inserted: false };
      }
      const eligible = await client.query<
        QueryRow & {
          configuration: {
            feedPurpose?: string;
            canonicalization?: unknown;
            schedule?: { recoveryWindowMilliseconds?: number };
          };
        }
      >(
        `SELECT configuration.data AS configuration FROM adcp_reporting_configurations configuration
          JOIN adcp_reporting_destination_authorizations authz
            ON authz.account_id = $2 AND authz.destination_ref = $5
           AND authz.generation = $6 AND authz.revoked_at IS NULL
         WHERE configuration.configuration_id = $1 AND configuration.account_id = $2
           AND configuration.delivery_config_id = $3 AND configuration.delivery_config_version = $4
           AND NOT EXISTS (
             SELECT 1 FROM adcp_reporting_obligations obligation
              WHERE obligation.configuration_id = configuration.configuration_id
           )`,
        [
          binding.configurationId,
          binding.account_id,
          binding.delivery_config_id,
          binding.delivery_config_version,
          binding.destination_ref,
          binding.authorization_generation,
        ]
      );
      if (!eligible.rowCount) throw new Error('Managed binding is not authorized for the exact Core configuration');
      const configuration = eligible.rows[0]!.configuration;
      // Same bound the runtime checks at startup, applied on the authoritative
      // write path so a binding installed after start — or concurrently with
      // another install — cannot widen the deployment past what is published.
      // Both installs serialize on the per-configuration advisory lock taken
      // above, so neither can observe the other half-applied.
      if (this.advertisedRecoveryWindowSeconds !== undefined) {
        const windowMilliseconds = Number(configuration.schedule?.recoveryWindowMilliseconds);
        if (!Number.isFinite(windowMilliseconds) || windowMilliseconds < 0) {
          throw new Error('Managed binding Core configuration has no usable recovery window');
        }
        const windowSeconds = Math.ceil(windowMilliseconds / 1_000);
        if (windowSeconds > this.advertisedRecoveryWindowSeconds) {
          throw new Error(
            `Managed binding Core recovery window is ${windowSeconds}s but this agent advertises ` +
              `automated_recovery_window_seconds ${this.advertisedRecoveryWindowSeconds}s; installing it would ` +
              `publish a recovery bound the deployment does not keep`
          );
        }
      }
      if (configuration.feedPurpose !== binding.feed_purpose) {
        throw new Error('Managed binding feed purpose differs from the exact Core configuration');
      }
      if (binding.reconciliation_mode === 'consumer_receipt' && !configuration.canonicalization) {
        throw new Error('Reconciled Billing requires a Core configuration with pinned canonicalization');
      }
      const inserted = await client.query<QueryRow & { semantic_fingerprint: string }>(
        `INSERT INTO adcp_reporting_managed_bindings
          (configuration_id, account_id, delivery_config_id, delivery_config_version,
           destination_ref, authorization_generation, semantic_fingerprint, data, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT DO NOTHING RETURNING semantic_fingerprint`,
        [
          binding.configurationId,
          binding.account_id,
          binding.delivery_config_id,
          binding.delivery_config_version,
          binding.destination_ref,
          binding.authorization_generation,
          binding.semantic_fingerprint,
          JSON.stringify(binding),
          binding.created_at,
        ]
      );
      if (!inserted.rowCount) {
        const raced = await client.query<QueryRow & { semantic_fingerprint: string }>(
          'SELECT semantic_fingerprint FROM adcp_reporting_managed_bindings WHERE configuration_id = $1',
          [binding.configurationId]
        );
        if (raced.rows[0]?.semantic_fingerprint !== binding.semantic_fingerprint) {
          throw new Error('Immutable managed binding identity names different content');
        }
      }
      return { inserted: inserted.rowCount === 1 };
    });
  }

  async planMaterializations(input: { account_id?: string; limit?: number } = {}): Promise<number> {
    const limit = input.limit ?? MAX_PLAN;
    positiveInteger(limit, 'limit');
    if (limit > MAX_PLAN) throw new RangeError(`limit must not exceed ${MAX_PLAN}`);
    if (!input.account_id) {
      const accounts = await this.query<QueryRow & { account_id: string }>(
        'SELECT DISTINCT account_id FROM adcp_reporting_managed_bindings ORDER BY account_id'
      );
      let planned = 0;
      for (const { account_id } of accounts.rows) {
        if (planned >= limit) break;
        planned += await this.planMaterializations({ account_id, limit: limit - planned });
      }
      return planned;
    }
    return this.transaction(async client => {
      const accounts = await client.query<QueryRow & { account_id: string }>(
        `SELECT DISTINCT account_id FROM adcp_reporting_managed_bindings
          WHERE ($1::text IS NULL OR account_id = $1) ORDER BY account_id`,
        [input.account_id ?? null]
      );
      for (const { account_id } of accounts.rows) await advisoryLock(client, accountLock(account_id));
      const capacity = await client.query<QueryRow & { account_id: string; count: string }>(
        `SELECT account_id, COUNT(*)::text AS count FROM adcp_reporting_materializations
          WHERE ($1::text IS NULL OR account_id = $1)${this.activeScope('recorded_at')} GROUP BY account_id`,
        [input.account_id ?? null]
      );
      const remainingByAccount = new Map(
        accounts.rows.map(({ account_id }) => [
          account_id,
          MAX_MATERIALIZATIONS_PER_ACCOUNT -
            Number(capacity.rows.find(value => value.account_id === account_id)?.count ?? 0),
        ])
      );
      const candidates = await client.query<
        QueryRow & {
          binding: ReportingManagedDeliveryBindingV1;
          obligation: ReportingLedgerObligationV1;
          revision: ReportingLedgerRevisionV1;
          attempt: number;
        }
      >(
        `SELECT binding.data AS binding, obligation.data AS obligation, revision.data AS revision,
                COALESCE(MAX(existing.attempt), 0)::integer + 1 AS attempt
           FROM adcp_reporting_managed_bindings binding
           JOIN adcp_reporting_destination_authorizations authz
             ON authz.account_id = binding.account_id
            AND authz.destination_ref = binding.destination_ref
            AND authz.generation = binding.authorization_generation
            AND authz.revoked_at IS NULL
           JOIN adcp_reporting_obligations obligation ON obligation.configuration_id = binding.configuration_id
           JOIN adcp_reporting_revisions revision ON revision.obligation_id = obligation.obligation_id
      LEFT JOIN adcp_reporting_materializations existing
             ON existing.configuration_id = binding.configuration_id AND existing.revision_id = revision.revision_id
          WHERE ($1::text IS NULL OR binding.account_id = $1)
          GROUP BY binding.configuration_id, binding.data, obligation.obligation_id, obligation.data,
                   revision.revision_id, revision.data
         HAVING NOT COALESCE(BOOL_OR(existing.status IN ('pending','available','delivered')), false)
            AND COALESCE(MAX(existing.attempt), 0) < ${MAX_MATERIALIZATION_ATTEMPTS}
          ORDER BY MIN(revision.recorded_at), revision.revision_id
          LIMIT $2`,
        [input.account_id ?? null, limit]
      );
      let planned = 0;
      for (const candidate of candidates.rows) {
        const binding = candidate.binding;
        const remaining = remainingByAccount.get(binding.account_id) ?? 0;
        if (remaining <= 0) continue;
        const obligation = candidate.obligation;
        const revision = candidate.revision;
        const created_at = new Date().toISOString();
        const materialization: ReportingMaterialization = {
          reporting_materialization_id: `rmat_${randomUUID()}`,
          reporting_revision_id: revision.reporting_revision_id,
          reporting_obligation_id: obligation.reporting_obligation_id,
          delivery_config_id: binding.delivery_config_id,
          delivery_config_version: binding.delivery_config_version,
          destination_ref: binding.destination_ref,
          feed_purpose: binding.feed_purpose,
          method: binding.method,
          ...(binding.transport ? { transport: binding.transport } : {}),
          attempt: candidate.attempt,
          status: 'pending',
          created_at,
        };
        const inserted = await client.query(
          `INSERT INTO adcp_reporting_materializations
            (materialization_id, account_id, configuration_id, obligation_id, revision_id,
             destination_ref, authorization_generation, attempt, status, data, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9::jsonb,$10)
           ON CONFLICT DO NOTHING`,
          [
            materialization.reporting_materialization_id,
            binding.account_id,
            binding.configurationId,
            obligation.reporting_obligation_id,
            revision.reporting_revision_id,
            binding.destination_ref,
            binding.authorization_generation,
            candidate.attempt,
            JSON.stringify(materialization),
            created_at,
          ]
        );
        planned += inserted.rowCount ?? 0;
        if (inserted.rowCount) remainingByAccount.set(binding.account_id, remaining - 1);
      }
      return planned;
    });
  }

  async claimMaterialization(input: {
    owner: string;
    now: string;
    lease_milliseconds: number;
    account_id?: string;
  }): Promise<ReportingManagedDeliveryLeaseV1 | null> {
    positiveInteger(input.lease_milliseconds, 'lease_milliseconds');
    return this.transaction(async client => {
      const selected = await client.query<
        QueryRow & {
          materialization_id: string;
          generation: string;
          expires_at: Date;
          materialization: ReportingMaterialization;
          binding: ReportingManagedDeliveryBindingV1;
          obligation: ReportingLedgerObligationV1;
          revision: ReportingLedgerRevisionV1;
        }
      >(
        `WITH candidate AS (
           SELECT materialization.materialization_id
             FROM adcp_reporting_materializations materialization
             JOIN adcp_reporting_destination_authorizations authz
               ON authz.account_id = materialization.account_id
              AND authz.destination_ref = materialization.destination_ref
              AND authz.generation = materialization.authorization_generation
              AND authz.revoked_at IS NULL
            WHERE materialization.status = 'pending'
              AND ($1::text IS NULL OR materialization.account_id = $1)
              -- One authoritative clock. settleMaterialization fences on
              -- clock_timestamp(), so issuing the lease from the caller's clock
              -- made ordinary NTP drift fatal: the claim succeeded, the settle
              -- matched zero rows, and the row stayed 'pending' at attempt 1
              -- where the planner's HAVING cannot see it — so the attempt cap
              -- never engaged and the adapter was asked to deliver again, and
              -- again, with no bound.
              AND (materialization.lease_expires_at IS NULL OR materialization.lease_expires_at <= clock_timestamp())
            ORDER BY materialization.created_at, materialization.materialization_id
            FOR UPDATE OF materialization SKIP LOCKED LIMIT 1
         ), claimed AS (
           UPDATE adcp_reporting_materializations materialization
              SET lease_owner = $2, lease_generation = lease_generation + 1,
                  lease_expires_at = clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond')
             FROM candidate WHERE materialization.materialization_id = candidate.materialization_id
         RETURNING materialization.*
         )
         SELECT claimed.materialization_id, claimed.lease_generation::text AS generation,
                claimed.lease_expires_at AS expires_at, claimed.data AS materialization,
                binding.data AS binding, obligation.data AS obligation, revision.data AS revision
           FROM claimed
           JOIN adcp_reporting_managed_bindings binding ON binding.configuration_id = claimed.configuration_id
           JOIN adcp_reporting_obligations obligation ON obligation.obligation_id = claimed.obligation_id
           JOIN adcp_reporting_revisions revision ON revision.revision_id = claimed.revision_id`,
        [input.account_id ?? null, input.owner, input.lease_milliseconds]
      );
      const row = selected.rows[0];
      if (!row) return null;
      return {
        materialization: structuredClone(row.materialization),
        binding: structuredClone(row.binding),
        obligation: structuredClone(row.obligation),
        revision: structuredClone(row.revision),
        owner: input.owner,
        generation: Number(row.generation),
        expires_at: row.expires_at.toISOString(),
      };
    });
  }

  async settleMaterialization(input: {
    lease: ReportingManagedDeliveryLeaseV1;
    now: string;
    outcome:
      | {
          status: 'available' | 'delivered';
          resource: NonNullable<ReportingMaterialization['resource']>;
          verification: NonNullable<ReportingMaterialization['verification']>;
        }
      | { status: 'failed'; failure_code: string };
  }): Promise<boolean> {
    return this.transaction(async client => {
      const { lease } = input;
      await advisoryLock(client, accountLock(lease.binding.account_id));
      const authorized = await client.query(
        `SELECT 1 FROM adcp_reporting_destination_authorizations
          WHERE account_id = $1 AND destination_ref = $2 AND generation = $3 AND revoked_at IS NULL`,
        [lease.binding.account_id, lease.binding.destination_ref, lease.binding.authorization_generation]
      );
      const outcome = authorized.rowCount
        ? input.outcome
        : { status: 'failed' as const, failure_code: 'AUTHORIZATION_REVOKED' };
      const materialization: ReportingMaterialization = {
        ...lease.materialization,
        status: outcome.status,
        ...(outcome.status === 'failed'
          ? { failed_at: input.now, failure_code: outcome.failure_code }
          : { ready_at: input.now, resource: outcome.resource, verification: outcome.verification }),
      };
      const updated = await client.query(
        `UPDATE adcp_reporting_materializations SET status = $5, data = $6::jsonb,
             changed_at = clock_timestamp(), lease_owner = NULL, lease_expires_at = NULL
          WHERE materialization_id = $1 AND lease_owner = $2 AND lease_generation = $3
            AND lease_expires_at > clock_timestamp() AND status = 'pending' AND authorization_generation = $4`,
        [
          lease.materialization.reporting_materialization_id,
          lease.owner,
          lease.generation,
          lease.binding.authorization_generation,
          outcome.status,
          JSON.stringify(materialization),
        ]
      );
      return updated.rowCount === 1 && authorized.rowCount === 1 && outcome.status !== 'failed';
    });
  }

  async claimRevocation(input: {
    owner: string;
    now: string;
    lease_milliseconds: number;
    account_id?: string;
  }): Promise<ReportingDestinationRevocationLeaseV1 | null> {
    positiveInteger(input.lease_milliseconds, 'lease_milliseconds');
    return this.transaction(async client => {
      const result = await client.query<
        QueryRow & { data: ReportingDestinationAuthorizationV1; generation: string; expires_at: Date }
      >(
        `WITH candidate AS (
           SELECT account_id, destination_ref, generation
             FROM adcp_reporting_destination_authorizations
            WHERE revoked_at IS NOT NULL AND cleanup_completed_at IS NULL
              -- Same single-clock rule as claimMaterialization: completeRevocation
              -- fences on clock_timestamp(), so the lease must be issued from it
              -- too or cleanup can never commit and the grant is never torn down.
              AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= clock_timestamp())
              AND ($3::text IS NULL OR account_id = $3)
            ORDER BY cleanup_lease_generation, revoked_at, account_id, destination_ref
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE adcp_reporting_destination_authorizations target SET
           cleanup_lease_owner = $1, cleanup_lease_generation = target.cleanup_lease_generation + 1,
           cleanup_lease_expires_at = clock_timestamp() + ($2::bigint * INTERVAL '1 millisecond')
          FROM candidate
         WHERE target.account_id = candidate.account_id AND target.destination_ref = candidate.destination_ref
           AND target.generation = candidate.generation
         RETURNING target.data, target.cleanup_lease_generation::text AS generation,
                   target.cleanup_lease_expires_at AS expires_at`,
        [input.owner, input.lease_milliseconds, input.account_id ?? null]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        authorization: structuredClone(row.data),
        owner: input.owner,
        generation: Number(row.generation),
        expires_at: row.expires_at.toISOString(),
      };
    });
  }

  async completeRevocation(input: {
    lease: ReportingDestinationRevocationLeaseV1;
    completed_at: string;
  }): Promise<boolean> {
    const result = await this.query(
      `UPDATE adcp_reporting_destination_authorizations SET cleanup_completed_at = $6::timestamptz,
          cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL,
          data = data || jsonb_build_object('cleanup_completed_at', $6::text)
        WHERE account_id = $1 AND destination_ref = $2 AND generation = $3
          AND cleanup_lease_owner = $4 AND cleanup_lease_generation = $5
          AND cleanup_lease_expires_at > clock_timestamp()
          AND revoked_at IS NOT NULL AND cleanup_completed_at IS NULL`,
      [
        input.lease.authorization.account_id,
        input.lease.authorization.destination_ref,
        input.lease.authorization.generation,
        input.lease.owner,
        input.lease.generation,
        input.completed_at,
      ]
    );
    return result.rowCount === 1;
  }

  async releaseRevocation(input: { lease: ReportingDestinationRevocationLeaseV1 }): Promise<boolean> {
    const result = await this.query(
      `UPDATE adcp_reporting_destination_authorizations
          SET cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL
        WHERE account_id = $1 AND destination_ref = $2 AND generation = $3
          AND cleanup_lease_owner = $4 AND cleanup_lease_generation = $5
          AND cleanup_completed_at IS NULL`,
      [
        input.lease.authorization.account_id,
        input.lease.authorization.destination_ref,
        input.lease.authorization.generation,
        input.lease.owner,
        input.lease.generation,
      ]
    );
    return result.rowCount === 1;
  }

  async getReadableResource(input: { account_id: string; resource_ref: string }) {
    const result = await this.query<
      QueryRow & { materialization: ReportingMaterialization; binding: ReportingManagedDeliveryBindingV1 }
    >(
      `SELECT materialization.data AS materialization, binding.data AS binding
         FROM adcp_reporting_materializations materialization
         JOIN adcp_reporting_managed_bindings binding ON binding.configuration_id = materialization.configuration_id
         JOIN adcp_reporting_destination_authorizations authz
           ON authz.account_id = materialization.account_id
          AND authz.destination_ref = materialization.destination_ref
          AND authz.generation = materialization.authorization_generation
          AND authz.revoked_at IS NULL
        WHERE materialization.account_id = $1
          AND materialization.status IN ('available','delivered')
          AND materialization.data->'resource'->>'resource_ref' = $2
          AND (materialization.data->'resource'->>'expires_at')::timestamptz > clock_timestamp()`,
      [input.account_id, input.resource_ref]
    );
    const row = result.rows[0];
    return row
      ? { materialization: structuredClone(row.materialization), binding: structuredClone(row.binding) }
      : null;
  }

  async isAuthorizationCurrent(input: { account_id: string; destination_ref: string; generation: number }) {
    const result = await this.query(
      `SELECT 1 FROM adcp_reporting_destination_authorizations
        WHERE account_id = $1 AND destination_ref = $2 AND generation = $3 AND revoked_at IS NULL`,
      [input.account_id, input.destination_ref, input.generation]
    );
    return result.rowCount === 1;
  }

  async syncReceiptBatch(input: ReportingReceiptBatchInputV1): Promise<SyncReportingReceiptsResponse['results']> {
    // Mirrors the handler's RC3 caps for callers that drive the store directly:
    // each kind is capped independently at its own `maxItems`, and the batch as
    // a whole at the response `results` cap.
    const revisionCount = input.entries.filter(entry => entry.kind === 'revision').length;
    if (
      !/^[A-Za-z0-9_.:-]{16,255}$/.test(input.idempotency_key) ||
      input.entries.length < 1 ||
      input.entries.length > MAX_RECEIPT_RESULTS ||
      revisionCount > MAX_RECEIPTS_PER_ARRAY ||
      input.entries.length - revisionCount > MAX_RECEIPTS_PER_ARRAY ||
      input.entries.some(
        entry =>
          (entry.kind === 'revision'
            ? !isReportingReceiptEvidence(entry.receipt)
            : !isReportingAdjustmentReceiptEvidence(entry.receipt)) ||
          Buffer.byteLength(JSON.stringify(entry.receipt), 'utf8') > 64 * 1024
      )
    ) {
      throw new Error('Reporting receipt transaction failed');
    }
    return this.transaction(async client => {
      await advisoryLock(client, accountLock(input.account_id));
      await advisoryLock(client, `adcp-reporting-receipts:${input.account_id}:${input.consumer_id}`);
      // One authoritative instant for the whole batch, taken from the database
      // rather than the caller. `input.received_at` comes from the handler's
      // host clock, and durable receipt state is ordered and cut off by
      // `recorded_at`, which is a database clock_timestamp() — so trusting the
      // caller made a skewed host publish a `received_at` that disagreed with
      // the order and the visibility cutoff its own receipt was subject to.
      const instant = (await client.query<QueryRow & { now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const receivedAt = instant.toISOString();
      const authorization = await Promise.all(
        input.entries.map(entry => this.loadReceiptEvidence(client, input.account_id, entry).then(Boolean))
      );
      const prior = await client.query<QueryRow & StoredBatch>(
        `SELECT request_fingerprint, results FROM adcp_reporting_receipt_batches
          WHERE account_id = $1 AND consumer_id = $2 AND idempotency_key = $3`,
        [input.account_id, input.consumer_id, input.idempotency_key]
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_fingerprint !== input.request_fingerprint) {
          return input.entries.map(entry => idempotencyConflict(entry.receipt.reporting_receipt_id));
        }
        return this.replayReceiptBatch(client, input, prior.rows[0].results);
      }
      // Age the replay cache out before measuring it, so reaching the cap is a
      // throttle on burst rather than a permanent lockout that would surface as
      // a misleading evidence-mismatch on every later batch. Scoped to this
      // caller's own rows: one consumer can never prune another's.
      await client.query(
        `DELETE FROM adcp_reporting_receipt_batches
          WHERE account_id = $1 AND consumer_id = $2
            AND recorded_at < clock_timestamp() - ($3::bigint * INTERVAL '1 millisecond')`,
        [input.account_id, input.consumer_id, RECEIPT_BATCH_RETENTION_MS]
      );
      const capacity = await client.query<QueryRow & { batches: string; receipts: string }>(
        `SELECT
           (SELECT COUNT(*) FROM adcp_reporting_receipt_batches
             WHERE account_id = $1 AND consumer_id = $2)::text AS batches,
           (SELECT COUNT(*) FROM adcp_reporting_receipts
             WHERE account_id = $1 AND consumer_id = $2${this.activeScope('recorded_at')})::text AS receipts`,
        [input.account_id, input.consumer_id]
      );
      if (Number(capacity.rows[0]?.batches ?? 0) >= MAX_RECEIPT_BATCHES_PER_CONSUMER) {
        return input.entries.map(entry => failed(entry.receipt.reporting_receipt_id));
      }
      let remainingReceipts = MAX_RECEIPTS_PER_CONSUMER - Number(capacity.rows[0]?.receipts ?? 0);
      const duplicateIds = duplicates(input.entries.map(entry => entry.receipt.reporting_receipt_id));
      const duplicateSubjects = duplicates(input.entries.map(entry => subjectKey(entry)));
      const results: SyncReportingReceiptsResponse['results'] = [];
      for (const [index, entry] of input.entries.entries()) {
        if (
          !authorization[index] ||
          remainingReceipts <= 0 ||
          duplicateIds.has(entry.receipt.reporting_receipt_id) ||
          duplicateSubjects.has(subjectKey(entry))
        ) {
          results.push(failed(entry.receipt.reporting_receipt_id));
          continue;
        }
        const result = await this.recordReceipt(client, input, entry, receivedAt);
        results.push(result);
        if (result.result === 'recorded') remainingReceipts -= 1;
      }
      const stored: StoredReceiptBatchResult[] = results.map((result, index) => ({
        kind: result.result,
        id: receiptResultId(result, input.entries[index]!),
        entry: input.entries[index]!.kind,
        ...(result.result === 'failed' ? { errorCode: 'INVALID_REQUEST' as const } : {}),
      }));
      const storedJson = JSON.stringify(stored);
      if (Buffer.byteLength(storedJson, 'utf8') > MAX_RECEIPT_BATCH_RESULT_BYTES) {
        throw new Error('Reporting receipt batch replay record exceeds its byte budget');
      }
      await client.query(
        `INSERT INTO adcp_reporting_receipt_batches
          (account_id, consumer_id, idempotency_key, request_fingerprint, results)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [input.account_id, input.consumer_id, input.idempotency_key, input.request_fingerprint, storedJson]
      );
      return results;
    });
  }

  /**
   * Rebuilds a prior batch response from the compact replay record plus the
   * append-only receipt rows, re-checking authorization exactly as the first
   * call did so a revoked destination cannot be replayed back into disclosure.
   */
  /**
   * Replays a prior batch response exactly.
   *
   * An exact same-key replay is side-effect free and returns the caller its own
   * previously recorded verdict, so later revocation of the destination does
   * not change it. Downgrading a replay to `failed` once authorization ended
   * broke the protocol-wide rule that a replayed idempotency key returns the
   * same response, and bought nothing: the body is the caller's own receipt
   * echoed back with the verdict it already received, so a revoked caller
   * learns nothing it did not already hold. Fail-closed still governs every
   * path that *accepts* new evidence — `loadReceiptEvidence` joins
   * `revoked_at IS NULL` — and nothing here reads another consumer's rows.
   */
  private async replayReceiptBatch(
    client: PgClient,
    input: ReportingReceiptBatchInputV1,
    stored: StoredReceiptBatchResult[]
  ): Promise<SyncReportingReceiptsResponse['results']> {
    const replay: SyncReportingReceiptsResponse['results'] = [];
    for (const [index, entry] of input.entries.entries()) {
      const result = stored[index];
      // Rows written before the compact form stored the whole response entry.
      const legacy = legacyReceiptBatchResult(result);
      if (legacy) {
        replay.push(structuredClone(legacy));
        continue;
      }
      if (!result || result.kind === 'failed') {
        replay.push(failed(entry.receipt.reporting_receipt_id));
        continue;
      }
      const row = await client.query<QueryRow & { data: ReportingReceipt | ReportingAdjustmentReceipt }>(
        `SELECT data FROM adcp_reporting_receipts
          WHERE account_id = $1 AND consumer_id = $2 AND reporting_receipt_id = $3`,
        [input.account_id, input.consumer_id, result.id]
      );
      const data = row.rows[0]?.data;
      // The receipt table is append-only, so a recorded id is always still
      // there. Fail this entry closed rather than invent a body if it is not.
      if (!data) {
        replay.push(failed(entry.receipt.reporting_receipt_id));
        continue;
      }
      replay.push(
        result.kind === 'recorded'
          ? recorded(result.entry, structuredClone(data))
          : unchanged(result.entry, structuredClone(data))
      );
    }
    return replay;
  }

  private async recordReceipt(
    client: PgClient,
    batch: ReportingReceiptBatchInputV1,
    entry: ReportingReceiptBatchEntryV1,
    receivedAt: string
  ): Promise<SyncReportingReceiptsResponse['results'][number]> {
    const fingerprint = digest(entry.receipt);
    const existing = await client.query<
      QueryRow & { semantic_fingerprint: string; data: ReportingReceipt | ReportingAdjustmentReceipt }
    >(
      `SELECT semantic_fingerprint, data FROM adcp_reporting_receipts
        WHERE account_id = $1 AND consumer_id = $2 AND reporting_receipt_id = $3`,
      [batch.account_id, batch.consumer_id, entry.receipt.reporting_receipt_id]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].semantic_fingerprint !== fingerprint) return failed(entry.receipt.reporting_receipt_id);
      return unchanged(entry.kind, existing.rows[0].data);
    }
    const evidence = await this.loadReceiptEvidence(client, batch.account_id, entry);
    if (!evidence) return failed(entry.receipt.reporting_receipt_id);
    const matches =
      entry.kind === 'revision'
        ? receiptEvidenceMatches(entry.receipt, evidence.materialization!)
        : adjustmentReceiptEvidenceMatches(entry.receipt, evidence.adjustment!);
    // RC3 acceptance_match: "accepted requires observed_adjustment_sha256 to
    // equal the referenced adjustment's canonical_adjustment_sha256 ... A digest
    // OR SEMANTIC disagreement is rejected with stable rejection_codes." A
    // semantic disagreement is by construction one where the digests DO match,
    // so requiring `!matches` to reject made that whole class unfileable — and
    // because an accepted leaf is terminal, reconciliation had no exit at all.
    // A rejection is well formed when it carries rejection codes.
    const wellFormed = entry.receipt.status === 'accepted' ? matches : Boolean(entry.receipt.rejection_codes?.length);
    if (!wellFormed) {
      return failed(entry.receipt.reporting_receipt_id);
    }
    const current = await client.query<QueryRow & { reporting_receipt_id: string; data: { status: string } }>(
      `SELECT reporting_receipt_id, data FROM adcp_reporting_receipts
        WHERE account_id = $1 AND consumer_id = $2 AND receipt_kind = $3 AND subject_id = $4 AND is_current`,
      [batch.account_id, batch.consumer_id, entry.kind, evidence.subjectId]
    );
    const leaf = current.rows[0];
    const supersedes = entry.receipt.supersedes_reporting_receipt_id;
    if (
      (leaf && (leaf.data.status === 'accepted' || supersedes !== leaf.reporting_receipt_id)) ||
      (!leaf && supersedes !== undefined)
    ) {
      return failed(entry.receipt.reporting_receipt_id);
    }
    if (leaf) {
      await client.query(
        `UPDATE adcp_reporting_receipts SET is_current = false
          WHERE account_id = $1 AND consumer_id = $2 AND reporting_receipt_id = $3 AND is_current`,
        [batch.account_id, batch.consumer_id, leaf.reporting_receipt_id]
      );
    }
    // `received_at` on the wire, `received_at`/`recorded_at` in the row: one
    // value, so the instant a consumer is shown is exactly the instant its
    // receipt sorts and becomes visible at.
    const stored = { ...entry.receipt, received_at: receivedAt };
    await client.query(
      `INSERT INTO adcp_reporting_receipts
        (account_id, consumer_id, reporting_receipt_id, receipt_kind, subject_id,
         supersedes_receipt_id, is_current, semantic_fingerprint, data, received_at, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8::jsonb,$9,$9)`,
      [
        batch.account_id,
        batch.consumer_id,
        entry.receipt.reporting_receipt_id,
        entry.kind,
        evidence.subjectId,
        supersedes ?? null,
        fingerprint,
        JSON.stringify(stored),
        receivedAt,
      ]
    );
    return recorded(entry.kind, stored);
  }

  private async loadReceiptEvidence(
    client: PgClient,
    accountId: string,
    entry: ReportingReceiptBatchEntryV1
  ): Promise<{
    subjectId: string;
    materialization?: ReportingMaterialization;
    adjustment?: ReportingLedgerAdjustmentV1;
  } | null> {
    if (entry.kind === 'revision') {
      const receipt = entry.receipt;
      const result = await client.query<QueryRow & { materialization: ReportingMaterialization }>(
        `SELECT materialization.data AS materialization
           FROM adcp_reporting_materializations materialization
           JOIN adcp_reporting_managed_bindings binding ON binding.configuration_id = materialization.configuration_id
           JOIN adcp_reporting_destination_authorizations authz
             ON authz.account_id = materialization.account_id
            AND authz.destination_ref = materialization.destination_ref
            AND authz.generation = materialization.authorization_generation
            AND authz.revoked_at IS NULL
           JOIN adcp_reporting_revisions revision ON revision.revision_id = materialization.revision_id
           JOIN adcp_reporting_obligations obligation ON obligation.obligation_id = materialization.obligation_id
          WHERE materialization.account_id = $1 AND materialization.materialization_id = $2
            AND materialization.revision_id = $3 AND materialization.obligation_id = $4
            AND materialization.status IN ('available','delivered')
            -- RC3 ties the receiptable revision to the obligation's own
            -- required_finality, exactly as the read projection does when it
            -- picks the required revision. Hard-coding 'official' made every
            -- snapshot-finality consumer_receipt configuration unreconcilable:
            -- the projection asked for a receipt the store always refused.
            AND (obligation.data->>'requiredFinality' <> 'official' OR revision.finality = 'official')
            AND binding.data->>'reconciliation_mode' = 'consumer_receipt'`,
        [
          accountId,
          receipt.reporting_materialization_id,
          receipt.reporting_revision_id,
          receipt.reporting_obligation_id,
        ]
      );
      return result.rows[0]
        ? { subjectId: receipt.reporting_revision_id, materialization: result.rows[0].materialization }
        : null;
    }
    const receipt = entry.receipt;
    const result = await client.query<QueryRow & { adjustment: ReportingLedgerAdjustmentV1 }>(
      `SELECT adjustment.data AS adjustment
         FROM adcp_reporting_adjustments adjustment
         JOIN adcp_reporting_revisions revision ON revision.revision_id = adjustment.adjusts_revision_id
         JOIN adcp_reporting_obligations obligation ON obligation.obligation_id = adjustment.obligation_id
         JOIN adcp_reporting_managed_bindings binding ON binding.configuration_id = obligation.configuration_id
         JOIN adcp_reporting_destination_authorizations authz
           ON authz.account_id = binding.account_id AND authz.destination_ref = binding.destination_ref
          AND authz.generation = binding.authorization_generation AND authz.revoked_at IS NULL
        WHERE binding.account_id = $1 AND adjustment.adjustment_id = $2
          AND adjustment.adjusts_revision_id = $3
          -- Unlike a revision receipt this arm stays pinned to 'official': an
          -- adjustment only ever corrects an already-official revision, which
          -- commitAdjustment enforces at write time.
          AND revision.finality = 'official'
          AND binding.data->>'reconciliation_mode' = 'consumer_receipt'`,
      [accountId, receipt.reporting_adjustment_id, receipt.adjusts_reporting_revision_id]
    );
    return result.rows[0]
      ? { subjectId: receipt.reporting_adjustment_id, adjustment: result.rows[0].adjustment }
      : null;
  }

  private async transaction<T>(body: (client: PgClient) => Promise<T>): Promise<T> {
    let client: PgClient;
    try {
      client = (await this.pool.connect()) as PgClient;
    } catch (cause) {
      throw new Error('PostgresReportingManagedDeliveryStore database connection failed', { cause });
    }
    let releaseError: Error | undefined;
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const value = await body(client);
      await client.query('COMMIT');
      transactionStarted = false;
      return value;
    } catch (cause) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
          transactionStarted = false;
        } catch (rollbackCause) {
          releaseError =
            rollbackCause instanceof Error ? rollbackCause : new Error('Managed reporting rollback failed');
        }
      }
      throw new Error('PostgresReportingManagedDeliveryStore transaction failed', { cause });
    } finally {
      client.release(releaseError);
    }
  }

  private async query<Row extends QueryRow = QueryRow>(sql: string, values?: unknown[]): Promise<PgResult<Row>> {
    try {
      return await this.pool.query<Row>(sql, values);
    } catch (cause) {
      throw new Error('PostgresReportingManagedDeliveryStore database operation failed', { cause });
    }
  }
}

function recorded(kind: ReportingReceiptBatchEntryV1['kind'], data: ReportingReceipt | ReportingAdjustmentReceipt) {
  return kind === 'revision'
    ? ({ result: 'recorded', receipt: data as ReportingReceipt } as const)
    : ({ result: 'recorded', adjustment_receipt: data as ReportingAdjustmentReceipt } as const);
}

function unchanged(kind: ReportingReceiptBatchEntryV1['kind'], data: ReportingReceipt | ReportingAdjustmentReceipt) {
  return kind === 'revision'
    ? ({ result: 'unchanged', receipt: data as ReportingReceipt } as const)
    : ({ result: 'unchanged', adjustment_receipt: data as ReportingAdjustmentReceipt } as const);
}

function failed(reporting_receipt_id: string): SyncReportingReceiptsResponse['results'][number] {
  return {
    result: 'failed',
    reporting_receipt_id,
    errors: [{ code: 'INVALID_REQUEST', message: GENERIC_RECEIPT_MESSAGE, recovery: 'correctable' }],
  };
}

function idempotencyConflict(reporting_receipt_id: string): SyncReportingReceiptsResponse['results'][number] {
  return {
    result: 'failed',
    reporting_receipt_id,
    errors: [
      {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key was reused with different receipt content',
        recovery: 'correctable',
      },
    ],
  };
}

function receiptResultId(
  result: SyncReportingReceiptsResponse['results'][number],
  entry: ReportingReceiptBatchEntryV1
): string {
  if (result.result === 'failed') return result.reporting_receipt_id;
  const body = 'receipt' in result ? result.receipt : result.adjustment_receipt;
  return body?.reporting_receipt_id ?? entry.receipt.reporting_receipt_id;
}

function legacyReceiptBatchResult(
  value: StoredReceiptBatchResult | undefined
): SyncReportingReceiptsResponse['results'][number] | undefined {
  if (!value || typeof value !== 'object' || !('result' in value)) return undefined;
  return value as unknown as SyncReportingReceiptsResponse['results'][number];
}

function subjectKey(entry: ReportingReceiptBatchEntryV1): string {
  return entry.kind === 'revision'
    ? `revision:${entry.receipt.reporting_revision_id}`
    : `adjustment:${entry.receipt.reporting_adjustment_id}`;
}

function duplicates(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) (seen.has(value) ? duplicate : seen).add(value);
  return duplicate;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function managedBindingFingerprint(binding: ReportingManagedDeliveryBindingV1): string {
  const { created_at: _createdAt, semantic_fingerprint: _fingerprint, ...semantic } = binding;
  return digest(semantic);
}

function nonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

async function advisoryLock(client: PgClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

function authLock(accountId: string, destinationRef: string): string {
  return `adcp-reporting-auth:${accountId}:${destinationRef}`;
}

function accountLock(accountId: string): string {
  return `adcp-reporting-account:${accountId}`;
}
