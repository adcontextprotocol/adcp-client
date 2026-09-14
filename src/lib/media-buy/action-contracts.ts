import {
  CANONICAL_ACTION_TASKS,
  CHANGE_CONSTRAINT_ACTIONS,
  CHANGE_TERM_ACTIONS,
  LEGACY_AVAILABLE_ACTIONS,
} from './action-metadata.generated';
import { V3_1_ACTION_IDS } from './legacy-action-ids';
import { validActionsForStatus } from '../server/media-buy-helpers';
import { getRollupParent } from './available-actions';
import type {
  MediaBuyAction,
  MediaBuyTask,
  ProposalChangeTerm,
  ProductActionTemplate,
  MediaBuyStatus,
} from './action-types';
import type { MediaBuyActionId, SLAWindow } from './types';

export const NON_TERMINAL_ACTION_STATUSES = ['pending_creatives', 'pending_start', 'active', 'paused'] as const;
const MODES = ['self_serve', 'conditional_self_serve', 'seller_managed', 'requires_approval'];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Canonical task alternatives. The live entry chooses among these; mode never selects a task. */
export function mediaBuyActionTasks(action: MediaBuyAction): readonly MediaBuyTask[] {
  // Reviewed rc.3 additive action (adcp-client#2907). Remove this bridge once the pin includes it.
  if (action === 'update_media_buy_frequency_cap') return ['control_media_buy', 'refine_proposals'];
  return Object.hasOwn(CANONICAL_ACTION_TASKS, action)
    ? ((CANONICAL_ACTION_TASKS as Readonly<Record<string, readonly MediaBuyTask[]>>)[action] ?? [])
    : [];
}

/** The canonical default, only usable with a known current right and validated live entry. */
export function defaultMediaBuyActionTask(action: MediaBuyAction): MediaBuyTask | undefined {
  return (['control_media_buy', 'refine_proposals', 'sync_creatives'] as const).find(task =>
    mediaBuyActionTasks(action).includes(task)
  );
}

export function actionAllowedStatuses(term: Pick<ProposalChangeTerm, 'action' | 'allowed_statuses'>): MediaBuyStatus[] {
  return NON_TERMINAL_ACTION_STATUSES.filter(status => {
    if (term.allowed_statuses && !term.allowed_statuses.includes(status)) return false;
    // Use the existing status helper for operational lifecycle actions; explicit
    // negotiated scopes can enable other modifications in any non-terminal state.
    if (['pause', 'resume', 'cancel'].includes(term.action)) {
      return validActionsForStatus(status).includes(term.action as 'pause' | 'resume' | 'cancel');
    }
    if (term.allowed_statuses) return true;
    const parent =
      getRollupParent(term.action as MediaBuyActionId) ??
      (['update_budget_allocation', 'update_spend_target'].includes(term.action) ? 'update_budget' : 'update_packages');
    const defaults = validActionsForStatus(status);
    return defaults.includes((term.action === 'add_packages' ? term.action : parent) as (typeof defaults)[number]);
  });
}

/** Elapsed durations only. Calendar/campaign lengths require seller state and remain unknown. */
export function elapsedDuration(value: unknown): number | undefined {
  if (!record(value) || !Number.isSafeInteger(value.interval) || (value.interval as number) < 1) return undefined;
  const factor = ({ seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 } as Record<string, number>)[
    String(value.unit)
  ];
  if (factor === undefined) return undefined;
  const result = (value.interval as number) * factor;
  return Number.isFinite(result) ? result : undefined;
}
function isoElapsed(value: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(x => x !== undefined)) return undefined;
  const result =
    Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  return Number.isFinite(result) ? result : undefined;
}
/** Runtime may retain or tighten elapsed maxima; absent committed maxima cannot be dropped. */
export function slaWithin(ceiling: SLAWindow | undefined, candidate: SLAWindow | undefined): boolean {
  for (const key of ['response_max', 'completion_max'] as const) {
    const promised = ceiling?.[key];
    if (promised === undefined) continue;
    const actual = candidate?.[key];
    if (actual === promised) continue;
    if (actual === undefined) return false;
    const a = isoElapsed(actual),
      b = isoElapsed(promised);
    if (a === undefined || b === undefined || a > b) return false;
  }
  return true;
}

const CONSTRAINT_FIELDS: Record<string, readonly string[]> = {
  budget: ['max_delta_amount', 'max_delta_percent', 'min_result_amount', 'max_result_amount'],
  flight: ['max_change', 'earliest_result', 'latest_result', 'minimum_notice'],
  package_count: ['max_additions', 'max_removals', 'max_result_count'],
  effective_timing: ['minimum_notice', 'earliest_effective_at', 'latest_effective_at'],
};

/** Structural/action checks for this pure helper, not a replacement for proposal schema/digest verification. */
export function changeConstraintIssues(action: MediaBuyAction, constraints: unknown, currency?: string): string[] {
  if (constraints === undefined) return [];
  if (!record(constraints)) return ['constraints must be an object'];
  const kind = String(constraints.kind);
  const fields = Object.hasOwn(CONSTRAINT_FIELDS, kind) ? CONSTRAINT_FIELDS[kind] : undefined;
  const actions = Object.hasOwn(CHANGE_CONSTRAINT_ACTIONS, kind)
    ? (CHANGE_CONSTRAINT_ACTIONS as Record<string, readonly string[]>)[kind]
    : undefined;
  if (!fields || !actions?.includes(action)) return ['constraint/action incompatibility'];
  if (Object.keys(constraints).some(key => key !== 'kind' && !fields.includes(key)))
    return ['unknown constraint field'];
  if (!fields.some(key => constraints[key] !== undefined)) return ['empty constraints'];
  const issues: string[] = [];
  for (const key of fields) {
    const value = constraints[key];
    if (value === undefined) continue;
    if (key.endsWith('_amount')) {
      if (
        !record(value) ||
        !finite(value.amount) ||
        typeof value.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(value.currency) ||
        Object.keys(value).some(k => !['amount', 'currency'].includes(k)) ||
        (currency !== undefined && value.currency !== currency)
      )
        issues.push(`invalid ${key}`);
    } else if (key === 'max_change' || key === 'minimum_notice') {
      if (
        !record(value) ||
        !Number.isSafeInteger(value.interval) ||
        (value.interval as number) < 1 ||
        !['seconds', 'minutes', 'hours', 'days', 'campaign'].includes(String(value.unit)) ||
        (value.unit === 'campaign' && value.interval !== 1) ||
        Object.keys(value).some(k => !['interval', 'unit'].includes(k))
      )
        issues.push(`invalid ${key}`);
    } else if (key.startsWith('earliest_') || key.startsWith('latest_')) {
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) issues.push(`invalid ${key}`);
    } else if (!finite(value) || (constraints.kind === 'package_count' && !Number.isSafeInteger(value)))
      issues.push(`invalid ${key}`);
  }
  const min = constraints.min_result_amount,
    max = constraints.max_result_amount;
  if (record(min) && record(max) && (min.currency !== max.currency || Number(min.amount) > Number(max.amount)))
    issues.push('inconsistent money bounds');
  for (const [a, b] of [
    ['earliest_result', 'latest_result'],
    ['earliest_effective_at', 'latest_effective_at'],
  ] as const) {
    if (
      typeof constraints[a] === 'string' &&
      typeof constraints[b] === 'string' &&
      Date.parse(constraints[a]) > Date.parse(constraints[b])
    )
      issues.push('inconsistent time bounds');
  }
  return issues;
}

export function slaValid(sla: unknown): boolean {
  return (
    sla === undefined ||
    (record(sla) &&
      Object.entries(sla).every(
        ([k, v]) =>
          ['response_max', 'completion_max'].includes(k) &&
          typeof v === 'string' &&
          /^P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(\d+H)?(\d+M)?(\d+S)?)?$/.test(v)
      ))
  );
}
export function changeTermIssues(terms: readonly ProposalChangeTerm[], currency?: string): string[] {
  if (!Array.isArray(terms as unknown) || terms.length > 256) return ['invalid change_terms array'];
  const ids = new Set<string>(),
    actions = new Set<string>(),
    issues: string[] = [];
  for (const term of terms) {
    if (!record(term)) {
      issues.push('invalid change term');
      continue;
    }
    if (typeof term.term_id !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(term.term_id) || ids.has(term.term_id))
      issues.push('invalid or duplicate term identity');
    if (
      actions.has(term.action) ||
      (!(CHANGE_TERM_ACTIONS as readonly string[]).includes(term.action) &&
        term.action !== 'update_media_buy_frequency_cap')
    )
      issues.push('invalid or duplicate action identity');
    if (!MODES.includes(term.service_mode)) issues.push('invalid service mode');
    if (
      term.allowed_statuses !== undefined &&
      (!Array.isArray(term.allowed_statuses) ||
        !term.allowed_statuses.length ||
        new Set(term.allowed_statuses).size !== term.allowed_statuses.length ||
        term.allowed_statuses.some(s => !NON_TERMINAL_ACTION_STATUSES.includes(s)))
    )
      issues.push('invalid status scope');
    if (
      term.conditions !== undefined &&
      (!Array.isArray(term.conditions) ||
        !term.conditions.length ||
        new Set(term.conditions).size !== term.conditions.length ||
        term.conditions.some(c => typeof c !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(c)))
    )
      issues.push('invalid conditions');
    if (!slaValid(term.processing_sla)) issues.push('invalid SLA');
    for (const key of ['terms_ref', 'description'] as const)
      if (term[key] !== undefined && (typeof term[key] !== 'string' || !term[key].length || term[key].length > 1000))
        issues.push(`invalid ${key}`);
    if (
      Object.keys(term).some(
        k =>
          ![
            'term_id',
            'action',
            'service_mode',
            'allowed_statuses',
            'processing_sla',
            'constraints',
            'conditions',
            'terms_ref',
            'description',
            'ext',
          ].includes(k)
      )
    )
      issues.push('unknown change term field');
    issues.push(...changeConstraintIssues(term.action, term.constraints, currency));
    ids.add(term.term_id);
    actions.add(term.action);
  }
  return issues;
}

export function productTemplateIssues(templates: readonly ProductActionTemplate[], currency?: string): string[] {
  if (!Array.isArray(templates as unknown) || templates.length > 256) return ['invalid allowed_actions array'];
  const seen = new Set<string>(),
    issues: string[] = [];
  for (const template of templates) {
    if (!record(template) || seen.has(template.action)) {
      issues.push('duplicate or invalid product action');
      continue;
    }
    seen.add(template.action);
    if (
      !Array.isArray(template.modes) ||
      !template.modes.length ||
      new Set(template.modes).size !== template.modes.length ||
      template.modes.some(m => !MODES.includes(m))
    )
      issues.push('invalid product modes');
    issues.push(
      ...changeTermIssues(
        [
          {
            term_id: 'template',
            action: template.action,
            service_mode: template.modes?.[0],
            allowed_statuses: undefined,
            processing_sla: template.sla,
            constraints: template.constraints,
            terms_ref: template.terms_ref,
          },
        ],
        currency
      ).filter(issue => issue !== 'invalid or duplicate action identity')
    );
    if (
      ![...CHANGE_TERM_ACTIONS, ...LEGACY_AVAILABLE_ACTIONS, 'update_media_buy_frequency_cap'].includes(template.action)
    )
      issues.push('invalid product action');
    if (
      template.allowed_statuses !== undefined &&
      (!Array.isArray(template.allowed_statuses) ||
        !template.allowed_statuses.length ||
        new Set(template.allowed_statuses).size !== template.allowed_statuses.length ||
        template.allowed_statuses.some(
          status => ![...NON_TERMINAL_ACTION_STATUSES, 'completed', 'rejected', 'canceled'].includes(status)
        ))
    )
      issues.push('invalid product status scope');
  }
  return issues;
}

/** Match advisory rollups only; accepted rights always retain exact canonical identity. */
export function findProductAction(
  templates: readonly ProductActionTemplate[] | undefined,
  action: MediaBuyAction
): ProductActionTemplate | undefined {
  return templates?.find(t => t.action === action) ?? templates?.find(t => t.action === getRollupParent(action));
}

export function legacyActionSupported(action: MediaBuyAction): boolean {
  return (V3_1_ACTION_IDS as readonly string[]).includes(action);
}

/** Structural live-entry validation; unknown action/mode strings remain opaque. */
export function liveActionIssues(entries: unknown): string[] {
  if (!Array.isArray(entries)) return ['invalid live action array'];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !record(entry) ||
      typeof entry.action !== 'string' ||
      !entry.action ||
      typeof entry.mode !== 'string' ||
      !entry.mode ||
      seen.has(entry.action)
    )
      return ['invalid or duplicate live action'];
    seen.add(entry.action);
    if (
      entry.task !== undefined &&
      !['control_media_buy', 'refine_proposals', 'sync_creatives'].includes(String(entry.task))
    )
      return ['invalid live task'];
    if (!slaValid(entry.sla)) return ['invalid live SLA'];
    if (
      entry.change_term_id !== undefined &&
      (typeof entry.change_term_id !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(entry.change_term_id))
    )
      return ['invalid live term identity'];
    if (entry.terms_ref !== undefined && typeof entry.terms_ref !== 'string') return ['invalid opaque reference'];
    if (
      entry.applicable_package_ids !== undefined &&
      (!Array.isArray(entry.applicable_package_ids) ||
        !entry.applicable_package_ids.length ||
        entry.applicable_package_ids.some(id => typeof id !== 'string' || !id) ||
        new Set(entry.applicable_package_ids).size !== entry.applicable_package_ids.length)
    )
      return ['invalid package scope'];
  }
  return [];
}
