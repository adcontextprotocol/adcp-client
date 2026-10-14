import { accountReferenceKey } from '../../core/account-key';
import type { AccountReference } from '../../types';
import type { AssertionSpec } from './assertions';

/** Opt-in invariant for account provisioning storyboards, including fresh keys. */
export const accountSyncContractAssertion: AssertionSpec = {
  id: 'account.sync_contract',
  default: false,
  description: 'Natural-key syncs preserve identity, accept or reject terms, and expose agent billing fields.',
  onStep(ctx, step) {
    if (step.skipped || !['sync_accounts', 'list_accounts'].includes(step.task)) return [];
    const payload = step.request?.payload as
      | { accounts?: Record<string, unknown>[]; dry_run?: boolean; idempotency_key?: string }
      | undefined;
    const raw = (step.response ?? step.response_record?.payload) as { data?: unknown; accounts?: unknown } | undefined;
    const response = (raw?.data ?? raw) as { accounts?: Record<string, unknown>[] } | undefined;
    if (!Array.isArray(response?.accounts)) return [];
    const seen = (ctx.state.accounts ??= new Map()) as Map<
      string,
      { id: unknown; billing: unknown; requestKeys: Set<string | undefined> }
    >;
    const results = [];
    for (const [index, row] of response.accounts.entries()) {
      if (row.action === 'failed' || row.status === 'rejected') continue;
      const problems: string[] = [];
      const entry = payload?.accounts?.[index];
      if (
        step.task === 'list_accounts' &&
        [...seen.values()].some(prior => prior.id === row.account_id && prior.billing === 'agent') &&
        row.billing === undefined
      )
        problems.push('known agent-billed account omits billing');
      if (row.billing === 'agent' && row.payment_terms === undefined)
        problems.push('agent-billed account omits payment_terms');
      if (step.task === 'sync_accounts' && entry) {
        if (entry.billing === 'agent' && row.billing === undefined) problems.push('agent-billed sync omits billing');
        if (entry.billing === 'agent' && row.billing !== undefined && row.billing !== 'agent')
          problems.push('agent-billed sync changed billing party');
        if (entry.payment_terms !== undefined && row.status === 'active' && row.payment_terms !== entry.payment_terms)
          problems.push('active account did not accept requested payment_terms');
        const ref = (entry.account ?? entry) as AccountReference;
        if ('brand' in ref && ref.brand && typeof ref.operator === 'string' && payload?.dry_run !== true) {
          const key = JSON.stringify([step.agent_url ?? ctx.agentUrl, accountReferenceKey(ref)]);
          const prior = seen.get(key);
          // Same-key replays legitimately retain action: created.
          if (
            prior &&
            (prior.id !== row.account_id ||
              ((payload?.idempotency_key === undefined || !prior.requestKeys.has(payload.idempotency_key)) &&
                row.action === 'created'))
          )
            problems.push('repeat natural-key sync created a different account or reported created');
          const requestKeys = prior?.requestKeys ?? new Set<string | undefined>();
          requestKeys.add(payload?.idempotency_key);
          seen.set(key, {
            id: prior?.id ?? row.account_id,
            billing: row.billing,
            requestKeys,
          });
        }
      }
      results.push({
        passed: problems.length === 0,
        description: `Account contract for ${step.task} row ${index}`,
        step_id: step.step_id,
        ...(problems.length && { error: problems.join('; ') }),
      });
    }
    return results;
  },
};
