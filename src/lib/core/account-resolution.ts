import type { AccountReference, ListAccountsResponse } from '../types';
import { AccountAmbiguousError, AccountRequiredError } from '../errors';

export type ListedAccount = ListAccountsResponse['accounts'][number];
type NaturalAccountReference = Extract<AccountReference, { brand: unknown }>;

export function sameCountrySet(expected?: readonly string[], actual?: readonly string[]): boolean {
  if (expected === undefined) return true;
  if (!actual || expected.length !== actual.length) return false;
  const sortedExpected = [...expected].sort();
  const sortedActual = [...actual].sort();
  return sortedExpected.every((country, index) => country === sortedActual[index]);
}

/** Hints for resolving a seller account against the caller's own credentials. */
export interface ResolveAccountOptions {
  brand?: NaturalAccountReference['brand'];
  operator?: string;
  operatorUnit?: NaturalAccountReference['operator_unit'];
  currency?: NaturalAccountReference['currency'];
  timezone?: NaturalAccountReference['timezone'];
  sandbox?: boolean;
  /** Require introspected access to this task when the seller publishes authorization. */
  forTask?: string;
  /** Billing party for buyer-declared accounts when the seller has no default. */
  billing?: 'operator' | 'agent' | 'advertiser';
  paymentTerms?: import('../types/tools.generated').PaymentTerms;
  billingEntity?: import('../types/tools.generated').BusinessEntity;
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
    if (hints.forTask && account.authorization && !account.authorization.allowed_tasks.includes(hints.forTask)) {
      return false;
    }
    if (hints.brand) {
      if (account.brand?.domain !== hints.brand.domain) return false;
      if (hints.brand.brand_id && account.brand.brand_id !== hints.brand.brand_id) return false;
      if (!sameCountrySet(hints.brand.countries, account.brand.countries)) return false;
    }
    if (hints.operator && account.operator !== hints.operator) return false;
    if (hints.operatorUnit && account.operator_unit?.id !== hints.operatorUnit.id) return false;
    if (hints.currency && account.currency !== hints.currency) return false;
    if (hints.timezone && account.timezone !== hints.timezone) return false;
    if ((account.sandbox === true) !== (hints.sandbox === true)) return false;
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
