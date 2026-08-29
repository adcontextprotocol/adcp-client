/** Durable PostgreSQL ProposalStore with database-atomic lifecycle CAS. */

import { AdcpError } from '../async-outcome';
import { isDeepStrictEqual } from 'node:util';
import { scanArgsForCredentials } from '../../credential-policy';
import type { Recipe } from './types';
import type { ProposalRecord, ProposalStore } from './store';

export interface ProposalPgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface PostgresProposalStoreOptions {
  db: ProposalPgQueryable;
  /** Stable trusted deployment/tenant namespace. */
  namespace: string;
  tableName?: string;
  draftTtlSeconds?: number;
  committedGraceSeconds?: number;
  /** Maximum UTF-8 JSON bytes for each recipes/payload document. */
  maxPayloadBytes?: number;
}

export interface ProposalStoreMigrationOptions {
  tableName?: string;
}

const DEFAULT_TABLE = 'adcp_decisioning_proposals';
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const NAMESPACE = /^[A-Za-z0-9_.:-]{1,255}$/;
const CAPABILITY_OVERLAP_KEYS = ['pricingModels', 'targetingDimensions', 'deliveryTypes', 'signalTypes'] as const;
const STORAGE_CREDENTIAL_PATTERNS = {
  extend: [/^auth[._\s/-]?info$/i, /^ctx[._\s/-]?metadata$/i],
};

function quoteTable(raw = DEFAULT_TABLE): string {
  if (!IDENTIFIER.test(raw) || Buffer.byteLength(raw, 'utf8') > 40) {
    throw new Error(`Invalid proposal table name ${JSON.stringify(raw)}: expected ${IDENTIFIER} and at most 40 bytes.`);
  }
  return `"${raw}"`;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  return result;
}

function validateNamespace(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !NAMESPACE.test(value)) {
    throw new Error(
      'Postgres proposal namespace must be 1-255 ASCII letters, digits, dots, underscores, colons, or hyphens.'
    );
  }
}

function jsonForStorage(value: unknown, label: string, maxBytes: number): string {
  const credentialPaths = scanArgsForCredentials(value, STORAGE_CREDENTIAL_PATTERNS);
  if (credentialPaths.length > 0) {
    throw new TypeError(`${label}.${credentialPaths[0]} contains credential material or server-only metadata.`);
  }
  const seen = new Set<object>();
  const visit = (item: unknown, path: string): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError(`${label}${path} contains a non-finite number.`);
      return;
    }
    if (typeof item !== 'object') throw new TypeError(`${label}${path} is not JSON-safe.`);
    if (seen.has(item)) throw new TypeError(`${label}${path} contains a circular reference.`);
    seen.add(item);
    if (Array.isArray(item)) {
      if (
        typeof item[0] === 'string' &&
        scanArgsForCredentials({ [item[0]]: true }, STORAGE_CREDENTIAL_PATTERNS).length
      ) {
        throw new TypeError(`${label}${path}[0] contains a credential-shaped tuple key.`);
      }
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    } else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError(`${label}${path} must contain plain JSON objects.`);
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) visit(entry, `${path}.${key}`);
    }
    seen.delete(item);
  };
  visit(value, '');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
  return json;
}

function recipesForStorage<TRecipe extends Recipe>(recipes: ReadonlyMap<string, TRecipe>): Record<string, unknown> {
  return Object.fromEntries(
    [...recipes].map(([productId, recipe]) => {
      const overlap = recipe.capability_overlap;
      if (!overlap) return [productId, recipe];
      const encodedOverlap: Record<string, unknown> = { ...overlap };
      for (const key of CAPABILITY_OVERLAP_KEYS) {
        const values = overlap[key];
        if (values !== undefined) encodedOverlap[key] = [...values];
      }
      return [productId, { ...recipe, capability_overlap: encodedOverlap }];
    })
  );
}

function recipesFromStorage<TRecipe extends Recipe>(value: Record<string, unknown>): Map<string, TRecipe> {
  return new Map(
    Object.entries(value).map(([productId, rawRecipe]) => {
      if (rawRecipe == null || typeof rawRecipe !== 'object' || Array.isArray(rawRecipe)) {
        throw internal('Stored proposal recipe is corrupt.');
      }
      const recipe = rawRecipe as Record<string, unknown>;
      const rawOverlap = recipe.capability_overlap;
      if (rawOverlap == null) return [productId, recipe as TRecipe];
      if (typeof rawOverlap !== 'object' || Array.isArray(rawOverlap)) {
        throw internal('Stored proposal capability overlap is corrupt.');
      }
      const overlap: Record<string, unknown> = { ...(rawOverlap as Record<string, unknown>) };
      for (const key of CAPABILITY_OVERLAP_KEYS) {
        const values = overlap[key];
        if (values === undefined) continue;
        if (!Array.isArray(values) || values.some(entry => typeof entry !== 'string')) {
          throw internal('Stored proposal capability overlap is corrupt.');
        }
        overlap[key] = new Set(values);
      }
      return [productId, { ...recipe, capability_overlap: overlap } as unknown as TRecipe];
    })
  );
}

function postgresError(operation: string, cause: unknown): Error {
  return new Error(`PostgresProposalStore.${operation}: database operation failed`, { cause });
}

function internal(message: string): AdcpError {
  return new AdcpError('INTERNAL_ERROR', { recovery: 'terminal', message });
}

function rowToRecord<TRecipe extends Recipe>(row: Record<string, unknown>): ProposalRecord<TRecipe> {
  if (row.recipes == null || typeof row.recipes !== 'object' || Array.isArray(row.recipes)) {
    throw internal('Stored proposal recipes are corrupt.');
  }
  if (row.proposal_payload == null || typeof row.proposal_payload !== 'object' || Array.isArray(row.proposal_payload)) {
    throw internal('Stored proposal payload is corrupt.');
  }
  if (!['draft', 'committed', 'consuming', 'consumed'].includes(String(row.state))) {
    throw internal('Stored proposal state is corrupt.');
  }
  const expiresAt = row.expires_at == null ? undefined : new Date(String(row.expires_at));
  if (expiresAt !== undefined && !Number.isFinite(expiresAt.getTime())) {
    throw internal('Stored proposal expiry is corrupt.');
  }
  return {
    proposalId: String(row.proposal_id),
    accountId: String(row.account_id),
    state: row.state as ProposalRecord<TRecipe>['state'],
    recipes: recipesFromStorage<TRecipe>(row.recipes as Record<string, unknown>),
    proposalPayload: structuredClone(row.proposal_payload as Record<string, unknown>),
    ...(expiresAt !== undefined && { expiresAt }),
    ...(row.media_buy_id != null && { mediaBuyId: String(row.media_buy_id) }),
    ...(row.recipe_schema_version != null && { recipeSchemaVersion: Number(row.recipe_schema_version) }),
  };
}

export function getProposalStoreMigration(options: ProposalStoreMigrationOptions = {}): string {
  const tableName = options.tableName ?? DEFAULT_TABLE;
  const table = quoteTable(tableName);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  deployment_namespace TEXT NOT NULL,
  account_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','committed','consuming','consumed')),
  recipes JSONB NOT NULL,
  proposal_payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  media_buy_id TEXT,
  recipe_schema_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deployment_namespace, account_id, proposal_id)
);
CREATE INDEX IF NOT EXISTS idx_${tableName}_expiry
  ON ${table}(deployment_namespace, state, expires_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${tableName}_media_buy
  ON ${table}(deployment_namespace, account_id, media_buy_id) WHERE media_buy_id IS NOT NULL;
`.trim();
}

export class PostgresProposalStore<TRecipe extends Recipe = Recipe> implements ProposalStore<TRecipe> {
  readonly isDurable = true;
  private readonly db: ProposalPgQueryable;
  private readonly namespace: string;
  private readonly table: string;
  private readonly draftTtlSeconds: number;
  private readonly committedGraceSeconds: number;
  private readonly maxPayloadBytes: number;

  constructor(options: PostgresProposalStoreOptions) {
    if (!options?.db) throw new TypeError('PostgresProposalStore requires db.');
    validateNamespace(options.namespace);
    this.db = options.db;
    this.namespace = options.namespace;
    this.table = quoteTable(options.tableName);
    this.draftTtlSeconds = positive(options.draftTtlSeconds, 86_400, 'draftTtlSeconds');
    this.committedGraceSeconds = positive(options.committedGraceSeconds, 604_800, 'committedGraceSeconds');
    this.maxPayloadBytes = positive(options.maxPayloadBytes, 1024 * 1024, 'maxPayloadBytes');
  }

  private async query(operation: string, text: string, values?: unknown[]): ReturnType<ProposalPgQueryable['query']> {
    try {
      return await this.db.query(text, values);
    } catch (cause) {
      throw postgresError(operation, cause);
    }
  }

  private async legacyAccountId(proposalId: string): Promise<string | undefined> {
    const result = await this.query(
      'resolveLegacyAccountId',
      `SELECT account_id FROM ${this.table}
       WHERE deployment_namespace=$1 AND proposal_id=$2 ORDER BY account_id LIMIT 2`,
      [this.namespace, proposalId]
    );
    if (result.rows.length > 1) {
      throw internal(
        `Proposal ${JSON.stringify(proposalId)} exists in multiple tenant scopes; expectedAccountId is required.`
      );
    }
    const accountId = result.rows[0]?.account_id;
    return typeof accountId === 'string' ? accountId : undefined;
  }

  async probe(): Promise<void> {
    try {
      await this.query('probe', `SELECT 1 FROM ${this.table} WHERE deployment_namespace=$1 LIMIT 1`, [this.namespace]);
    } catch (cause) {
      throw new Error('Postgres proposal store probe failed; run getProposalStoreMigration() before serving.', {
        cause,
      });
    }
  }

  async cleanupExpired(limit = 1000): Promise<number> {
    const bounded = Math.min(positive(limit, 1000, 'limit'), 10_000);
    const result = await this.query(
      'cleanupExpired',
      `DELETE FROM ${this.table} WHERE ctid IN (
         SELECT ctid FROM ${this.table} WHERE deployment_namespace=$1 AND (
           (state='draft' AND created_at < NOW() - ($2 * INTERVAL '1 second')) OR
           (state IN ('committed','consumed') AND expires_at IS NOT NULL AND expires_at < NOW() - ($3 * INTERVAL '1 second'))
         ) ORDER BY COALESCE(expires_at, created_at) LIMIT $4
       )`,
      [this.namespace, this.draftTtlSeconds, this.committedGraceSeconds, bounded]
    );
    return result.rowCount ?? 0;
  }

  async putDraft(args: {
    proposalId: string;
    accountId: string;
    recipes: ReadonlyMap<string, TRecipe>;
    proposalPayload: Record<string, unknown>;
  }): Promise<void> {
    const recipes = jsonForStorage(recipesForStorage(args.recipes), 'recipes', this.maxPayloadBytes);
    const payload = jsonForStorage(args.proposalPayload, 'proposalPayload', this.maxPayloadBytes);
    const result = await this.query(
      'putDraft',
      `INSERT INTO ${this.table} (deployment_namespace,account_id,proposal_id,state,recipes,proposal_payload)
       VALUES ($1,$2,$3,'draft',$4::jsonb,$5::jsonb)
       ON CONFLICT (deployment_namespace,account_id,proposal_id) DO UPDATE
       SET recipes=EXCLUDED.recipes,proposal_payload=EXCLUDED.proposal_payload,updated_at=NOW()
       WHERE ${this.table}.state='draft' RETURNING proposal_id`,
      [this.namespace, args.accountId, args.proposalId, recipes, payload]
    );
    if (result.rowCount !== 1) throw internal(`Cannot replace non-draft proposal ${JSON.stringify(args.proposalId)}.`);
  }

  async get(proposalId: string, args: { expectedAccountId: string }): Promise<ProposalRecord<TRecipe> | null> {
    const result = await this.query(
      'get',
      `SELECT * FROM ${this.table} WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3`,
      [this.namespace, args.expectedAccountId, proposalId]
    );
    return result.rows[0] ? rowToRecord<TRecipe>(result.rows[0]) : null;
  }

  async commit(
    proposalId: string,
    args: { expiresAt: Date; proposalPayload: Record<string, unknown>; expectedAccountId?: string }
  ): Promise<void> {
    if (!(args.expiresAt instanceof Date) || !Number.isFinite(args.expiresAt.getTime())) {
      throw new TypeError('PostgresProposalStore.commit expiresAt must be a valid Date.');
    }
    const accountId = args.expectedAccountId ?? (await this.legacyAccountId(proposalId));
    if (!accountId) throw internal(`Cannot commit missing proposal ${JSON.stringify(proposalId)}.`);
    const payload = jsonForStorage(args.proposalPayload, 'proposalPayload', this.maxPayloadBytes);
    const updated = await this.query(
      'commit',
      `UPDATE ${this.table} SET state='committed',expires_at=$4,proposal_payload=$5::jsonb,updated_at=NOW()
       WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3 AND state='draft' RETURNING proposal_id`,
      [this.namespace, accountId, proposalId, args.expiresAt, payload]
    );
    if (updated.rowCount === 1) return;
    const existing = await this.get(proposalId, { expectedAccountId: accountId });
    if (!existing) throw internal(`Cannot commit missing proposal ${JSON.stringify(proposalId)}.`);
    const samePayload = isDeepStrictEqual(existing.proposalPayload, JSON.parse(payload));
    if (existing.state === 'committed' && existing.expiresAt?.getTime() === args.expiresAt.getTime() && samePayload)
      return;
    throw internal(
      `Proposal ${JSON.stringify(proposalId)} cannot be committed from ${JSON.stringify(existing.state)} or with conflicting terms.`
    );
  }

  async tryReserveConsumption(
    proposalId: string,
    args: { expectedAccountId: string; expiresAtCutoff?: Date }
  ): Promise<ProposalRecord<TRecipe>> {
    if (args.expiresAtCutoff !== undefined && !Number.isFinite(args.expiresAtCutoff.getTime())) {
      throw new TypeError('PostgresProposalStore.tryReserveConsumption expiresAtCutoff must be a valid Date.');
    }
    const result = await this.query(
      'tryReserveConsumption',
      `UPDATE ${this.table} SET state='consuming',updated_at=NOW()
       WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3 AND state='committed'
         AND (expires_at IS NULL OR expires_at >= COALESCE($4::timestamptz,NOW())) RETURNING *`,
      [this.namespace, args.expectedAccountId, proposalId, args.expiresAtCutoff ?? null]
    );
    if (result.rows[0]) return rowToRecord<TRecipe>(result.rows[0]);
    const existing = await this.get(proposalId, args);
    if (!existing) {
      throw new AdcpError('PROPOSAL_NOT_FOUND', {
        recovery: 'correctable',
        message: `Proposal ${JSON.stringify(proposalId)} not found.`,
        field: 'proposal_id',
      });
    }
    throw new AdcpError('PROPOSAL_NOT_COMMITTED', {
      recovery: 'correctable',
      message: `Proposal ${JSON.stringify(proposalId)} is in state ${JSON.stringify(existing.state)}.`,
      field: 'proposal_id',
    });
  }

  async finalizeConsumption(
    proposalId: string,
    args: { mediaBuyId: string; expectedAccountId: string }
  ): Promise<void> {
    let updated: Awaited<ReturnType<ProposalPgQueryable['query']>>;
    try {
      updated = await this.query(
        'finalizeConsumption',
        `UPDATE ${this.table} SET state='consumed',media_buy_id=$4,updated_at=NOW()
         WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3 AND state='consuming' RETURNING proposal_id`,
        [this.namespace, args.expectedAccountId, proposalId, args.mediaBuyId]
      );
    } catch (cause) {
      const databaseCause = (cause as { cause?: { code?: unknown } })?.cause;
      if (databaseCause?.code === '23505') {
        throw new AdcpError('INTERNAL_ERROR', {
          recovery: 'terminal',
          message: `Media buy ${JSON.stringify(args.mediaBuyId)} is already bound to another proposal.`,
        });
      }
      throw cause;
    }
    if (updated.rowCount === 1) return;
    const existing = await this.get(proposalId, args);
    if (existing?.state === 'consumed' && existing.mediaBuyId === args.mediaBuyId) return;
    throw internal(`Proposal ${JSON.stringify(proposalId)} cannot finalize in the expected scope/state.`);
  }

  async releaseConsumption(proposalId: string, args: { expectedAccountId: string }): Promise<void> {
    const updated = await this.query(
      'releaseConsumption',
      `UPDATE ${this.table} SET state='committed',updated_at=NOW()
       WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3 AND state='consuming' RETURNING proposal_id`,
      [this.namespace, args.expectedAccountId, proposalId]
    );
    if (updated.rowCount === 1) return;
    const existing = await this.get(proposalId, args);
    if (!existing || existing.state === 'committed') return;
    throw internal(`Proposal ${JSON.stringify(proposalId)} cannot be released from ${JSON.stringify(existing.state)}.`);
  }

  async discard(proposalId: string, args?: { expectedAccountId: string }): Promise<void> {
    const accountId = args?.expectedAccountId ?? (await this.legacyAccountId(proposalId));
    if (!accountId) return;
    await this.query(
      'discard',
      `DELETE FROM ${this.table} WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3`,
      [this.namespace, accountId, proposalId]
    );
  }

  async getByMediaBuyId(
    mediaBuyId: string,
    args: { expectedAccountId: string }
  ): Promise<ProposalRecord<TRecipe> | null> {
    const result = await this.query(
      'getByMediaBuyId',
      `SELECT * FROM ${this.table} WHERE deployment_namespace=$1 AND account_id=$2 AND media_buy_id=$3`,
      [this.namespace, args.expectedAccountId, mediaBuyId]
    );
    return result.rows[0] ? rowToRecord<TRecipe>(result.rows[0]) : null;
  }
}

export function createPostgresProposalStore<TRecipe extends Recipe = Recipe>(
  options: PostgresProposalStoreOptions
): PostgresProposalStore<TRecipe> {
  return new PostgresProposalStore<TRecipe>(options);
}
