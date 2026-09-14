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
  message: `Cannot evaluate ${constraint} at ${path}; supply the committed baseline, currency, and captured request time required by that bound.`,
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
  if (request.total_budget && mutations.some(m => m.action === term.action && m.field === 'total_budget.amount')) {
    const currency = typeof buy.total_budget === 'object' ? buy.total_budget.currency : buy.currency;
    if (currency === undefined) return unknown('currency', 'total_budget.currency');
    if (request.total_budget.currency !== currency) return exceeded('currency_mismatch', 'total_budget.currency');
  }
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
    if (
      !values.length &&
      term.action === 'update_budget_allocation' &&
      relevant.some(m => m.field === 'budget_allocation')
    ) {
      const amount = typeof buy.total_budget === 'object' ? buy.total_budget.amount : buy.total_budget;
      values.push({
        action: term.action,
        field: 'budget_allocation',
        path: 'budget_allocation',
        scope: 'buy',
        from: amount,
        to: amount,
      });
    }
    if (!values.length) return unknown('cannot_preflight', term.action);
    const currency = typeof buy.total_budget === 'object' ? buy.total_budget.currency : buy.currency;
    for (const m of values) {
      if (m.to === null && m.field === 'packages[].budget' && term.action === 'increase_budget') {
        if (c.max_delta_amount || c.max_delta_percent !== undefined || c.max_result_amount)
          return exceeded('unbounded_result', m.path);
        continue;
      }
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
    const path = relevant[0]?.path ?? (term.action === 'cancel' ? 'canceled' : 'paused');
    if (c.minimum_notice !== undefined) {
      if (elapsedDuration(c.minimum_notice) === undefined) recordUnknown('minimum_notice', path);
      else return exceeded('minimum_notice', path);
    }
    if ((c.earliest_effective_at !== undefined || c.latest_effective_at !== undefined) && !finite(options.now))
      recordUnknown('request_time', path);
    else if (finite(options.now)) {
      if (c.earliest_effective_at !== undefined && options.now < Date.parse(c.earliest_effective_at))
        return exceeded('earliest_effective_at', path);
      if (c.latest_effective_at !== undefined && options.now > Date.parse(c.latest_effective_at))
        return exceeded('latest_effective_at', path);
    }
  }
  return unresolved ?? { status: 'satisfied' };
}
