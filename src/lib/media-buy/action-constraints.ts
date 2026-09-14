import type { ActionBuy, ConstraintAssessment, ProposalChangeTerm, ChangeTermConstraints } from './action-types';
import type { DecomposedUpdateMediaBuyMutation } from './mutations';
import type { UpdateMediaBuyRequestLike } from './types';
import { changeConstraintIssues, elapsedDuration } from './action-contracts';

export interface ConstraintEvaluationOptions {
  /** Captured request time in epoch milliseconds. Required for wall-clock bounds; never inferred from prose. */
  now?: number;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value: unknown): number | undefined => {
  const raw = typeof value === 'object' && value !== null && 'datetime' in value ? value.datetime : value;
  if (typeof raw !== 'string') return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const unknown = (constraint: string, path: string): ConstraintAssessment => ({
  status: 'unknown',
  constraint,
  path,
  message: 'Insufficient current state to evaluate this bound.',
});
const exceeded = (constraint: string, path: string): ConstraintAssessment => ({
  status: 'exceeded',
  constraint,
  path,
  message: 'The requested change exceeds the accepted bound; refine the accepted proposal.',
});

/** Evaluate only portable data. Seller conditions and calendar/campaign durations stay unknown. */
export function evaluateChangeTermConstraints(
  term: ProposalChangeTerm,
  buy: ActionBuy,
  request: UpdateMediaBuyRequestLike,
  mutations: readonly DecomposedUpdateMediaBuyMutation[],
  options: ConstraintEvaluationOptions = {}
): ConstraintAssessment {
  if (term.constraints === undefined) return { status: 'satisfied' };
  if (changeConstraintIssues(term.action, term.constraints).length) return unknown('invalid_constraints', term.action);
  // The generated anyOf branches have a broad object type. Narrow only after
  // runtime structural validation of the complete portable constraint object.
  const c = term.constraints as ChangeTermConstraints;
  const relevant = mutations.filter(m => m.action === term.action);
  let unresolved: ConstraintAssessment | undefined;
  const recordUnknown = (key: string, path: string) => {
    unresolved ??= unknown(key, path);
  };
  if (c.kind === 'budget') {
    const values = relevant.filter(m => /(?:budget(?:\.amount)?|daily_budget_cap|min_spend_target)$/.test(m.field));
    if (!values.length) return unknown('cannot_preflight', term.action);
    const currency = typeof buy.total_budget === 'object' ? buy.total_budget.currency : buy.currency;
    for (const m of values) {
      if (!finite(m.to) || m.to < 0) {
        recordUnknown('result_amount', m.path);
        continue;
      }
      const delta = finite(m.from) && m.from >= 0 ? Math.abs(m.to - m.from) : undefined;
      if (m.field === 'total_budget.amount' && request.total_budget?.currency !== currency) {
        if (currency === undefined) recordUnknown('currency', m.path);
        else return exceeded('currency_mismatch', 'total_budget.currency');
      }
      for (const key of ['max_delta_amount', 'min_result_amount', 'max_result_amount'] as const) {
        const bound = c[key];
        if (!bound) continue;
        if (currency === undefined) {
          recordUnknown('currency', m.path);
          continue;
        }
        if (currency !== bound.currency) {
          recordUnknown('currency_mismatch', m.path);
          continue;
        }
        if (key === 'max_delta_amount') {
          if (delta === undefined) recordUnknown(key, m.path);
          else if (delta > bound.amount) return exceeded(key, m.path);
        } else if (
          (key === 'min_result_amount' && m.to < bound.amount) ||
          (key === 'max_result_amount' && m.to > bound.amount)
        )
          return exceeded(key, m.path);
      }
      if (c.max_delta_percent !== undefined) {
        if (delta === undefined || !finite(m.from)) recordUnknown('max_delta_percent', m.path);
        else if (m.from === 0 ? delta > 0 : delta * 100 > c.max_delta_percent * m.from)
          return exceeded('max_delta_percent', m.path);
      }
    }
  } else if (c.kind === 'flight') {
    if (!relevant.length) return unknown('cannot_preflight', term.action);
    for (const m of relevant) {
      const before = timestamp(m.from),
        after = timestamp(m.to);
      if (after === undefined) {
        recordUnknown('result_time', m.path);
        continue;
      }
      if (c.max_change !== undefined) {
        const max = elapsedDuration(c.max_change);
        if (before === undefined || max === undefined) recordUnknown('max_change', m.path);
        else if (Math.abs(after - before) > max) return exceeded('max_change', m.path);
      }
      if (c.earliest_result !== undefined && after < Date.parse(c.earliest_result))
        return exceeded('earliest_result', m.path);
      if (c.latest_result !== undefined && after > Date.parse(c.latest_result))
        return exceeded('latest_result', m.path);
      // Current mutation schemas have no future effective_at. A changed flight
      // timestamp is not notice before the mutation itself takes effect.
      if (c.minimum_notice !== undefined) {
        if (elapsedDuration(c.minimum_notice) === undefined) recordUnknown('minimum_notice', m.path);
        else return exceeded('minimum_notice', m.path);
      }
    }
  } else if (c.kind === 'package_count') {
    const additions = request.new_packages?.length ?? 0;
    const removed = request.packages?.filter(p => p.canceled === true) ?? [];
    const removals = removed.length;
    if (c.max_additions !== undefined && additions > c.max_additions) return exceeded('max_additions', 'new_packages');
    if (c.max_removals !== undefined && removals > c.max_removals) return exceeded('max_removals', 'packages');
    if (c.max_result_count !== undefined) {
      const current = buy.packages;
      if (
        !current ||
        new Set(current.map(p => p.package_id)).size !== current.length ||
        current.some(p => !p.package_id) ||
        new Set(removed.map(p => p.package_id)).size !== removals ||
        removed.some(
          p => !current.some(old => old.package_id === p.package_id && !old.canceled && old.status !== 'canceled')
        )
      ) {
        recordUnknown('max_result_count', 'packages');
      } else if (
        current.filter(p => !p.canceled && p.status !== 'canceled').length + additions - removals >
        c.max_result_count
      )
        return exceeded('max_result_count', 'packages');
    }
  } else if (c.kind === 'effective_timing') {
    if (c.minimum_notice !== undefined) {
      if (elapsedDuration(c.minimum_notice) === undefined) recordUnknown('minimum_notice', term.action);
      else return exceeded('minimum_notice', term.action);
    }
    if ((c.earliest_effective_at !== undefined || c.latest_effective_at !== undefined) && !finite(options.now))
      recordUnknown('request_time', term.action);
    else if (finite(options.now)) {
      if (c.earliest_effective_at !== undefined && options.now < Date.parse(c.earliest_effective_at))
        return exceeded('earliest_effective_at', term.action);
      if (c.latest_effective_at !== undefined && options.now > Date.parse(c.latest_effective_at))
        return exceeded('latest_effective_at', term.action);
    }
  }
  return unresolved ?? { status: 'satisfied' };
}
