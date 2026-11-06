/**
 * The orphan collector's ownership fence (adcontextprotocol/adcp-client#3292).
 *
 * The collector deletes objects under `{prefix}/{namespace_key}/` that no ledger record names. A clone or
 * point-in-time restore of the ledger database carries the same configuration, installation identity and
 * namespace key, but an older set of references, so its collector would delete the live database's newer
 * objects. Nothing inside the database can tell the two apart; the object store they share can.
 *
 * The fence is a chain of create-only objects, one per epoch, under the binding's owned prefix:
 *
 *     {prefix}/{namespace_key}/_collector-fence/0000000000000007.json
 *
 * Each holds `{ v, namespace_key, epoch, token, previous_token, claimed_at }`. The highest epoch is the
 * current claim. The database records the `(epoch, token)` it last claimed in
 * `adcp_reporting_orphan_collector_fences`. A real pass deletes only when the highest epoch in the store is
 * exactly the claim this database recorded, then claims the next epoch (create-only, so exactly one claimant
 * wins) before it deletes anything. Every other state refuses with a cause. A database that was copied
 * before the original's last claim sees a higher epoch and refuses; so does a restore, until an operator
 * calls `takeOverOrphanCollectorFence`.
 */
import { createHash } from 'crypto';

import { canonicalize } from '@adcp/sdk';

/**
 * Object-store directory (under the owned prefix) that holds the fence chain.
 *
 * @internal
 */
export const ORPHAN_FENCE_DIRECTORY = '_collector-fence';

/** Fence objects are tiny; anything larger is not one. */
export const ORPHAN_FENCE_MAX_BYTES = 4096;

const EPOCH_DIGITS = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_NAME = new RegExp(`^(\\d{${EPOCH_DIGITS}})\\.json$`);

/**
 * Why a binding's collector refused to delete.
 *
 * - `claimed_elsewhere`: this database never claimed the namespace, but the object store holds a claim. A
 *   clone that has not collected before, a database whose fence table was lost, or another installation.
 * - `fence_advanced`: the object store holds a newer claim than this database recorded. Another database
 *   (usually the live one this was cloned from) has collected since this database's state was taken.
 * - `token_mismatch`: the object store holds this database's epoch under a different token. Two databases
 *   claimed the same epoch; the other one won.
 * - `fence_missing`: this database recorded a claim and the object store holds none: the bucket or prefix
 *   was reset or is a different one.
 * - `fence_regressed`: the object store holds an older claim than this database recorded: a database
 *   restored from a newer state, or a bucket restored from an older one.
 * - `fence_unreadable`: the fence objects are malformed, oversized, duplicated or name another namespace.
 * - `claim_lost`: this pass tried to claim the next epoch and another database got there first.
 * - `migration_required`: the fence table does not exist; apply the pending reporting-storage migration.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingOrphanFenceCauseV1 =
  | 'claimed_elsewhere'
  | 'fence_advanced'
  | 'token_mismatch'
  | 'fence_missing'
  | 'fence_regressed'
  | 'fence_unreadable'
  | 'claim_lost'
  | 'migration_required';

/**
 * Why a binding was fenced, reported on its collection outcome.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingOrphanFenceRefusalV1 {
  cause: ReportingOrphanFenceCauseV1;
  /** What to check, and how to take the namespace over if this database really is its only owner. */
  detail: string;
  /** Highest epoch found in the object store, when readable. */
  fenceEpoch?: number;
  /** Epoch this database last recorded, when it has one. */
  recordedEpoch?: number;
}

/** One fence object found by a listing. */
export interface OrphanFenceEntry {
  epoch: number;
  objectRef: string;
  nativeVersionRef: string;
}

/** The contents of one fence object. */
export interface OrphanFenceRecord {
  epoch: number;
  token: string;
  previousToken: string | null;
  claimedAt: string;
}

/** What this database recorded for a fence scope. */
export interface OrphanFenceRow {
  epoch: number;
  token: string;
  previousToken: string | null;
}

export type OrphanFenceDecision =
  /**
   * This database may collect. A real pass claims `epoch` first (the next epoch after its own claim, or 1 when the
   * namespace was never claimed); a read-only check just proceeds.
   */
  | { action: 'claim'; epoch: number; previousToken: string | null }
  /** This database recorded a claim and crashed or failed before its object was written: write it now. */
  | { action: 'complete' }
  | { action: 'fenced'; refusal: ReportingOrphanFenceRefusalV1 };

const TAKEOVER_HINT =
  'If this database is the only one that owns this namespace (for example after restoring it from a backup, and ' +
  'the original is gone), call takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true }). Otherwise leave ' +
  'orphan collection off on this copy.';

/**
 * Decide, from what this database recorded and what the object store holds, whether it may collect.
 * Pure: the caller does the I/O and the transaction.
 */
export function decideOrphanFence(
  row: OrphanFenceRow | null,
  latest: { epoch: number; token: string } | null
): OrphanFenceDecision {
  const refuse = (
    cause: ReportingOrphanFenceCauseV1,
    detail: string
  ): { action: 'fenced'; refusal: ReportingOrphanFenceRefusalV1 } => ({
    action: 'fenced',
    refusal: {
      cause,
      detail: `${detail}. ${TAKEOVER_HINT}`,
      ...(latest ? { fenceEpoch: latest.epoch } : {}),
      ...(row ? { recordedEpoch: row.epoch } : {}),
    },
  });
  if (!row) {
    if (!latest) return { action: 'claim', epoch: 1, previousToken: null };
    return refuse(
      'claimed_elsewhere',
      `the namespace is already claimed (epoch ${latest.epoch}) by a database this one has no record of: ` +
        'it is a clone or restore of that database, or another installation that shares the namespace'
    );
  }
  if (!latest) {
    // An unconfirmed first claim: this database recorded epoch 1 and did not write the object.
    if (row.epoch === 1 && row.previousToken === null) return { action: 'complete' };
    return refuse(
      'fence_missing',
      `this database recorded epoch ${row.epoch} and the object store holds no fence: the bucket or prefix was ` +
        'reset or is a different one'
    );
  }
  if (latest.epoch === row.epoch) {
    if (latest.token === row.token) return { action: 'claim', epoch: row.epoch + 1, previousToken: row.token };
    return refuse(
      'token_mismatch',
      `epoch ${row.epoch} in the object store belongs to another claim: two databases claimed the same epoch and ` +
        'the other one won'
    );
  }
  if (latest.epoch > row.epoch) {
    return refuse(
      'fence_advanced',
      `the object store holds epoch ${latest.epoch} and this database recorded epoch ${row.epoch}: another ` +
        'database that shares this namespace has collected since this database was copied or restored'
    );
  }
  // latest.epoch < row.epoch. One behind with the recorded previous token is an unconfirmed claim of this
  // database (it wrote the intent and not the object); anything else is a regression.
  if (latest.epoch === row.epoch - 1 && row.previousToken !== null && latest.token === row.previousToken) {
    return { action: 'complete' };
  }
  return refuse(
    'fence_regressed',
    `the object store holds epoch ${latest.epoch}, older than the epoch ${row.epoch} this database recorded: the ` +
      'database was restored from a newer state than the bucket, or the bucket from an older one'
  );
}

/** Object key of one epoch's fence object under a binding's owned prefix (`{prefix}/{namespace_key}/`). */
export function orphanFenceKey(ownedPrefix: string, epoch: number): string {
  return `${orphanFenceDirectory(ownedPrefix)}${String(epoch).padStart(EPOCH_DIGITS, '0')}.json`;
}

/** The listing prefix of the fence chain. */
export function orphanFenceDirectory(ownedPrefix: string): string {
  return `${ownedPrefix}${ORPHAN_FENCE_DIRECTORY}/`;
}

/** Whether a listed key is part of the fence chain. */
export function isOrphanFenceKey(ownedPrefix: string, key: string): boolean {
  return key.startsWith(orphanFenceDirectory(ownedPrefix));
}

/** The epoch a fence key names, or `undefined` for any other key under the fence directory. */
export function orphanFenceEpochOfKey(ownedPrefix: string, key: string): number | undefined {
  const directory = orphanFenceDirectory(ownedPrefix);
  if (!key.startsWith(directory)) return undefined;
  const match = KEY_NAME.exec(key.slice(directory.length));
  if (!match) return undefined;
  const epoch = Number(match[1]);
  return Number.isSafeInteger(epoch) && epoch >= 1 ? epoch : undefined;
}

export function encodeOrphanFenceRecord(namespaceKey: string, record: OrphanFenceRecord): Uint8Array {
  return Buffer.from(
    `${JSON.stringify({
      v: 1,
      namespace_key: namespaceKey,
      epoch: record.epoch,
      token: record.token,
      previous_token: record.previousToken,
      claimed_at: record.claimedAt,
    })}\n`
  );
}

/** Parse a fence object strictly; returns `undefined` for anything that is not exactly a fence of this namespace and epoch. */
export function parseOrphanFenceRecord(
  bytes: Uint8Array,
  expected: { namespaceKey: string; epoch: number }
): OrphanFenceRecord | undefined {
  if (bytes.byteLength > ORPHAN_FENCE_MAX_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'claimed_at,epoch,namespace_key,previous_token,token,v') return undefined;
  if (
    record.v !== 1 ||
    record.namespace_key !== expected.namespaceKey ||
    record.epoch !== expected.epoch ||
    typeof record.token !== 'string' ||
    !UUID.test(record.token) ||
    !(
      record.previous_token === null ||
      (typeof record.previous_token === 'string' && UUID.test(record.previous_token))
    ) ||
    typeof record.claimed_at !== 'string' ||
    !Number.isFinite(Date.parse(record.claimed_at))
  ) {
    return undefined;
  }
  return {
    epoch: expected.epoch,
    token: record.token,
    previousToken: record.previous_token as string | null,
    claimedAt: record.claimed_at,
  };
}

/**
 * Identity of one physical fence: the provider, its location, the prefix and the namespace key. Bindings that
 * share all four share a fence, because a collector listing through either one reaches the same objects.
 */
export function orphanFenceScope(input: {
  provider: string;
  location: Readonly<Record<string, string>>;
  prefix: string;
  namespaceKey: string;
}): string {
  return createHash('sha256')
    .update(
      canonicalize(['adcp.orphan_fence.v1', input.provider, { ...input.location }, input.prefix, input.namespaceKey])
    )
    .digest('hex');
}
