import type {
  ActionBuy,
  ActionProduct,
  LiveMediaBuyAction,
  MediaBuyAction,
  MediaBuyTask,
  ProposalChangeTerm,
} from '../media-buy/action-types';
import {
  actionAllowedStatuses,
  changeTermIssues,
  defaultMediaBuyActionTask,
  productTemplateIssues,
  slaWithin,
  elapsedDuration,
} from '../media-buy/action-contracts';
import { assessActionAvailability, type ActionAvailability } from '../media-buy/action-assessment';
import { evaluateChangeTermConstraints } from '../media-buy/action-constraints';
import { decomposeUpdateMediaBuy } from '../media-buy/mutations';
import type { SLAWindow, UpdateMediaBuyRequestLike } from '../media-buy/types';

export interface SellerActionDecision {
  /** These are seller-owned, evaluated gates, never copied from buyer request data. Unknown is a denial. */
  authorization: boolean | 'unknown';
  governance: boolean | 'unknown';
  policy: boolean | 'unknown';
  /** Explicit seller evaluation of all opaque identifiers, scoped to this term/current request. */
  conditionsSatisfied?: boolean;
  /** A selected task must be one of the canonical action's permitted tasks. */
  task?: MediaBuyTask;
  /** Optional tighter elapsed maxima; cannot discard a committed maximum. */
  sla?: SLAWindow;
}
export interface SellerActionResolutionOptions {
  /** Trusted current snapshot from the seller store after account and revision checks. */
  buy: ActionBuy;
  /** Every affected product, including those on sibling packages for aggregate changes. Never union rights. */
  products?: readonly ActionProduct[];
  decide: (term: Readonly<ProposalChangeTerm>) => SellerActionDecision;
  /** Current output is 3.2. A deliberate 3.1 projection emits opaque terms_ref and requires_approval. */
  wireVersion?: '3.2' | '3.1';
  /** Emit a deliberate equal compatibility alias alongside the 3.2 identity. */
  emitTermsRefAlias?: boolean;
  request?: UpdateMediaBuyRequestLike;
  now?: number;
}
export interface SellerActionResolution {
  available_actions: LiveMediaBuyAction[];
  unavailable: ActionAvailability[];
}

/**
 * One builder for product acceptance and live projection, alongside validActionsForStatus.
 * It does not authenticate tokens, load state, persist terms, or mutate a buy.
 * Call under the existing authorization, governance, revision and idempotency
 * boundary. Gates and conditions are seller-owned results, not buyer assertions.
 */
export const mediaBuyActionResolver = {
  /**
   * Explicitly accept complete binding terms selected by the seller from all
   * affected product templates. Nothing is materialized from a product alone.
   * Omitting sellerAccepted or supplying false throws, including for JS callers.
   */
  materialize(input: {
    products: readonly ActionProduct[];
    acceptedTerms: readonly ProposalChangeTerm[];
    sellerAccepted: true;
    currency?: string;
  }): ProposalChangeTerm[] {
    if (input.sellerAccepted !== true)
      throw new TypeError('Explicit seller acceptance is required to materialize binding change terms.');
    const issues = changeTermIssues(input.acceptedTerms, input.currency);
    for (const product of input.products)
      issues.push(...productTemplateIssues(product.allowed_actions ?? [], input.currency));
    if (!input.products.length) issues.push('Every affected product must be supplied.');
    if (issues.length) throw new TypeError(issues.join('; '));
    const materialized = structuredClone([...input.acceptedTerms]);
    for (const term of materialized) {
      const templates = input.products.map(product => product.allowed_actions?.find(t => t.action === term.action));
      // Explicit acceptance permits copying advisory data into the binding
      // envelope. Different ceilings require an explicitly selected common bound.
      const constraints = templates.find(t => t?.constraints)?.constraints;
      const sla = templates.find(t => t?.sla)?.sla;
      if (term.constraints === undefined && constraints !== undefined) term.constraints = structuredClone(constraints);
      if (term.processing_sla === undefined && sla !== undefined) term.processing_sla = structuredClone(sla);
      if (!term.allowed_statuses && templates.some(t => t?.allowed_statuses)) {
        term.allowed_statuses = actionAllowedStatuses(term).filter(status =>
          templates.every(t => !t?.allowed_statuses || t.allowed_statuses.includes(status))
        ) as ProposalChangeTerm['allowed_statuses'];
      }
      const reference = templates[0]?.terms_ref;
      if (reference && templates.every(t => t?.terms_ref === reference)) term.terms_ref ??= reference;
      for (const product of input.products) {
        const template = product.allowed_actions?.find(t => t.action === term.action);
        if (!template || !template.modes.includes(term.service_mode) || !slaWithin(template.sla, term.processing_sla)) {
          issues.push('Accepted terms exceed product template.');
          continue;
        }
        if (template.allowed_statuses && actionAllowedStatuses(term).some(s => !template.allowed_statuses!.includes(s)))
          issues.push('Accepted status scope exceeds product template.');
        if (template.constraints && !constraintsWithin(template.constraints, term.constraints))
          issues.push('Materialized constraints must retain the product bound.');
      }
    }
    issues.push(...changeTermIssues(materialized, input.currency));
    if (issues.length) throw new TypeError(issues.join('; '));
    return materialized;
  },
  resolve(input: SellerActionResolutionOptions): SellerActionResolution {
    const terms = input.buy.accepted_proposal?.commercial_terms?.change_terms;
    if (terms === undefined) return { available_actions: [], unavailable: [] };
    const currency = typeof input.buy.total_budget === 'object' ? input.buy.total_budget.currency : input.buy.currency;
    const issues = changeTermIssues(terms, currency);
    for (const product of input.products ?? [])
      issues.push(...productTemplateIssues(product.allowed_actions ?? [], currency));
    if (issues.length) throw new TypeError(issues.join('; '));
    const available_actions: LiveMediaBuyAction[] = [],
      unavailable: ActionAvailability[] = [];
    for (const original of terms) {
      // Callbacks receive copies so they cannot widen the accepted snapshot.
      const term = structuredClone(original);
      const decision = input.decide(structuredClone(term));
      const blocked = (message: string, unknown = false) =>
        unavailable.push({
          status: 'currently_unavailable',
          action: term.action,
          reason: 'condition_unresolved',
          certainty: unknown ? 'unknown' : 'blocked',
          message,
        });
      if (decision.authorization !== true || decision.governance !== true || decision.policy !== true) {
        blocked(
          'Seller authorization, governance, and policy must all admit the action.',
          [decision.authorization, decision.governance, decision.policy].includes('unknown')
        );
        continue;
      }
      if (term.conditions?.length && decision.conditionsSatisfied !== true) {
        blocked('Seller conditions are unresolved.', true);
        continue;
      }
      // Product declarations may only narrow accepted rights. Missing product
      // information is not a positive declaration when the caller supplies products.
      let productBlocked = false;
      for (const product of input.products ?? []) {
        const template = product.allowed_actions?.find(t => t.action === term.action);
        if (
          !template ||
          !template.modes.includes(term.service_mode) ||
          (template.allowed_statuses && !template.allowed_statuses.includes(input.buy.status as never))
        ) {
          productBlocked = true;
          break;
        }
        if (template.constraints && !constraintsWithin(template.constraints, term.constraints)) {
          if (!input.request) {
            productBlocked = true;
            break;
          }
          const result = evaluateChangeTermConstraints(
            { ...term, constraints: template.constraints },
            input.buy,
            input.request,
            decomposeUpdateMediaBuy(input.buy as Parameters<typeof decomposeUpdateMediaBuy>[0], input.request)
              .mutations,
            { now: input.now }
          );
          if (result.status !== 'satisfied') {
            productBlocked = true;
            break;
          }
        }
      }
      if (productBlocked) {
        unavailable.push({
          status: 'currently_unavailable',
          action: term.action,
          reason: 'not_supported_on_product',
          certainty: 'blocked',
          message: 'Not every affected product currently admits this accepted action.',
        });
        continue;
      }
      const entry: LiveMediaBuyAction = {
        action: term.action,
        mode: term.service_mode,
        task: decision.task ?? defaultMediaBuyActionTask(term.action),
        change_term_id: term.term_id,
        ...(term.processing_sla && { sla: structuredClone(term.processing_sla) }),
        ...(decision.sla && { sla: structuredClone(decision.sla) }),
      };
      // Evaluate with a seller-resolved copy of conditions; the accepted record
      // and emitted term remain unchanged. No arbitrary condition is executed.
      const evaluatedTerm = { ...term };
      delete evaluatedTerm.conditions;
      const evaluatedBuy: ActionBuy = {
        ...input.buy,
        accepted_proposal: { ...input.buy.accepted_proposal, commercial_terms: { change_terms: [evaluatedTerm] } },
        available_actions: [entry],
      };
      // A projection can advertise a bounded right before a particular request.
      // When a request is supplied, the exact same portable preflight is enforced.
      const constraint = evaluatedTerm.constraints as Record<string, unknown> | undefined;
      const hasTimingGate = constraint?.kind === 'effective_timing' || constraint?.minimum_notice !== undefined;
      if (!input.request && !hasTimingGate) delete evaluatedTerm.constraints;
      const result = assessActionAvailability(evaluatedBuy, term.action, {
        request: input.request ?? (hasTimingGate ? {} : undefined),
        now: input.now,
      });
      if (result.status !== 'available_now') {
        unavailable.push(result);
        continue;
      }
      if (input.wireVersion === '3.1') {
        const legacy = {
          ...entry,
          terms_ref: term.term_id,
          mode: term.service_mode === 'seller_managed' ? ('requires_approval' as const) : term.service_mode,
        };
        delete legacy.change_term_id;
        delete legacy.task;
        available_actions.push(legacy);
      } else available_actions.push({ ...entry, ...(input.emitTermsRefAlias && { terms_ref: term.term_id }) });
    }
    return { available_actions, unavailable };
  },
};

function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      k => Object.hasOwn(b, k) && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  );
}

/** Whether every ceiling field survives with an equal or tighter bound. */
function constraintsWithin(ceiling: unknown, candidate: unknown): boolean {
  if (sameData(ceiling, candidate)) return true;
  if (!ceiling || !candidate || typeof ceiling !== 'object' || typeof candidate !== 'object') return false;
  const a = ceiling as Record<string, unknown>,
    b = candidate as Record<string, unknown>;
  if (a.kind !== b.kind) return false;
  return Object.keys(a)
    .filter(key => key !== 'kind')
    .every(key => {
      if (sameData(a[key], b[key])) return true;
      if (b[key] === undefined) return false;
      const minimum = key.startsWith('min_') || key === 'minimum_notice' || key.startsWith('earliest_');
      let left = a[key],
        right = b[key];
      if (key.endsWith('_amount')) {
        const x = left as { currency: string; amount: number },
          y = right as { currency: string; amount: number };
        if (x.currency !== y.currency) return false;
        left = x.amount;
        right = y.amount;
      } else if (key === 'max_change' || key === 'minimum_notice') {
        left = elapsedDuration(left);
        right = elapsedDuration(right);
      } else if (key.startsWith('earliest_') || key.startsWith('latest_')) {
        left = Date.parse(String(left));
        right = Date.parse(String(right));
      }
      return (
        typeof left === 'number' &&
        Number.isFinite(left) &&
        typeof right === 'number' &&
        Number.isFinite(right) &&
        (minimum ? right >= left : right <= left)
      );
    });
}
