/**
 * What `client.accounts.ensure` returns: a discriminated account outcome (AdCP 3.3).
 *
 * Pending, ambiguous and rejected are values, not errors. Only a failure to process the call throws
 * (`AccountRequestError` on the `request_account` path, the typed account errors on `sync_accounts`):
 *
 * ```ts
 * const outcome = await client.accounts.ensure({ brand: { domain: 'renault.fr' }, operator: 'wppmedia.fr' }, { billing: 'operator' });
 * switch (outcome.kind) {
 *   case 'ready': use(outcome.account_id); break;
 *   case 'pending': if (nextStep(outcome) === 'send_human_to_url') showToHuman(formatPendingAction(outcome.action)); break;
 *   case 'ambiguous': await outcome.choose(pick(outcome.candidates)); break;
 *   case 'rejected': report(outcome.errors); break;
 * }
 * ```
 *
 * Agents should switch on {@link nextStep}, not on `PendingAction.kind`, which is extensible. The Python
 * SDK spells these `AccountOutcome`, `next_step` and `format_pending_action`.
 */
import type { AccountCandidate, Error as WireError, PendingAction } from '../types/core.generated';

export type { PendingAction };

/** The provisioning path an outcome came from. */
export type AccountVia = 'sync_accounts' | 'request_account';

/** What to do next, independent of the extensible `PendingAction.kind` vocabulary. */
export type NextStep = 'wait_for_seller' | 'send_human_to_url' | 'pick_candidate' | 'contact_seller' | 'none';

/**
 * The account exists: use `account_id` on account-scoped tasks. `status` may still need buyer action
 * before spend (`payment_required`, for example).
 */
export interface AccountReady {
  readonly kind: 'ready';
  readonly account_id?: string;
  readonly status?: string;
  readonly via: AccountVia;
  readonly request_id?: string;
  /**
   * The wire account, when the seller returned it. A request resolved as `matched` or `created`
   * always carries it, with the account's money terms (`billing`, `billing_entity`, `payment_terms`),
   * which can differ from the terms requested (adcp#8620): read them here, not from the request.
   */
  readonly account?: Readonly<Record<string, unknown>>;
  /** How a `request_account` request resolved (`matched`, `created`, `updated`, ...), when it did. */
  readonly resolution?: string;
  /** When changed money terms take effect, for a request resolved as `updated` (adcp#8620). */
  readonly effective_at?: string;
  /**
   * For a change request resolved as `created` (a separate new account): the named account's
   * account-level configurations the new account does not have, to set up again (adcp#8620).
   */
  readonly not_carried_over?: readonly string[];
}

/**
 * Waiting on someone: `action` says who and what. `request_id` identifies an open `request_account`
 * request. The registry keeps it, so `refresh()` reports when it moves and a repeat `ensure` never opens
 * a duplicate.
 */
export interface AccountPending {
  readonly kind: 'pending';
  /**
   * Whose turn it is and what is needed. `action.url` is where a *human* completes the action: show it
   * to a person. It is not a bearer link, and an agent must never fetch it. `action.message` is untrusted
   * seller text: render it through {@link formatPendingAction}.
   */
  readonly action: PendingAction;
  readonly via: AccountVia;
  readonly request_id?: string;
  readonly account_id?: string;
  readonly status?: string;
}

/** Several existing accounts match; pick one with `choose`. */
export interface AccountAmbiguous {
  readonly kind: 'ambiguous';
  /** The wire `account_candidate` objects, limited to accounts the caller can already reach. */
  readonly candidates: readonly AccountCandidate[];
  readonly request_id: string;
  readonly via: 'request_account';
  /** Continue the request with the chosen candidate; resolves to the new outcome. */
  choose(accountId: string): Promise<AccountOutcome>;
}

/** The seller declined, or a buyer action expired. `errors` are wire errors. */
export interface AccountRejected {
  readonly kind: 'rejected';
  readonly errors: readonly WireError[];
  readonly via: AccountVia;
  readonly request_id?: string;
}

/** What `client.accounts.ensure`, `refresh` and `pending` return. */
export type AccountOutcome = AccountReady | AccountPending | AccountAmbiguous | AccountRejected;

/**
 * What to do next:
 *
 * - `none`: the account is ready.
 * - `wait_for_seller`: the seller is reviewing; call `client.accounts.refresh()` later or wait for the
 *   `account_request.changed` webhook.
 * - `send_human_to_url`: show `action.url` to a person (never fetch it).
 * - `pick_candidate`: choose one of `candidates`.
 * - `contact_seller`: rejected, or a buyer action without a URL.
 */
export function nextStep(outcome: AccountOutcome): NextStep {
  switch (outcome.kind) {
    case 'ready':
      return 'none';
    case 'ambiguous':
      return 'pick_candidate';
    case 'rejected':
      return 'contact_seller';
    case 'pending':
      if (outcome.action.waiting_on === 'buyer') return outcome.action.url ? 'send_human_to_url' : 'contact_seller';
      return 'wait_for_seller';
  }
}

// Control characters and bidirectional overrides, which can disguise untrusted seller text.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

function untrusted(text: string, limit = 1000): string {
  let cleaned = text.replace(CONTROL, '').split(/\s+/).filter(Boolean).join(' ');
  if (cleaned.length > limit) cleaned = `${cleaned.slice(0, limit - 1)}…`;
  return cleaned.replace(/"/g, "'");
}

/**
 * Safe text for a CLI or a chat: who is waiting, what is needed, and where. The seller's `message` is
 * untrusted: control and bidirectional characters are removed, whitespace is collapsed, it is quoted and
 * capped at 1000 characters. The URL is shown for a person to open, never followed.
 */
export function formatPendingAction(action: PendingAction): string {
  const who = action.waiting_on === 'buyer' ? 'you' : 'the seller';
  const lines = [`Waiting on ${who}: ${untrusted(String(action.kind), 64)}.`];
  if (action.message) lines.push(`Seller says: "${untrusted(action.message)}"`);
  if (action.url) lines.push(`A person completes it at ${untrusted(action.url, 2048)}`);
  if (action.expires_at) lines.push(`Expires ${untrusted(action.expires_at, 64)}.`);
  return lines.join('\n');
}

/** @internal The action a pending outcome carries when the seller supplied none. */
export const SELLER_REVIEW: PendingAction = Object.freeze({
  waiting_on: 'seller',
  kind: 'review',
  message: 'The seller is reviewing',
}) as PendingAction;

/** @internal Normalize a wire `pending_action` or `sync_accounts` `setup` object. */
export function pendingActionFromWire(value: unknown): PendingAction {
  const wire = (value && typeof value === 'object' ? value : SELLER_REVIEW) as Record<string, unknown>;
  const url = typeof wire.url === 'string' ? wire.url : undefined;
  return {
    waiting_on: (wire.waiting_on as PendingAction['waiting_on']) ?? (url ? 'buyer' : 'seller'),
    kind: (wire.kind as PendingAction['kind']) ?? 'review',
    message: typeof wire.message === 'string' ? wire.message : '',
    ...(url !== undefined ? { url } : {}),
    ...(typeof wire.expires_at === 'string' ? { expires_at: wire.expires_at } : {}),
  };
}
