import type { AccountReference, ListAccountsResponse } from '../types';
import { AccountAmbiguousError, AccountRequiredError } from '../errors';

export type ListedAccount = ListAccountsResponse['accounts'][number];
type NaturalAccountReference = Extract<AccountReference, { brand: unknown }>;

/** Hints for resolving a seller account against the caller's own credentials. */
export interface ResolveAccountOptions {
  brand?: NaturalAccountReference['brand'];
  operator?: string;
  operatorUnit?: NaturalAccountReference['operator_unit'];
  currency?: NaturalAccountReference['currency'];
  timezone?: NaturalAccountReference['timezone'];
  sandbox?: boolean;
  /** Billing party for buyer-declared accounts when the seller has no default. */
  billing?: 'operator' | 'agent' | 'advertiser';
  /** An account_id or a callback choosing one of the eligible list_accounts rows. */
  select?: string | ((accounts: readonly ListedAccount[]) => string);
}

/** Select only from active rows returned for the authenticated caller. */
export function selectListedAccount(
  accounts: readonly ListedAccount[],
  hints: ResolveAccountOptions
): AccountReference {
  const candidates = accounts.filter(account => {
    if (typeof account.account_id !== 'string' || !account.account_id) return false;
    if (account.status !== 'active') return false;
    if (hints.brand) {
      if (account.brand?.domain !== hints.brand.domain) return false;
      if (hints.brand.brand_id && account.brand.brand_id !== hints.brand.brand_id) return false;
    }
    if (hints.operator && account.operator !== hints.operator) return false;
    if (hints.operatorUnit && account.operator_unit?.id !== hints.operatorUnit.id) return false;
    if (hints.currency && account.currency !== hints.currency) return false;
    if (hints.timezone && account.timezone !== hints.timezone) return false;
    if (hints.sandbox !== undefined && (account.sandbox === true) !== hints.sandbox) return false;
    return true;
  });

  if (candidates.length === 0) {
    throw new AccountRequiredError(
      'explicit',
      'resolveAccount',
      'list_accounts returned no active account matching the supplied brand, operator, and sandbox hints.'
    );
  }

  const selectedId = typeof hints.select === 'function' ? hints.select(candidates) : hints.select;
  if (selectedId !== undefined) {
    if (!candidates.some(account => account.account_id === selectedId)) {
      throw new AccountRequiredError(
        'explicit',
        'resolveAccount',
        'The selected account_id is not among the active accounts returned for this caller.'
      );
    }
    return { account_id: selectedId };
  }
  if (candidates.length > 1) {
    throw new AccountAmbiguousError(candidates.map(account => account.account_id));
  }
  return { account_id: candidates[0]!.account_id };
}
