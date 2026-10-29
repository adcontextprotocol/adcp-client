import type { AssertionSpec } from './assertions';
import type { AssertionResult } from './types';

type RecordValue = Record<string, unknown>;
type Compatibility = 'compatible' | 'incompatible' | 'indeterminate';
type Finding = Omit<AssertionResult, 'assertion_id' | 'scope'>;
const AMOUNT_KEYS: Record<string, string> = {
  cpm: 'cpm',
  percent_of_media: 'percent',
  flat_fee: 'amount',
  per_unit: 'unit_price',
};

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.filter((entry): entry is RecordValue => record(entry) !== undefined) : [];
}

/** A signal's alternatives are OR; separate compulsory signals are AND. */
function signalCompatibility(signal: RecordValue, currencies: Set<string>): Compatibility {
  // Omitted product-scoped pricing means bundled/no incremental charge.
  if (signal.pricing_options === undefined) return 'compatible';
  const prices = records(signal.pricing_options);
  if (prices.length === 0) return 'indeterminate';
  let indeterminate = false;
  for (const price of prices) {
    const amountKey = AMOUNT_KEYS[String(price.model)];
    const amount = amountKey ? price[amountKey] : undefined;
    if (amount === 0 || (price.model === 'percent_of_media' && price.max_cpm === 0)) return 'compatible';
    if (typeof price.currency === 'string' && currencies.has(price.currency)) return 'compatible';
    // Custom pricing has no standardized machine-readable free marker. In
    // particular, custom/no-currency can truthfully have no incremental charge.
    // Report that coverage as indeterminate rather than inventing a requirement.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || typeof price.currency !== 'string') {
      indeterminate = true;
    }
  }
  return indeterminate ? 'indeterminate' : 'incompatible';
}

function groupRulesFor(signal: RecordValue, rules: RecordValue): RecordValue[] {
  const modes = Array.isArray(signal.allowed_targeting_modes) ? signal.allowed_targeting_modes : ['include'];
  return records(rules.selection_group_rules).filter(
    group =>
      group.selection_group === signal.selection_group &&
      (group.targeting_mode === undefined || modes.includes(group.targeting_mode))
  );
}

function isFixedSelection(signal: RecordValue, rules: RecordValue): boolean {
  if (signal.default_selected !== true) return false;
  const overrides = groupRulesFor(signal, rules);
  return overrides.length > 0
    ? overrides.some(group => (group.selection_mode ?? rules.selection_mode) === 'fixed')
    : rules.selection_mode === 'fixed';
}

function selectionCapacity(
  options: RecordValue[],
  compatible: Compatibility[],
  rules: RecordValue,
  possible: boolean
): number {
  const grouped = new Map<unknown, number>();
  for (const [index, option] of options.entries()) {
    if (compatible[index] !== 'compatible' && !(possible && compatible[index] === 'indeterminate')) continue;
    // Missing grouping metadata is not evidence that two options share a cap.
    const group = option.selection_group ?? option;
    grouped.set(group, (grouped.get(group) ?? 0) + 1);
  }
  const perGroup = typeof rules.max_selected_per_group === 'number' ? rules.max_selected_per_group : Infinity;
  const capacity = [...grouped.values()].reduce((sum, count) => sum + Math.min(count, perGroup), 0);
  return typeof rules.max_selected_signals === 'number' ? Math.min(capacity, rules.max_selected_signals) : capacity;
}

/**
 * Validate the observable currency contract on the effective discovery result.
 * This does not compare against fixture rate-card IDs or source currencies:
 * account-specific FX may legally change both media and compulsory signal prices.
 */
export const pricingCurrencyFilterAssertion: AssertionSpec = {
  id: 'discovery.pricing_currency_filter',
  default: true,
  description: 'Returned media prices and compulsory product-scoped signal charges satisfy filters.pricing_currencies.',
  onStep(_ctx, step) {
    if (step.skipped || step.task !== 'get_products') return [];
    const request = record(step.request?.payload);
    const requested = record(request?.filters)?.pricing_currencies;
    if (
      !Array.isArray(requested) ||
      requested.length === 0 ||
      !requested.every(currency => typeof currency === 'string')
    ) {
      return [];
    }
    const raw = record(step.response ?? step.response_record?.payload);
    const response = record(raw?.data) ?? raw;
    // Success payload presence is authoritative; advisory errors may coexist.
    if (!Array.isArray(response?.products)) return [];
    if (response.products.length === 0) {
      return [
        {
          passed: true,
          status: 'not_applicable',
          step_id: step.step_id,
          description: 'No currency-compatible products were returned; positive media-pricing coverage is unproven',
        },
      ];
    }
    const currencies = new Set<string>(requested);
    const findings: Finding[] = [];
    const add = (path: string, compatibility: Compatibility): void => {
      findings.push({
        passed: compatibility !== 'incompatible',
        step_id: step.step_id,
        description:
          compatibility === 'indeterminate'
            ? `${path}: pricing currency compatibility is unproven for custom or incomplete signal pricing`
            : `${path}: pricing must be satisfiable in a requested currency`,
        ...(compatibility === 'indeterminate' && { status: 'not_applicable' as const }),
        ...(compatibility === 'incompatible' && {
          error: `${path} cannot be satisfied in filters.pricing_currencies ${JSON.stringify(requested)}`,
        }),
      });
    };
    for (const [productIndex, product] of records(response.products).entries()) {
      const productPath = `products[${productIndex}]`;
      for (const [priceIndex, price] of records(product.pricing_options).entries()) {
        add(
          `${productPath}.pricing_options[${priceIndex}].currency`,
          typeof price.currency === 'string' && currencies.has(price.currency) ? 'compatible' : 'incompatible'
        );
      }
      const rules = record(product.signal_targeting_rules) ?? {};
      const signals = records(product.signal_targeting_options);
      const groups = records(rules.selection_group_rules);
      if (
        product.signal_targeting_options === undefined &&
        (rules.selection_mode === 'fixed' ||
          rules.selection_mode === 'required' ||
          groups.some(group => ['fixed', 'required'].includes(String(group.selection_mode))))
      ) {
        add(`${productPath}.signal_targeting_options: mandatory inline menu is unavailable`, 'indeterminate');
      }
      for (const [signalIndex, signal] of signals.entries()) {
        if (isFixedSelection(signal, rules)) {
          add(`${productPath}.signal_targeting_options[${signalIndex}]`, signalCompatibility(signal, currencies));
        }
      }
      const requiredGroups = records(rules.selection_group_rules)
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => (group.selection_mode ?? rules.selection_mode) === 'required');
      const requirements: Array<{ path: string; minimum: unknown; options: RecordValue[]; bounds: RecordValue }> =
        requiredGroups.map(({ group, index }) => ({
          path: `${productPath}.signal_targeting_rules.selection_group_rules[${index}]`,
          minimum: group.min_selected_signals ?? 1,
          options: signals.filter(signal => groupRulesFor(signal, rules).includes(group)),
          bounds: {
            ...rules,
            max_selected_signals: Math.min(
              typeof rules.max_selected_signals === 'number' ? rules.max_selected_signals : Infinity,
              typeof group.max_selected_signals === 'number' ? group.max_selected_signals : Infinity
            ),
          },
        }));
      // Group overrides can change the selection obligation. Check the global
      // minimum only when no override makes that aggregate ambiguous.
      if (rules.selection_mode === 'required' && records(rules.selection_group_rules).length === 0) {
        requirements.push({
          path: `${productPath}.signal_targeting_rules`,
          minimum: rules.min_selected_signals ?? 1,
          options: signals,
          bounds: rules,
        });
      } else if (rules.selection_mode === 'required') {
        findings.push({
          passed: true,
          status: 'not_applicable',
          step_id: step.step_id,
          description: `${productPath}.signal_targeting_rules: aggregate required-selection feasibility with group overrides is unproven`,
        });
      }
      for (const requirement of requirements) {
        // An omitted inline menu may be supplied through get_signals. It is
        // not evidence that a required choice cannot be fulfilled.
        if (product.signal_targeting_options === undefined || typeof requirement.minimum !== 'number') continue;
        const compatible = requirement.options.map(signal => signalCompatibility(signal, currencies));
        const proven = selectionCapacity(requirement.options, compatible, requirement.bounds, false);
        const possible = selectionCapacity(requirement.options, compatible, requirement.bounds, true);
        add(
          requirement.path,
          proven >= requirement.minimum
            ? 'compatible'
            : possible >= requirement.minimum
              ? 'indeterminate'
              : 'incompatible'
        );
      }
    }
    return findings;
  },
};
