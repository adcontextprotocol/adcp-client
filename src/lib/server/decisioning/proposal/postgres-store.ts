/** Durable PostgreSQL ProposalStore with database-atomic lifecycle CAS. */

import { AdcpError } from '../async-outcome';
import { isDeepStrictEqual } from 'node:util';
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
const SENSITIVE_KEY =
  /(?:^|_)(?:authorization|bearer|credential|password|secret|token|private_key|api_key|auth_info|ctx_metadata)(?:$|_)/i;

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
    if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError(`${label}${path} must contain plain JSON objects.`);
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
        const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
        if (SENSITIVE_KEY.test(normalizedKey))
          throw new TypeError(`${label}${path}.${key} contains credential material or server-only metadata.`);
        visit(entry, `${path}.${key}`);
      }
    }
    seen.delete(item);
  };
  visit(value, '');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
  return json;
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
    recipes: new Map(Object.entries(row.recipes as Record<string, TRecipe>)),
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

  async probe(): Promise<void> {
    try {
      await this.db.query(`SELECT 1 FROM ${this.table} WHERE deployment_namespace=$1 LIMIT 1`, [this.namespace]);
    } catch (cause) {
      throw new Error('Postgres proposal store probe failed; run getProposalStoreMigration() before serving.', {
        cause,
      });
    }
  }

  async cleanupExpired(limit = 1000): Promise<number> {
    const bounded = Math.min(positive(limit, 1000, 'limit'), 10_000);
    const result = await this.db.query(
      `DELETE FROM ${this.table} WHERE ctid IN (
         SELECT ctid FROM ${this.table} WHERE deployment_namespace=$1 AND (
           (state='draft' AND created_at < NOW() - ($2 * INTERVAL '1 second')) OR
           (state<>'draft' AND expires_at IS NOT NULL AND expires_at < NOW() - ($3 * INTERVAL '1 second'))
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
    const recipes = jsonForStorage(Object.fromEntries(args.recipes), 'recipes', this.maxPayloadBytes);
    const payload = jsonForStorage(args.proposalPayload, 'proposalPayload', this.maxPayloadBytes);
    const result = await this.db.query(
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
    const result = await this.db.query(
      `SELECT * FROM ${this.table} WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3`,
      [this.namespace, args.expectedAccountId, proposalId]
    );
    return result.rows[0] ? rowToRecord<TRecipe>(result.rows[0]) : null;
  }

  async commit(
    proposalId: string,
    args: { expiresAt: Date; proposalPayload: Record<string, unknown>; expectedAccountId: string }
  ): Promise<void> {
    if (!args.expectedAccountId) throw internal('PostgresProposalStore.commit requires expectedAccountId.');
    const payload = jsonForStorage(args.proposalPayload, 'proposalPayload', this.maxPayloadBytes);
    const updated = await this.db.query(
      `UPDATE ${this.table} SET state='committed',expires_at=$4,proposal_payload=$5::jsonb,updated_at=NOW()
       WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3 AND state='draft' RETURNING proposal_id`,
      [this.namespace, args.expectedAccountId, proposalId, args.expiresAt, payload]
    );
    if (updated.rowCount === 1) return;
    const existing = await this.get(proposalId, { expectedAccountId: args.expectedAccountId });
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
    args: { expectedAccountId: string }
  ): Promise<ProposalRecord<TRecipe>> {
    const result = await this.db.query(
      `UPDATE ${this.table} SET state='consuming',updated_at=NOW()
       WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3 AND state='committed' RETURNING *`,
      [this.namespace, args.expectedAccountId, proposalId]
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
      updated = await this.db.query(
        `UPDATE ${this.table} SET state='consumed',media_buy_id=$4,updated_at=NOW()
         WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3 AND state='consuming' RETURNING proposal_id`,
        [this.namespace, args.expectedAccountId, proposalId, args.mediaBuyId]
      );
    } catch (cause) {
      if ((cause as { code?: unknown })?.code === '23505') {
        throw internal(`Media buy ${JSON.stringify(args.mediaBuyId)} is already bound to another proposal.`);
      }
      throw cause;
    }
    if (updated.rowCount === 1) return;
    const existing = await this.get(proposalId, args);
    if (existing?.state === 'consumed' && existing.mediaBuyId === args.mediaBuyId) return;
    throw internal(`Proposal ${JSON.stringify(proposalId)} cannot finalize in the expected scope/state.`);
  }

  async releaseConsumption(proposalId: string, args: { expectedAccountId: string }): Promise<void> {
    const updated = await this.db.query(
      `UPDATE ${this.table} SET state='committed',updated_at=NOW()
       WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3 AND state='consuming' RETURNING proposal_id`,
      [this.namespace, args.expectedAccountId, proposalId]
    );
    if (updated.rowCount === 1) return;
    const existing = await this.get(proposalId, args);
    if (!existing || existing.state === 'committed') return;
    throw internal(`Proposal ${JSON.stringify(proposalId)} cannot be released from ${JSON.stringify(existing.state)}.`);
  }

  async discard(proposalId: string, args: { expectedAccountId: string }): Promise<void> {
    if (!args?.expectedAccountId) throw internal('PostgresProposalStore.discard requires expectedAccountId.');
    await this.db.query(
      `DELETE FROM ${this.table} WHERE deployment_namespace=$1 AND account_id=$2 AND proposal_id=$3`,
      [this.namespace, args.expectedAccountId, proposalId]
    );
  }

  async getByMediaBuyId(
    mediaBuyId: string,
    args: { expectedAccountId: string }
  ): Promise<ProposalRecord<TRecipe> | null> {
    const result = await this.db.query(
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
