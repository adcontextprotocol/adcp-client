/**
 * `sync_principal` `reporting_subscriptions` section (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3): validation, versioning and readback.
 *
 * Pure functions over the principal row. The principal runtime calls them inside its
 * single CAS transaction, so a subscription write is atomic with the other sections
 * (in particular the `reporting_destinations` a subscription must name).
 */
import { canonicalJsonSha256 } from '../../utils/jcs';
import type { ReportingSubscription, ReportingSubscriptionState } from '../../types/core.generated';
import { assertReportingIanaTimezoneV1, parseReportingPeriodDurationV1 } from '../../reporting/subscriptions/calendar';
import type { ReportingSubscriptionDestinationMethodV1 } from '../../reporting/subscriptions/selection';
import type { PrincipalReportingDestination } from './types';

export type { ReportingSubscription, ReportingSubscriptionState };

/** One accepted version, with the configuration the readback no longer carries. */
export interface StoredReportingSubscriptionVersion {
  subscriptionVersion: number;
  acceptedAt: string;
  supersededAt?: string;
  /** The version's configuration with `active` normalized to true. */
  configuration: ReportingSubscription;
  /** Pattern and transport of the destination it named, frozen at acceptance. */
  destinationMethod?: ReportingSubscriptionDestinationMethodV1;
}

/** Durable history the readback omits, retained so coverage can always be recomputed. */
export interface StoredReportingSubscriptionHistory {
  subscriptionId: string;
  /** Oldest first. The last entry is the current version. */
  versions: StoredReportingSubscriptionVersion[];
  /** Present while the subscription is inactive. */
  deactivatedAt?: string;
  /** Deactivations later reversed in place. */
  inactiveIntervals: Array<{ from: string; until: string }>;
  /** Last version whose `replace_account_configs` the host hook confirmed. */
  replaceAppliedVersion?: number;
  /**
   * A `replace_account_configs` application committed but not yet confirmed by the host
   * hook. It is retried on every later write until the hook succeeds.
   */
  replacePending?: { subscriptionVersion: number; feedPurpose: string; at: string };
}

export class ReportingSubscriptionValidationError extends Error {
  constructor(
    message: string,
    readonly field = 'configuration.reporting_subscriptions'
  ) {
    super(message);
    this.name = 'ReportingSubscriptionValidationError';
  }
}

export interface ApplyReportingSubscriptionsInput {
  previous: readonly ReportingSubscriptionState[];
  history: readonly StoredReportingSubscriptionHistory[];
  desired: readonly ReportingSubscription[];
  /** The principal's `reporting_destinations` after this same request applies. */
  destinations: readonly PrincipalReportingDestination[];
  /** The caller's `sync_accounts` `delivery_config_id` values on any account. */
  reservedDeliveryConfigIds: ReadonlySet<string>;
  now: string;
  maxSubscriptions: number;
}

export interface ApplyReportingSubscriptionsResult {
  states: ReportingSubscriptionState[];
  history: StoredReportingSubscriptionHistory[];
  /** Versions whose `replace_account_configs` must now be applied, by cutover at `at` (this request). */
  replaceAccountConfigs: Array<{
    subscriptionId: string;
    subscriptionVersion: number;
    feedPurpose: string;
    at: string;
  }>;
}

/** `reporting-subscription-state.json` `inactive_intervals` maxItems. */
const MAX_INACTIVE_INTERVALS = 64;
const SUBSCRIPTION_ID = /^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,64}$/;
const PATH_TEMPLATE = /^(?!\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9_.=/{}-]+$/;
const PLACEHOLDERS = new Set(['{account_id}', '{subscription_id}', '{offering_id}', '{period_start}']);
const DIMENSION = /^[a-z][a-z0-9_]*$/;

/** `{name}` placeholders in one linear pass, or undefined when braces do not pair. */
function templatePlaceholders(template: string): string[] | undefined {
  const found: string[] = [];
  let open = -1;
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    if (char === '{') {
      if (open !== -1) return undefined;
      open = index;
    } else if (char === '}') {
      if (open === -1) return undefined;
      found.push(template.slice(open, index + 1));
      open = -1;
    }
  }
  return open === -1 ? found : undefined;
}

/** Fields whose change requires a new `subscription_version`. `active` and `replace_account_configs` change in place. */
export function reportingSubscriptionSemanticFingerprint(subscription: ReportingSubscription): string {
  const { active: _active, replace_account_configs: _replace, ...semantic } = subscription;
  void _active;
  void _replace;
  return canonicalJsonSha256(semantic);
}

function isMultiAccount(subscription: ReportingSubscription): boolean {
  return subscription.scope.all_authorized_accounts === true || (subscription.scope.account_ids?.length ?? 0) > 1;
}

function destinationPattern(destination: PrincipalReportingDestination): ReportingSubscriptionDestinationMethodV1 {
  const configuration = destination.configuration as { pattern?: unknown; transport?: unknown };
  return { pattern: String(configuration.pattern), transport: String(configuration.transport) };
}

/** Cross-field rules of `core/reporting-subscription.json` that a JSON Schema pass alone may not enforce. */
export function validateReportingSubscription(
  subscription: ReportingSubscription,
  destinations: readonly PrincipalReportingDestination[]
): void {
  const fail = (message: string): never => {
    throw new ReportingSubscriptionValidationError(
      `Reporting subscription ${JSON.stringify(subscription?.subscription_id)}: ${message}`
    );
  };
  if (!subscription || typeof subscription !== 'object') fail('must be an object');
  if (typeof subscription.subscription_id !== 'string' || !SUBSCRIPTION_ID.test(subscription.subscription_id)) {
    fail('subscription_id must be 1-64 of [A-Za-z0-9_.:-] and not . or ..');
  }
  if (!Number.isSafeInteger(subscription.subscription_version) || subscription.subscription_version < 1) {
    fail('subscription_version must be a positive integer');
  }
  if (typeof subscription.active !== 'boolean') fail('active is required');
  const scope = subscription.scope as { all_authorized_accounts?: unknown; account_ids?: unknown } | undefined;
  const scopeKeys = scope && typeof scope === 'object' ? Object.keys(scope) : [];
  if (scopeKeys.length !== 1) fail('scope must name exactly one of all_authorized_accounts or account_ids');
  if (scope!.all_authorized_accounts !== undefined && scope!.all_authorized_accounts !== true) {
    fail('scope.all_authorized_accounts must be true when present');
  }
  if (scope!.account_ids !== undefined) {
    const ids = scope!.account_ids;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 1000 ||
      new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || id.length === 0)
    ) {
      fail('scope.account_ids must be 1-1000 unique account ids');
    }
  }
  if (subscription.exclude_account_ids !== undefined && scope!.all_authorized_accounts !== true) {
    fail('exclude_account_ids is valid only with all_authorized_accounts scope');
  }
  const selector = subscription.selector;
  if (!selector || typeof selector !== 'object') fail('selector is required');
  if (!['pacing', 'analytics', 'billing'].includes(selector.feed_purpose)) fail('selector.feed_purpose is invalid');
  try {
    parseReportingPeriodDurationV1(selector.period_duration);
  } catch {
    fail('selector.period_duration must be a positive ISO 8601 duration');
  }
  if (!['snapshot', 'official'].includes(selector.required_finality)) fail('selector.required_finality is invalid');
  if (selector.match !== undefined && !['exact', 'finest', 'all'].includes(selector.match)) {
    fail('selector.match must be exact, finest or all');
  }
  if (selector.dimensions !== undefined) {
    const dims = selector.dimensions as unknown[];
    if (
      !Array.isArray(dims) ||
      dims.length < 1 ||
      dims.length > 16 ||
      new Set(dims).size !== dims.length ||
      dims.some(value => typeof value !== 'string' || !DIMENSION.test(value))
    ) {
      fail('selector.dimensions must be 1-16 unique reporting-dimension values');
    }
  }
  if (selector.period_timezone !== undefined) {
    if (subscription.scope.account_ids?.length !== 1) {
      fail('selector.period_timezone is valid only when scope.account_ids names exactly one account');
    }
    try {
      assertReportingIanaTimezoneV1(selector.period_timezone, 'selector.period_timezone');
    } catch (error) {
      fail((error as Error).message);
    }
  }
  if (selector.feed_purpose === 'billing') {
    if (selector.required_finality !== 'official') fail('billing subscriptions require official finality');
    if (subscription.reconciliation_mode !== 'consumer_receipt') {
      fail('billing subscriptions require consumer_receipt reconciliation');
    }
  }
  if (subscription.reconciliation_mode === 'consumer_receipt' && subscription.destination === undefined) {
    fail('consumer_receipt reconciliation requires a destination');
  }
  if (subscription.destination !== undefined) {
    const destination = destinations.find(item => item.destination_id === subscription.destination!.destination_id);
    if (!destination) {
      fail(
        `destination ${JSON.stringify(subscription.destination.destination_id)} is not in reporting_destinations after this request`
      );
    }
    const template = subscription.destination.path_template;
    if (template !== undefined) {
      if (typeof template !== 'string' || template.length > 512 || !PATH_TEMPLATE.test(template)) {
        fail('destination.path_template must be a relative path without . or .. segments');
      }
      const placeholders = templatePlaceholders(template);
      if (placeholders === undefined) fail('destination.path_template has an unbalanced brace');
      for (const placeholder of placeholders!) {
        if (!PLACEHOLDERS.has(placeholder)) fail(`destination.path_template has unknown placeholder ${placeholder}`);
      }
    }
    if (isMultiAccount(subscription)) {
      if (template === undefined && destinationPattern(destination!).pattern === 'file_transfer') {
        fail(
          'destination.path_template is required for a file_transfer destination when the scope can cover several accounts'
        );
      }
      if (template !== undefined && !template.includes('{account_id}')) {
        fail('destination.path_template must contain {account_id} when the scope can cover several accounts');
      }
    }
  }
}

/**
 * Apply a complete desired `reporting_subscriptions` section. Throws
 * {@link ReportingSubscriptionValidationError} (INVALID_REQUEST) for any rule violation;
 * nothing is applied unless every entry is valid.
 */
export function applyReportingSubscriptions(
  input: ApplyReportingSubscriptionsInput
): ApplyReportingSubscriptionsResult {
  const { desired, now } = input;
  if (!Array.isArray(desired))
    throw new ReportingSubscriptionValidationError('reporting_subscriptions must be an array');
  if (desired.length > input.maxSubscriptions) {
    throw new ReportingSubscriptionValidationError(
      `reporting_subscriptions exceeds this seller's limit of ${input.maxSubscriptions}`
    );
  }
  const seen = new Set<string>();
  for (const subscription of desired) {
    validateReportingSubscription(subscription, input.destinations);
    if (seen.has(subscription.subscription_id)) {
      throw new ReportingSubscriptionValidationError(
        `Duplicate subscription_id ${JSON.stringify(subscription.subscription_id)}`
      );
    }
    seen.add(subscription.subscription_id);
    if (input.reservedDeliveryConfigIds.has(subscription.subscription_id)) {
      throw new ReportingSubscriptionValidationError(
        `subscription_id ${JSON.stringify(subscription.subscription_id)} equals one of the caller's delivery_config_id values`
      );
    }
  }
  assertNoSameLevelOverlap(desired);
  assertSharedDestinationTemplates(desired);

  const historyById = new Map(input.history.map(entry => [entry.subscriptionId, structuredClone(entry)]));
  const previousById = new Map(input.previous.map(state => [state.subscription_id, state]));
  const replaceAccountConfigs: ApplyReportingSubscriptionsResult['replaceAccountConfigs'] = [];
  const touched = new Set<string>();

  for (const subscription of desired) {
    touched.add(subscription.subscription_id);
    const normalized: ReportingSubscription = structuredClone({ ...subscription, active: true });
    const destination = subscription.destination
      ? input.destinations.find(item => item.destination_id === subscription.destination!.destination_id)
      : undefined;
    const method = destination ? destinationPattern(destination) : undefined;
    let history = historyById.get(subscription.subscription_id);
    if (!history) {
      history = {
        subscriptionId: subscription.subscription_id,
        versions: [
          {
            subscriptionVersion: subscription.subscription_version,
            acceptedAt: now,
            configuration: normalized,
            ...(method ? { destinationMethod: method } : {}),
          },
        ],
        inactiveIntervals: [],
      };
      historyById.set(subscription.subscription_id, history);
    } else {
      const current = history.versions.at(-1)!;
      if (subscription.subscription_version < current.subscriptionVersion) {
        throw new ReportingSubscriptionValidationError(
          `subscription_version for ${JSON.stringify(subscription.subscription_id)} cannot regress below ${current.subscriptionVersion}`
        );
      }
      if (subscription.subscription_version === current.subscriptionVersion) {
        if (
          method &&
          current.destinationMethod &&
          (method.pattern !== current.destinationMethod.pattern ||
            method.transport !== current.destinationMethod.transport)
        ) {
          throw new ReportingSubscriptionValidationError(
            `Destination ${JSON.stringify(subscription.destination!.destination_id)} changes pattern or transport under subscription ${JSON.stringify(subscription.subscription_id)}; increment its subscription_version`
          );
        }
        if (
          reportingSubscriptionSemanticFingerprint(normalized) !==
          reportingSubscriptionSemanticFingerprint(current.configuration)
        ) {
          throw new ReportingSubscriptionValidationError(
            `subscription_version ${current.subscriptionVersion} of ${JSON.stringify(subscription.subscription_id)} is reused with different content; increment it`
          );
        }
        // active and replace_account_configs change in place.
        current.configuration = { ...current.configuration, ...pickInPlace(subscription) };
      } else {
        current.supersededAt = now;
        history.versions.push({
          subscriptionVersion: subscription.subscription_version,
          acceptedAt: now,
          configuration: normalized,
          ...(method ? { destinationMethod: method } : {}),
        });
      }
    }
    // Activation state.
    if (subscription.active === false) {
      if (history.deactivatedAt === undefined) history.deactivatedAt = now;
    } else if (history.deactivatedAt !== undefined) {
      if (Date.parse(now) > Date.parse(history.deactivatedAt)) {
        history.inactiveIntervals.push({ from: history.deactivatedAt, until: now });
      }
      delete history.deactivatedAt;
    }
    // replace_account_configs applies once per version, or when the flag turns true. It is
    // recorded as pending here and marked applied only after the host hook succeeds.
    const currentVersion = history.versions.at(-1)!;
    if (
      subscription.active !== false &&
      subscription.replace_account_configs === true &&
      history.replaceAppliedVersion !== currentVersion.subscriptionVersion &&
      history.replacePending?.subscriptionVersion !== currentVersion.subscriptionVersion
    ) {
      history.replacePending = {
        subscriptionVersion: currentVersion.subscriptionVersion,
        feedPurpose: subscription.selector.feed_purpose,
        at: now,
      };
    } else if (subscription.replace_account_configs === false) {
      // Only an explicit false turns the flag off, so a later true applies again. An omitted flag
      // leaves both untouched: buyers don't re-assert a one-shot action on every write, and a
      // committed application whose hook failed must keep being retried.
      delete history.replaceAppliedVersion;
      delete history.replacePending;
    }
    if (history.inactiveIntervals.length + (history.deactivatedAt !== undefined ? 1 : 0) > MAX_INACTIVE_INTERVALS) {
      throw new ReportingSubscriptionValidationError(
        `Reporting subscription ${JSON.stringify(subscription.subscription_id)} has reached ${MAX_INACTIVE_INTERVALS} inactive intervals, the most the readback can list`
      );
    }
  }
  for (const history of historyById.values()) {
    if (history.replacePending) {
      replaceAccountConfigs.push({ subscriptionId: history.subscriptionId, ...history.replacePending });
    }
  }
  // Omission deactivates; the subscription stays readable while its obligations are retained.
  for (const history of historyById.values()) {
    if (touched.has(history.subscriptionId)) continue;
    if (history.deactivatedAt !== undefined) continue;
    // The open interval this opens is listed too; bound it exactly as `active: false` does.
    if (history.inactiveIntervals.length + 1 > MAX_INACTIVE_INTERVALS) {
      throw new ReportingSubscriptionValidationError(
        `Reporting subscription ${JSON.stringify(history.subscriptionId)} has reached ${MAX_INACTIVE_INTERVALS} inactive intervals, the most the readback can list`
      );
    }
    history.deactivatedAt = now;
  }

  const states: ReportingSubscriptionState[] = [];
  for (const history of [...historyById.values()].sort((left, right) =>
    left.subscriptionId < right.subscriptionId ? -1 : left.subscriptionId > right.subscriptionId ? 1 : 0
  )) {
    const desiredEntry = desired.find(item => item.subscription_id === history.subscriptionId);
    states.push(
      projectReportingSubscriptionState(
        history,
        input.destinations,
        previousById.get(history.subscriptionId),
        desiredEntry
      )
    );
  }
  return { states, history: [...historyById.values()], replaceAccountConfigs };
}

function pickInPlace(subscription: ReportingSubscription): Partial<ReportingSubscription> {
  return subscription.replace_account_configs === undefined
    ? {}
    : { replace_account_configs: subscription.replace_account_configs };
}

/**
 * Readback for one subscription. `accounts_with_exceptions` and `accounts_unauthorized`
 * are carried from the previous readback; the coverage engine maintains them.
 */
export function projectReportingSubscriptionState(
  history: StoredReportingSubscriptionHistory,
  destinations: readonly PrincipalReportingDestination[],
  previous?: ReportingSubscriptionState,
  desired?: ReportingSubscription
): ReportingSubscriptionState {
  const current = history.versions.at(-1)!;
  const configuration: ReportingSubscription = structuredClone(
    desired ?? previous?.configuration ?? current.configuration
  );
  if (history.deactivatedAt !== undefined) configuration.active = false;
  const destination = configuration.destination
    ? destinations.find(item => item.destination_id === configuration.destination!.destination_id)
    : undefined;
  const issues: NonNullable<ReportingSubscriptionState['issues']> = [];
  if (history.deactivatedAt === undefined && configuration.destination) {
    if (!destination) {
      issues.push({
        code: 'REFERENCE_NOT_FOUND',
        message: `Reporting destination ${JSON.stringify(configuration.destination.destination_id)} was removed`,
        field: 'destination.destination_id',
      } as never);
    } else if (destination.state === 'inactive' || destination.configuration.active === false) {
      issues.push({
        code: 'DESTINATION_SUSPENDED',
        message: `Reporting destination ${JSON.stringify(destination.destination_id)} is suspended`,
        field: 'destination.destination_id',
      } as never);
    } else if (destination.state === 'action_required' || destination.state === 'rejected') {
      issues.push({
        code: 'DESTINATION_NOT_READY',
        message: `Reporting destination ${JSON.stringify(destination.destination_id)} is ${destination.state}`,
        field: 'destination.destination_id',
      } as never);
    }
  }
  const state: ReportingSubscriptionState['state'] =
    history.deactivatedAt !== undefined ? 'inactive' : issues.length > 0 ? 'action_required' : 'active';
  // Oldest first; the open interval while inactive has no reactivated_at. Bounded at 64.
  const intervals = [
    ...history.inactiveIntervals.map(interval => ({ deactivated_at: interval.from, reactivated_at: interval.until })),
    ...(history.deactivatedAt !== undefined ? [{ deactivated_at: history.deactivatedAt }] : []),
  ];
  const prior = history.versions
    .slice(0, -1)
    .reverse()
    .map(version => ({
      subscription_version: version.subscriptionVersion,
      accepted_at: version.acceptedAt,
      superseded_at: version.supersededAt!,
      // adcontextprotocol/adcp#8588: each prior version carries its configuration.
      configuration: structuredClone(version.configuration),
    }));
  return {
    subscription_id: history.subscriptionId,
    subscription_version: current.subscriptionVersion,
    state,
    accepted_at: current.acceptedAt,
    ...(prior.length > 0 ? { prior_versions: prior } : {}),
    ...(history.deactivatedAt !== undefined ? { deactivated_at: history.deactivatedAt } : {}),
    ...(intervals.length > 0 ? { inactive_intervals: intervals } : {}),
    ...(destination ? { destination_ref: destination.destination_ref } : {}),
    configuration,
    ...(issues.length > 0 ? { issues: issues.slice(0, 16) } : {}),
    ...(previous?.accounts_with_exceptions?.length
      ? { accounts_with_exceptions: structuredClone(previous.accounts_with_exceptions) }
      : {}),
    ...(previous?.accounts_unauthorized?.length
      ? { accounts_unauthorized: structuredClone(previous.accounts_unauthorized) }
      : {}),
  };
}

/**
 * Two active subscriptions at the same scope level must not both apply to one account and
 * feed purpose. All-accounts subscriptions overlap unless their `operator_domains` are
 * disjoint; account-scoped ones overlap when they share an account.
 */
function assertNoSameLevelOverlap(desired: readonly ReportingSubscription[]): void {
  const active = desired.filter(item => item.active !== false);
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const a = active[left]!;
      const b = active[right]!;
      if (a.selector.feed_purpose !== b.selector.feed_purpose) continue;
      let overlap = false;
      if (a.scope.all_authorized_accounts && b.scope.all_authorized_accounts) {
        overlap =
          a.operator_domains === undefined ||
          b.operator_domains === undefined ||
          a.operator_domains.some(domain => b.operator_domains!.includes(domain));
      } else if (a.scope.account_ids && b.scope.account_ids) {
        overlap = a.scope.account_ids.some(id => b.scope.account_ids!.includes(id));
      }
      if (overlap) {
        throw new ReportingSubscriptionValidationError(
          `Active subscriptions ${JSON.stringify(a.subscription_id)} and ${JSON.stringify(b.subscription_id)} ` +
            `would both apply to one account for feed_purpose ${a.selector.feed_purpose}`
        );
      }
    }
  }
}

/**
 * Active subscriptions sharing a destination each need a `{account_id}` template, and no two
 * expansions may land on the same path. `{subscription_id}` is known per subscription, so it
 * is substituted first; a remaining placeholder fills one non-empty segment. Two templates
 * are refused when some values could make them equal (decided segment by segment, erring
 * toward refusal), not merely when their text is equal.
 */
function assertSharedDestinationTemplates(desired: readonly ReportingSubscription[]): void {
  const byDestination = new Map<string, ReportingSubscription[]>();
  for (const subscription of desired) {
    if (subscription.active === false || !subscription.destination) continue;
    const list = byDestination.get(subscription.destination.destination_id) ?? [];
    list.push(subscription);
    byDestination.set(subscription.destination.destination_id, list);
  }
  for (const [destinationId, list] of byDestination) {
    if (list.length < 2) continue;
    const templates = list.map(item => item.destination!.path_template);
    if (templates.some(template => template === undefined || !template.includes('{account_id}'))) {
      throw new ReportingSubscriptionValidationError(
        `Active subscriptions sharing destination ${JSON.stringify(destinationId)} must each set a path_template containing {account_id}`
      );
    }
    const expanded = list.map(item =>
      item.destination!.path_template!.split('{subscription_id}').join(encodePathSegment(item.subscription_id))
    );
    for (let left = 0; left < expanded.length; left += 1) {
      for (let right = left + 1; right < expanded.length; right += 1) {
        if (templatesMayCollide(expanded[left]!, expanded[right]!)) {
          throw new ReportingSubscriptionValidationError(
            `Active subscriptions ${JSON.stringify(list[left]!.subscription_id)} and ${JSON.stringify(list[right]!.subscription_id)} sharing destination ${JSON.stringify(destinationId)} have path_template values that can expand to the same path`
          );
        }
      }
    }
  }
}

function templatesMayCollide(left: string, right: string): boolean {
  const a = left.split('/');
  const b = right.split('/');
  if (a.length !== b.length) return false;
  return a.every((segment, index) => segmentsMayCollide(segment, b[index]!));
}

/** Whether some placeholder values make two template segments equal. Errs toward true. */
function segmentsMayCollide(left: string, right: string): boolean {
  const placeholder = /\{[a-z_]+\}/;
  const hasLeft = placeholder.test(left);
  const hasRight = placeholder.test(right);
  if (!hasLeft && !hasRight) return left === right;
  const literalPrefix = (value: string) => value.split(placeholder)[0]!;
  const literalSuffix = (value: string) => value.split(placeholder).at(-1)!;
  if (!hasLeft || !hasRight) {
    const [literal, pattern] = hasLeft ? [right, left] : [left, right];
    const regex = new RegExp(
      `^${pattern
        .split(/\{[a-z_]+\}/)
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]+')}$`
    );
    return regex.test(literal);
  }
  const prefixes = [literalPrefix(left), literalPrefix(right)];
  const suffixes = [literalSuffix(left), literalSuffix(right)];
  const prefixCompatible = prefixes[0]!.startsWith(prefixes[1]!) || prefixes[1]!.startsWith(prefixes[0]!);
  const suffixCompatible = suffixes[0]!.endsWith(suffixes[1]!) || suffixes[1]!.endsWith(suffixes[0]!);
  return prefixCompatible && suffixCompatible;
}

/** Expand a destination `path_template`; each value fills exactly one percent-encoded segment. */
export function expandReportingSubscriptionPathTemplate(
  template: string,
  values: { account_id: string; subscription_id: string; offering_id: string; period_start: string }
): string {
  return template.replace(
    /\{(account_id|subscription_id|offering_id|period_start)\}/g,
    (_match, key: keyof typeof values) => encodePathSegment(values[key])
  );
}

function encodePathSegment(value: string): string {
  if (value === '.' || value === '..') return value.replace(/\./g, '%2E');
  // RFC 3986 pchar: keep unreserved, sub-delims, ':' and '@'; encode everything else,
  // including '/', so no value can add or escape a segment.
  return Array.from(new TextEncoder().encode(value))
    .map(byte => {
      const char = String.fromCharCode(byte);
      return byte < 0x80 && /[A-Za-z0-9\-._~!$&'()*+,;=:@]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}
