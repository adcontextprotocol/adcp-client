import { accountReferenceKey } from '../../core/account-key';
import { createHash } from 'node:crypto';
import { syncNaturalKey } from '../../server/decisioning/account-contract';
import { registerAssertion, type AssertionContext } from './assertions';
import type { StoryboardStepResult } from './types';

let registered = false;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const array = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(object) : []);

function callerScope(ctx: AssertionContext, step: StoryboardStepResult): string {
  const source = ctx.storyboard?.phases
    ?.flatMap(phase => phase.steps ?? [])
    .find(candidate => candidate.id === step.step_id);
  return createHash('sha256')
    .update(JSON.stringify(source?.auth ?? 'default'))
    .digest('hex');
}

function matchingEntry(
  row: Record<string, unknown>,
  entries: Record<string, unknown>[],
  index: number
): Record<string, unknown> | undefined {
  const id = object(row.account).account_id ?? row.account_id;
  if (typeof id === 'string') {
    const identified = entries.find(entry => object(entry.account).account_id === id);
    if (identified) return identified;
  }
  // A response may legally echo both a seller ID and a natural key.
  const echoed = syncNaturalKey(row.account === undefined ? { ...row, account_id: undefined } : row);
  if (!echoed) {
    return undefined;
  }
  const matches = entries.filter(entry => {
    const ref = syncNaturalKey(entry);
    return (
      ref &&
      accountReferenceKey({
        ...ref,
        ...echoed,
        brand: { ...ref.brand, ...echoed.brand },
      }) === accountReferenceKey(ref)
    );
  });
  if (matches.length === 1) return matches[0];
  // Distinct keys with omitted echo subdivisions cannot be paired by response order.
  const keys = new Set(matches.map(entry => accountReferenceKey(syncNaturalKey(entry)!)));
  return keys.size === 1 ? (matches.includes(entries[index]!) ? entries[index] : matches[0]) : undefined;
}

/** Baseline checks run on any storyboard exercising sync_accounts/list_accounts. */
export function registerAccountInvariants(): void {
  if (registered) return;
  registered = true;
  registerAssertion({
    id: 'accounts.sync_contract',
    default: true,
    description: 'Account sync preserves natural-key identity and does not explicitly remap active payment terms.',
    onStart(ctx) {
      ctx.state.identities = new Map<string, { id: string; idempotencyKey: unknown; stepId: string }>();
    },
    onStep(ctx: AssertionContext, step: StoryboardStepResult) {
      if (step.skipped || (step.task !== 'sync_accounts' && step.task !== 'list_accounts')) return [];
      const body = object(step.response);
      const request = object(step.request?.payload);
      if (body.adcp_error || body.dry_run === true || request.dry_run === true) return [];
      const entries = array(request.accounts);
      const identities = ctx.state.identities as Map<string, { id: string; idempotencyKey: unknown; stepId: string }>;
      const checks: { passed: boolean; description: string; step_id: string; error?: string }[] = [];
      const check = (passed: boolean, description: string) =>
        checks.push({ passed, description, step_id: step.step_id, ...(!passed && { error: description }) });
      array(body.accounts).forEach((row, index) => {
        if (row.action === 'failed') return;
        const entry = matchingEntry(row, entries, index) ?? {};
        const id = typeof row.account_id === 'string' ? row.account_id : undefined;
        if (step.task === 'sync_accounts') {
          const ref = syncNaturalKey(entry);
          if (ref && id) {
            const key = `${callerScope(ctx, step)}:${accountReferenceKey(ref)}`;
            const previous = identities.get(key);
            if (previous) {
              // Replaying the same request may correctly return the original created row.
              const replay =
                previous.stepId !== step.step_id &&
                (body.replayed === true ||
                  (request.idempotency_key !== undefined && request.idempotency_key === previous.idempotencyKey));
              check(
                id === previous.id && (replay || row.action === 'updated' || row.action === 'unchanged'),
                'Repeated natural-key sync preserves account_id and reports updated/unchanged'
              );
            } else identities.set(key, { id, idempotencyKey: request.idempotency_key, stepId: step.step_id });
          }
          if (row.status === 'active' && entry.payment_terms !== undefined && row.payment_terms !== undefined) {
            check(row.payment_terms === entry.payment_terms, 'Active account accepts the requested payment_terms');
          }
        }
      });
      return checks;
    },
  });
  registerAssertion({
    id: 'accounts.agent_billing_complete',
    default: false,
    description: 'Certification baseline: active agent-billed sync/list rows include billing and payment_terms.',
    onStart(ctx) {
      ctx.state.agentBilled = new Set<string>();
    },
    onStep(ctx, step) {
      if (step.skipped || (step.task !== 'sync_accounts' && step.task !== 'list_accounts')) return [];
      const body = object(step.response);
      const request = object(step.request?.payload);
      if (body.adcp_error || body.dry_run === true || request.dry_run === true) return [];
      const billed = ctx.state.agentBilled as Set<string>;
      const entries = array(request.accounts);
      return array(body.accounts).flatMap((row, index) => {
        if (row.action === 'failed') return [];
        const id = `${callerScope(ctx, step)}:${row.account_id}`;
        if (row.billing === 'agent' || matchingEntry(row, entries, index)?.billing === 'agent') billed.add(id);
        if (row.status !== 'active' || !billed.has(id)) return [];
        const passed = row.billing !== undefined && row.payment_terms !== undefined;
        const description = 'Active agent-billed account row carries billing and payment_terms';
        return [{ passed, description, step_id: step.step_id, ...(!passed && { error: description }) }];
      });
    },
  });
}
