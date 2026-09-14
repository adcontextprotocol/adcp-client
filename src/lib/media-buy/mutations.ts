import type { MediaBuyActionContext, MediaBuyActionId, MediaBuyValidAction, UpdateMediaBuyRequestLike } from './types';
import { ACTIONS_BY_FIELD } from './update-fields.generated';

// Float tolerance for comparing summed budgets across packages. Below this
// difference, two totals are treated as equal (absorbs cent-rounding from
// per-package decimal math). Half a cent is the smallest representable
// difference any current AdCP currency cares about. If a future spec
// extension allows sub-cent / micro-amount pricing (e.g. programmatic
// auction-side bidding) this tolerance would mask real reallocations and
// should be tightened or made currency-aware.
const BUDGET_EQUAL_TOLERANCE = 0.005;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type MediaBuyMutationDirection = 'increase' | 'decrease' | 'reallocate' | 'extend' | 'shorten' | 'shift';

/**
 * One action a request body covers, plus the direction inference where the
 * fine-grained vocabulary distinguishes increase/decrease or
 * extend/shorten. `touched_fields` lists the normalized dotted paths that
 * triggered this entry (useful for debugging).
 */
export interface ResolvedAction {
  action: MediaBuyActionId;
  /**
   * Direction tag. Present when the resolver picked between fine-grained
   * siblings (e.g. `increase_budget` vs `decrease_budget`).
   */
  direction?: MediaBuyMutationDirection;
  touched_fields: string[];
}

export type MediaBuyMutationScope = 'buy' | 'package' | 'packages';

/**
 * One concrete requested mutation inside an `update_media_buy` patch.
 *
 * `field` is the normalized schema path used for action mapping
 * (`packages[].budget`), while `path` is the concrete request path
 * (`packages[0].budget`) that adopter code can use for diagnostics or
 * dispatch. `from` is best-effort and only populated for fields the helper can
 * read from the supplied current buy snapshot.
 */
export interface DecomposedUpdateMediaBuyMutation {
  action: MediaBuyActionId;
  direction?: MediaBuyMutationDirection;
  field: string;
  path: string;
  scope: MediaBuyMutationScope;
  package_id?: string;
  package_index?: number;
  from?: unknown;
  to?: unknown;
}

export interface DecomposedUpdateMediaBuy {
  /** Concrete mutations requested by the patch. Empty when no known fields were touched. */
  mutations: DecomposedUpdateMediaBuyMutation[];
  /** Aggregated action view, preserving the legacy `getActionForMutation()` shape. */
  actions: ResolvedAction[];
  /** Unique normalized fields touched by this patch, in request traversal order. */
  touched_fields: string[];
}

/**
 * Walk the request body and return the set of fine-grained actions it
 * covers. Compatibility wrapper over `decomposeUpdateMediaBuy()` for callers
 * that only need the action-level view.
 *
 * Returns an empty array when the request touches no recognized field
 * (e.g. only `idempotency_key` / `revision` / `account` were set).
 */
export function getActionForMutation(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): ResolvedAction[] {
  return decomposeUpdateMediaBuy(currentBuy, request).actions;
}

/**
 * Decompose an `update_media_buy` patch into the concrete mutations it
 * requests plus the fine-grained actions those mutations require.
 *
 * This is intentionally read-only: it does not validate availability or
 * mutate the request. Buyer code can use it for previews and preflight;
 * seller/adopter code can use it to dispatch individual patch operations
 * without re-walking the raw request.
 */
export function decomposeUpdateMediaBuy(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): DecomposedUpdateMediaBuy {
  const mutations: DecomposedUpdateMediaBuyMutation[] = [];
  const currentPackages = new Map<string, NonNullable<MediaBuyActionContext['packages']>[number]>();

  for (const pkg of currentBuy.packages ?? []) {
    if (pkg.package_id) currentPackages.set(pkg.package_id, pkg);
  }

  const push = (mutation: DecomposedUpdateMediaBuyMutation): void => {
    mutations.push(mutation);
  };

  const budgetMutation = (from: unknown, to: unknown, field: string, path = field, package_id?: string): void => {
    // A missing cap/baseline cannot be interpreted as zero. Keep the coarse
    // vocabulary so strict assessment cannot accidentally approve a direction.
    const action =
      typeof from !== 'number' || !Number.isFinite(from) || typeof to !== 'number' || !Number.isFinite(to)
        ? 'update_budget'
        : to > from
          ? 'increase_budget'
          : to < from
            ? 'decrease_budget'
            : 'reallocate_budget';
    push({ action, field, path, from, to, scope: package_id ? 'package' : 'buy', ...(package_id && { package_id }) });
  };
  if (request.total_budget !== undefined)
    budgetMutation(
      typeof currentBuy.total_budget === 'object' ? currentBuy.total_budget.amount : currentBuy.total_budget,
      request.total_budget.amount,
      'total_budget.amount'
    );
  if (request.daily_budget_cap !== undefined)
    budgetMutation(currentBuy.daily_budget_cap, request.daily_budget_cap, 'daily_budget_cap');

  if (request.paused !== undefined) {
    push({
      action: request.paused === false ? 'resume' : 'pause',
      field: 'paused',
      path: 'paused',
      scope: 'buy',
      to: request.paused,
    });
  }

  if (request.canceled !== undefined) {
    push({
      action: 'cancel',
      field: 'canceled',
      path: 'canceled',
      scope: 'buy',
      to: request.canceled,
    });
  }

  if (request.cancellation_reason !== undefined) {
    push({
      action: 'cancel',
      field: 'cancellation_reason',
      path: 'cancellation_reason',
      scope: 'buy',
      to: request.cancellation_reason,
    });
  }

  if (request.start_time !== undefined) {
    push({
      action: 'update_flight_dates',
      direction: 'shift',
      field: 'start_time',
      path: 'start_time',
      scope: 'buy',
      from: currentBuy.start_time,
      to: request.start_time,
    });
  }

  if (request.end_time !== undefined) {
    const pick = resolveFlightEndDirection(currentBuy, request, 'end_time');
    push({
      ...pick,
      field: 'end_time',
      path: 'end_time',
      scope: 'buy',
      from: currentBuy.end_time,
      to: request.end_time,
    });
  }

  if (request.frequency_cap !== undefined) {
    // MediaBuy-level shared cap (AdCP 3.2). Its action is structured-only
    // (`update_media_buy_frequency_cap`) and lives in
    // core/media-buy-available-action-id.json, so the binding is read from
    // the generated table instead of being hardcoded: on schema pins that
    // predate that file there is no binding and the field is left unmapped
    // exactly like any other unrecognized request key.
    const frequencyCapAction =
      ACTIONS_BY_FIELD['frequency_cap']?.[0] ??
      (currentBuy.accepted_proposal?.commercial_terms?.change_terms !== undefined
        ? 'update_media_buy_frequency_cap'
        : undefined);
    if (frequencyCapAction) {
      push({
        action: frequencyCapAction,
        field: 'frequency_cap',
        path: 'frequency_cap',
        scope: 'buy',
        to: request.frequency_cap,
      });
    }
  }

  if (request.new_packages !== undefined && request.new_packages.length > 0) {
    push({
      action: 'add_packages',
      field: 'new_packages',
      path: 'new_packages',
      scope: 'packages',
      to: request.new_packages,
    });
  }

  if (request.packages) {
    const budgetPick = resolveBudgetDirection(currentBuy, request);
    const completeBudgetBaselines =
      new Set(request.packages.map(pkg => pkg.package_id)).size === request.packages.length &&
      new Set((currentBuy.packages ?? []).map(pkg => pkg.package_id)).size === (currentBuy.packages ?? []).length &&
      request.packages.every(
        pkg =>
          pkg.budget === undefined ||
          (Number.isFinite(pkg.budget) && Number.isFinite(currentPackages.get(pkg.package_id)?.budget))
      );
    const packageEndPick = resolveFlightEndDirection(currentBuy, request, 'packages[].end_time');

    request.packages.forEach((pkg, index) => {
      const currentPkg = currentPackages.get(pkg.package_id);
      const base = {
        scope: 'package' as const,
        package_id: pkg.package_id,
        package_index: index,
      };

      if (pkg.canceled !== undefined) {
        push({
          action: 'remove_packages',
          field: 'packages[].canceled',
          path: `packages[${index}].canceled`,
          ...base,
          to: pkg.canceled,
        });
      }
      // `pkg.paused` has no entry in the generated action mapping - the
      // spec keys pause/resume at the buy level only. Drop silently so the
      // resolver doesn't conflate it with the top-level `paused` action.

      if (pkg.budget !== undefined) {
        push({
          ...(currentBuy.accepted_proposal?.commercial_terms?.change_terms === undefined
            ? budgetPick
            : budgetPick.action === 'reallocate_budget' && completeBudgetBaselines && typeof pkg.budget === 'number'
              ? budgetPick
              : pkg.budget === null && Number.isFinite(currentPkg?.budget)
                ? { action: 'increase_budget' as const, direction: 'increase' as const }
                : typeof currentPkg?.budget !== 'number' ||
                    !Number.isFinite(currentPkg.budget) ||
                    typeof pkg.budget !== 'number' ||
                    !Number.isFinite(pkg.budget)
                  ? { action: 'update_budget' as const }
                  : pkg.budget > currentPkg.budget
                    ? { action: 'increase_budget' as const, direction: 'increase' as const }
                    : pkg.budget < currentPkg.budget
                      ? { action: 'decrease_budget' as const, direction: 'decrease' as const }
                      : budgetPick),
          field: 'packages[].budget',
          path: `packages[${index}].budget`,
          ...base,
          from: currentPkg?.budget,
          to: pkg.budget,
        });
      }
      if (pkg.daily_budget_cap !== undefined)
        budgetMutation(
          currentPkg?.daily_budget_cap,
          pkg.daily_budget_cap,
          'packages[].daily_budget_cap',
          `packages[${index}].daily_budget_cap`,
          pkg.package_id
        );

      if (pkg.pacing !== undefined) {
        push({
          action: 'update_pacing',
          field: 'packages[].pacing',
          path: `packages[${index}].pacing`,
          ...base,
          to: pkg.pacing,
        });
      }

      if (pkg.start_time !== undefined) {
        push({
          action: 'update_flight_dates',
          direction: 'shift',
          field: 'packages[].start_time',
          path: `packages[${index}].start_time`,
          ...base,
          from: currentPkg?.start_time,
          to: pkg.start_time,
        });
      }

      if (pkg.end_time !== undefined) {
        push({
          ...(currentBuy.accepted_proposal?.commercial_terms?.change_terms !== undefined &&
          !request.start_time &&
          !request.packages?.some(p => p.start_time !== undefined)
            ? !Number.isFinite(Date.parse(currentPkg?.end_time ?? ''))
              ? { action: 'update_dates' as const }
              : {
                  action:
                    Date.parse(pkg.end_time) > Date.parse(currentPkg!.end_time!)
                      ? ('extend_flight' as const)
                      : Date.parse(pkg.end_time) < Date.parse(currentPkg!.end_time!)
                        ? ('shorten_flight' as const)
                        : ('update_flight_dates' as const),
                }
            : packageEndPick),
          field: 'packages[].end_time',
          path: `packages[${index}].end_time`,
          ...base,
          from: currentPkg?.end_time,
          to: pkg.end_time,
        });
      }

      if (pkg.creative_assignments !== undefined) {
        push({
          action: 'update_creative_assignments',
          field: 'packages[].creative_assignments',
          path: `packages[${index}].creative_assignments`,
          ...base,
          to: pkg.creative_assignments,
        });
      }

      if (pkg.creatives !== undefined) {
        push({
          action: 'replace_creative',
          field: 'packages[].creatives',
          path: `packages[${index}].creatives`,
          ...base,
          to: pkg.creatives,
        });
      }

      if (pkg.keyword_targets_add !== undefined) {
        push({
          action: 'update_targeting',
          field: 'packages[].keyword_targets_add',
          path: `packages[${index}].keyword_targets_add`,
          ...base,
          to: pkg.keyword_targets_add,
        });
      }

      if (pkg.keyword_targets_remove !== undefined) {
        push({
          action: 'update_targeting',
          field: 'packages[].keyword_targets_remove',
          path: `packages[${index}].keyword_targets_remove`,
          ...base,
          to: pkg.keyword_targets_remove,
        });
      }

      if (pkg.negative_keywords_add !== undefined) {
        push({
          action: 'update_targeting',
          field: 'packages[].negative_keywords_add',
          path: `packages[${index}].negative_keywords_add`,
          ...base,
          to: pkg.negative_keywords_add,
        });
      }

      if (pkg.negative_keywords_remove !== undefined) {
        push({
          action: 'update_targeting',
          field: 'packages[].negative_keywords_remove',
          path: `packages[${index}].negative_keywords_remove`,
          ...base,
          to: pkg.negative_keywords_remove,
        });
      }

      if (pkg.targeting_overlay !== undefined) {
        // `frequency_cap` is the only nested field with its own action.
        // Touching the whole overlay falls through to update_targeting.
        const overlayKeys = Object.keys(pkg.targeting_overlay);
        if (Object.hasOwn(pkg.targeting_overlay, 'frequency_cap')) {
          push({
            action: 'update_frequency_caps',
            field: 'packages[].targeting_overlay.frequency_cap',
            path: `packages[${index}].targeting_overlay.frequency_cap`,
            ...base,
            to: pkg.targeting_overlay.frequency_cap,
          });
        }
        if (overlayKeys.length === 0 || overlayKeys.some(key => key !== 'frequency_cap')) {
          push({
            action: 'update_targeting',
            field: 'packages[].targeting_overlay',
            path: `packages[${index}].targeting_overlay`,
            ...base,
            to: pkg.targeting_overlay,
          });
        }
      }
    });
  }

  // Schema metadata covers additive unambiguous fields. Directional fields
  // above retain their explicit decomposition; no request value grants a route.
  const addMetadataFields = (value: object, prefix: string, index?: number, package_id?: string): void => {
    for (const [key, to] of Object.entries(value)) {
      const field = prefix + key;
      if (field === 'packages[].targeting_overlay') continue; // decomposed above, including its cap-only branch
      if (to === undefined || mutations.some(m => m.field === field && m.package_id === package_id)) continue;
      const actions = Object.hasOwn(ACTIONS_BY_FIELD, field) ? ACTIONS_BY_FIELD[field] : undefined;
      if (actions?.length !== 1) continue;
      const from =
        index === undefined
          ? (currentBuy as unknown as Record<string, unknown>)[key]
          : (currentPackages.get(package_id!) as Record<string, unknown> | undefined)?.[key];
      push({
        action: actions[0]!,
        field,
        path: index === undefined ? key : `packages[${index}].${key}`,
        scope: index === undefined ? 'buy' : 'package',
        from,
        to,
        ...(package_id && { package_id, package_index: index }),
      });
    }
  };
  addMetadataFields(request, '');
  request.packages?.forEach((pkg, i) => addMetadataFields(pkg, 'packages[].', i, pkg.package_id));

  // Canonical control fields differ from legacy update rollups. These bindings
  // follow the merged #6750 reference seller's actionsForUpdateRequest; the
  // canonical task allowlist is still generated from the selected bundle.
  if (currentBuy.accepted_proposal?.commercial_terms?.change_terms !== undefined) {
    const canonicalFields: Record<string, MediaBuyActionId> = {
      reporting_webhook: 'update_reporting_webhook',
      budget_cap_timezone: 'update_pacing',
      'packages[].keyword_targets_add': 'update_keywords',
      'packages[].keyword_targets_remove': 'update_keywords',
      'packages[].negative_keywords_add': 'update_keywords',
      'packages[].negative_keywords_remove': 'update_keywords',
      'packages[].catalog_ids': 'update_catalog_assignments',
      'packages[].optimization_goals': 'update_optimization_goals',
      'packages[].impressions': 'update_impression_goal',
      'packages[].min_spend_target': 'update_spend_target',
    };
    for (const mutation of mutations)
      if (Object.hasOwn(canonicalFields, mutation.field)) mutation.action = canonicalFields[mutation.field]!;
    const addCanonical = (values: object, index?: number) => {
      for (const [key, to] of Object.entries(values)) {
        const field = index === undefined ? key : `packages[].${key}`;
        const path = index === undefined ? key : `packages[${index}].${key}`;
        if (to === undefined || !Object.hasOwn(canonicalFields, field) || mutations.some(m => m.path === path))
          continue;
        const package_id = index === undefined ? undefined : request.packages![index]!.package_id;
        push({
          action: canonicalFields[field]!,
          field,
          path,
          scope: index === undefined ? 'buy' : 'package',
          to,
          ...(package_id && { package_id, package_index: index }),
          from:
            index === undefined
              ? (currentBuy as unknown as Record<string, unknown>)[key]
              : (currentPackages.get(package_id!) as Record<string, unknown> | undefined)?.[key],
        });
      }
    };
    addCanonical(request);
    request.packages?.forEach((pkg, index) => addCanonical(pkg, index));
  }

  return {
    mutations,
    actions: aggregateResolvedActions(mutations),
    touched_fields: uniqueFields(mutations),
  };
}

function aggregateResolvedActions(mutations: ReadonlyArray<DecomposedUpdateMediaBuyMutation>): ResolvedAction[] {
  const resolved = new Map<MediaBuyActionId, ResolvedAction>();

  for (const mutation of mutations) {
    const existing = resolved.get(mutation.action);
    if (existing) {
      if (existing.direction === undefined && mutation.direction !== undefined) {
        existing.direction = mutation.direction;
      }
      if (!existing.touched_fields.includes(mutation.field)) {
        existing.touched_fields.push(mutation.field);
      }
      continue;
    }

    resolved.set(mutation.action, {
      action: mutation.action,
      direction: mutation.direction,
      touched_fields: [mutation.field],
    });
  }

  return [...resolved.values()];
}

function uniqueFields(mutations: ReadonlyArray<DecomposedUpdateMediaBuyMutation>): string[] {
  const fields: string[] = [];
  for (const mutation of mutations) {
    if (!fields.includes(mutation.field)) fields.push(mutation.field);
  }
  return fields;
}

function resolveBudgetDirection(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): { action: MediaBuyValidAction; direction: MediaBuyMutationDirection } {
  const currentByPkg = new Map<string, number>();
  for (const pkg of currentBuy.packages ?? []) {
    if (pkg.package_id && typeof pkg.budget === 'number') {
      currentByPkg.set(pkg.package_id, pkg.budget);
    }
  }

  let currentTotal = 0;
  let proposedTotal = 0;
  let sawIncrease = false;
  let sawDecrease = false;

  for (const pkg of request.packages ?? []) {
    if (typeof pkg.budget !== 'number') continue;
    const prev = currentByPkg.get(pkg.package_id);
    if (prev === undefined) {
      // No baseline - treat as increase (mirrors how sellers see a new
      // budget on a previously-zero line).
      sawIncrease = true;
      proposedTotal += pkg.budget;
      continue;
    }
    currentTotal += prev;
    proposedTotal += pkg.budget;
    if (pkg.budget > prev) sawIncrease = true;
    if (pkg.budget < prev) sawDecrease = true;
  }

  // Reallocate: per-package movement in both directions but total
  // unchanged (within float tolerance to absorb cent rounding).
  const tolerance =
    currentBuy.accepted_proposal?.commercial_terms?.change_terms !== undefined
      ? Number.EPSILON * Math.max(1, Math.abs(proposedTotal), Math.abs(currentTotal))
      : BUDGET_EQUAL_TOLERANCE;
  if (sawIncrease && sawDecrease && Math.abs(proposedTotal - currentTotal) < tolerance) {
    return { action: 'reallocate_budget', direction: 'reallocate' };
  }
  if (proposedTotal > currentTotal) return { action: 'increase_budget', direction: 'increase' };
  if (proposedTotal < currentTotal) return { action: 'decrease_budget', direction: 'decrease' };

  // Equal totals with no per-package movement (e.g. budget set to same
  // value) - defaults to reallocate so the request still has *some*
  // action attached for the preflight to check against.
  return { action: 'reallocate_budget', direction: 'reallocate' };
}

function resolveFlightEndDirection(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike,
  field: 'end_time' | 'packages[].end_time'
): { action: MediaBuyValidAction; direction: MediaBuyMutationDirection } {
  // If start_time is being touched at the same time, the action is
  // update_flight_dates regardless of end direction (shift semantics).
  if (request.start_time !== undefined) {
    return { action: 'update_flight_dates', direction: 'shift' };
  }
  const packageStartTouched = (request.packages ?? []).some(pkg => pkg.start_time !== undefined);
  if (packageStartTouched) {
    return { action: 'update_flight_dates', direction: 'shift' };
  }

  if (field === 'end_time') {
    const currentEnd = currentBuy.end_time;
    const proposedEnd = request.end_time;
    if (currentEnd && proposedEnd) {
      const cur = Date.parse(currentEnd);
      const next = Date.parse(proposedEnd);
      if (!Number.isNaN(cur) && !Number.isNaN(next)) {
        if (next > cur) return { action: 'extend_flight', direction: 'extend' };
        if (next < cur) return { action: 'shorten_flight', direction: 'shorten' };
      }
    }
    // Indeterminate (missing baseline or unparseable dates). Fall through
    // to the generic vocabulary; sellers that advertise either of the
    // direction-specific actions usually also advertise update_flight_dates.
    return { action: 'update_flight_dates', direction: 'shift' };
  }

  // packages[].end_time
  let extending = false;
  let shortening = false;
  const currentByPkg = new Map<string, string | undefined>();
  for (const pkg of currentBuy.packages ?? []) {
    if (pkg.package_id) currentByPkg.set(pkg.package_id, pkg.end_time);
  }
  for (const pkg of request.packages ?? []) {
    if (!pkg.end_time) continue;
    const prev = currentByPkg.get(pkg.package_id);
    if (!prev) {
      extending = true;
      continue;
    }
    const cur = Date.parse(prev);
    const next = Date.parse(pkg.end_time);
    if (Number.isNaN(cur) || Number.isNaN(next)) continue;
    if (next > cur) extending = true;
    if (next < cur) shortening = true;
  }
  if (extending && !shortening) return { action: 'extend_flight', direction: 'extend' };
  if (shortening && !extending) return { action: 'shorten_flight', direction: 'shorten' };
  // Mixed or indeterminate - fall through to update_flight_dates.
  return { action: 'update_flight_dates', direction: 'shift' };
}

/** Fail closed on unmodeled mutation fields; envelope data does not create an action. */
export function hasUnmappedMutation(
  request: UpdateMediaBuyRequestLike,
  decomposition: DecomposedUpdateMediaBuy
): boolean {
  const envelope = new Set([
    'media_buy_id',
    'account',
    'revision',
    'idempotency_key',
    'adcp_version',
    'adcp_major_version',
    'context_id',
    'context',
    'governance_context',
    'push_notification_config',
  ]);
  const paths = decomposition.mutations.map(m => m.path);
  const covered = (path: string) => paths.some(p => p === path || p.startsWith(`${path}.`));
  return (
    Object.entries(request).some(
      ([key, value]) =>
        value !== undefined &&
        key !== 'packages' &&
        !(key === 'new_packages' && Array.isArray(value) && value.length === 0) &&
        !envelope.has(key) &&
        !covered(key)
    ) ||
    !!request.packages?.some((pkg, index) =>
      Object.entries(pkg).some(
        ([key, value]) => value !== undefined && key !== 'package_id' && !covered(`packages[${index}].${key}`)
      )
    )
  );
}
