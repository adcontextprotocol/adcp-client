// Strict per-row types for the *Success* arms of sync_* responses where
// the codegen left the row shape inline on the parent interface.
//
// Why hand-author: when the row shape is inline (e.g.,
// `SyncAccountsSuccess.accounts: { account_id?: string; action: 'created' | ...; ... }[]`),
// the row has no exported name. Handlers writing
// `return { accounts: rows }` typically infer `rows` as
// `Record<string, unknown>[]` from the upstream platform's data, dodging
// the strict literal-union check on `action` / `status` / etc.
//
// Extracting a named type lets handlers write
// `const rows: SyncAccountsResponseRow[] = upstream.map(toRow);`
// and get full discriminator narrowing at compile time. The matrix run
// that surfaced PR #945 caught this drift class at the runtime validator;
// having the named type closes the gap statically.
//
// Source of truth: schemas/cache/{version}/bundled/account/sync-accounts-response.json,
// schemas/cache/{version}/bundled/governance/sync-governance-response.json.

import type { SyncAccountsSuccess, SyncGovernanceSuccess } from './tools.generated';

/**
 * One result row in a `sync_accounts` response. Carries the `action`
 * discriminator (`created` / `updated` / `unchanged` / `failed`) the
 * spec requires. Use as the element type when assembling the response:
 *
 * ```ts
 * const rows: SyncAccountsResponseRow[] = upstream.map((u) => ({
 *   account_id: u.id,
 *   brand: { domain: u.brand_domain },
 *   operator: u.operator,
 *   action: u.is_new ? 'created' : 'updated',
 *   status: u.active ? 'active' : 'pending_approval',
 * }));
 * return { accounts: rows };
 * ```
 *
 * Returning a row without `action` fails to compile.
 */
export type SyncAccountsResponseRow = SyncAccountsSuccess['accounts'][number];

/**
 * One result row in a `sync_governance` response. Mirrors the
 * {@link SyncAccountsResponseRow} pattern; carries whatever discriminator
 * the spec requires for governance-agent registration outcomes.
 */
export type SyncGovernanceResponseRow = SyncGovernanceSuccess['accounts'][number];
