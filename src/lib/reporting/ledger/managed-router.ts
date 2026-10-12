import type { ReportingVerification } from '../../types';
import {
  REPORTING_DESTINATION_PATTERNS_V1,
  REPORTING_DESTINATION_TRANSPORT_PATTERN_V1,
  type ReportingDestinationAuthorizationV1,
  type ReportingDestinationPatternV1,
  type ReportingManagedDeliveryAdapterV1,
} from './managed';
import type { ReportingManagedDeliveryBindingV1 } from './types';

type VerificationProfile = ReportingVerification['verification_profile'];

/** Route ids appear in worker results and metrics, so they are held to a safe token. */
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const DEFAULT_ROUTE_PROBE_TIMEOUT_MILLISECONDS = 10_000;

/** Why a delivery, read, revocation or admission could not be routed. */
export type ReportingManagedDeliveryRoutingErrorCodeV1 =
  /** No route is installed for the pattern and transport. */
  | 'REPORTING_ROUTE_NOT_FOUND'
  /** The binding names no transport and the router has no usable `legacyDefault`. */
  | 'REPORTING_ROUTE_TRANSPORT_REQUIRED'
  /** The authorization recorded no pattern/transport and the router has no usable `legacyDefault`. */
  | 'REPORTING_ROUTE_CONTRACT_UNRECORDED'
  /** The binding's verification profile is not one its route can verify. */
  | 'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED';

export type ReportingManagedDeliveryRoutingOperationV1 =
  | 'deliver'
  | 'read'
  | 'revoke'
  | 'admit_binding'
  | 'admit_offering';

/**
 * Raised by the router before it touches any adapter. The fields are the
 * non-secret routing facts only: no destination, location or credential.
 */
export class ReportingManagedDeliveryRoutingErrorV1 extends Error {
  readonly code: ReportingManagedDeliveryRoutingErrorCodeV1;
  readonly operation: ReportingManagedDeliveryRoutingOperationV1;
  readonly pattern: string | undefined;
  readonly transport: string | undefined;
  readonly verificationProfile: string | undefined;

  constructor(
    code: ReportingManagedDeliveryRoutingErrorCodeV1,
    operation: ReportingManagedDeliveryRoutingOperationV1,
    detail: { pattern?: string | undefined; transport?: string | undefined; verificationProfile?: string | undefined },
    message: string
  ) {
    super(message);
    this.name = 'ReportingManagedDeliveryRoutingErrorV1';
    this.code = code;
    this.operation = operation;
    this.pattern = detail.pattern;
    this.transport = detail.transport;
    this.verificationProfile = detail.verificationProfile;
  }
}

/**
 * Raised by `router.probe()` when at least one route's probe failed. Carries
 * the ids of the failing routes and nothing else from the provider; the
 * individual errors are on `cause` (an `AggregateError`) for seller logs only.
 */
export class ReportingManagedDeliveryProbeErrorV1 extends Error {
  readonly failedRouteIds: readonly string[];

  constructor(failedRouteIds: readonly string[], errors: readonly unknown[]) {
    super(`Managed Delivery route probe failed for ${failedRouteIds.map(id => JSON.stringify(id)).join(', ')}`, {
      cause: new AggregateError(errors, 'Managed Delivery route probes failed'),
    });
    this.name = 'ReportingManagedDeliveryProbeErrorV1';
    this.failedRouteIds = Object.freeze([...failedRouteIds]);
  }
}

export interface ReportingManagedDeliveryRouteV1 {
  /** Stable id used in per-route counts and probe failures. Lowercase token, at most 64 characters. */
  id: string;
  /** The pattern and transport this route serves. Exactly one route may match a pair. */
  match: { pattern: ReportingDestinationPatternV1; transport: string };
  /**
   * The adapter that serves it. It must declare
   * `revocationFencesDeliveryGenerations: true` and a non-empty
   * `verificationProfiles`; its profiles are what a binding routed here may use.
   */
  adapter: ReportingManagedDeliveryAdapterV1;
}

export interface CreateReportingManagedDeliveryAdapterRouterOptionsV1 {
  routes: readonly ReportingManagedDeliveryRouteV1[];
  /**
   * Id of the route that takes work recorded before pattern and transport
   * existed: a binding with no `transport`, and a destination authorization
   * with no recorded pattern/transport. Without it that work fails with a
   * typed error rather than being guessed or sent to every route. A binding
   * or authorization that does state a pattern is only sent here if it is this
   * route's pattern.
   */
  legacyDefault?: string;
  /** Per-route budget for `probe()`. Defaults to 10 seconds. */
  probeTimeoutMilliseconds?: number;
}

/** What a router exposes about a route. The adapter itself stays private to the router. */
export interface ReportingManagedDeliveryRouteDescriptionV1 {
  readonly id: string;
  readonly match: Readonly<{ pattern: ReportingDestinationPatternV1; transport: string }>;
  readonly verificationProfiles: readonly VerificationProfile[];
}

/**
 * A `ReportingManagedDeliveryAdapterV1` that dispatches to one adapter per
 * (pattern, transport). The optional hooks are always present on a router.
 */
export interface ReportingManagedDeliveryAdapterRouterV1 extends ReportingManagedDeliveryAdapterV1 {
  readonly routes: readonly ReportingManagedDeliveryRouteDescriptionV1[];
  readonly legacyDefault: string | undefined;
  probe(context: { signal: AbortSignal }): Promise<void>;
  admitBinding(binding: ReportingManagedDeliveryBindingV1): void;
  admitOffering(offering: { method: { pattern: string; transport: string }; reconciliation_mode?: string }): void;
  routeIdFor(
    target: Readonly<
      { binding: ReportingManagedDeliveryBindingV1 } | { authorization: ReportingDestinationAuthorizationV1 }
    >
  ): string | undefined;
}

interface InternalRoute {
  readonly id: string;
  readonly pattern: ReportingDestinationPatternV1;
  readonly transport: string;
  readonly adapter: ReportingManagedDeliveryAdapterV1;
  readonly verificationProfiles: readonly VerificationProfile[];
}

const routeKey = (pattern: string, transport: string) => `${pattern}:${transport}`;
const hasText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * One managed-delivery runtime across several transports.
 *
 * The router is pure dispatch with no state of its own, so every fence the
 * store and worker provide (leases, the authorization-generation check,
 * settlement, the retry and attempt caps, revocation SLA accounting) is
 * untouched and keeps working per materialization whatever route served it.
 *
 * - `deliver()` and `read()` choose the route from the immutable binding
 *   alone (`binding.method` and `binding.transport`), never from request
 *   input, materialization state or the resource.
 * - `revoke()` chooses it from the pattern and transport recorded on the
 *   authorization generation. It never fans out.
 * - Nothing that cannot be routed reaches an adapter: the router throws a
 *   `ReportingManagedDeliveryRoutingErrorV1` first.
 */
export function createReportingManagedDeliveryAdapterRouterV1(
  options: CreateReportingManagedDeliveryAdapterRouterOptionsV1
): ReportingManagedDeliveryAdapterRouterV1 {
  if (!options || !Array.isArray(options.routes) || options.routes.length === 0) {
    throw new TypeError('A Managed Delivery router requires at least one route');
  }
  const probeTimeout = options.probeTimeoutMilliseconds ?? DEFAULT_ROUTE_PROBE_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(probeTimeout) || probeTimeout <= 0) {
    throw new RangeError('probeTimeoutMilliseconds must be a positive safe integer');
  }

  const routes: InternalRoute[] = [];
  const byId = new Map<string, InternalRoute>();
  const byMatch = new Map<string, InternalRoute>();
  for (const candidate of options.routes) {
    const id = candidate?.id;
    if (typeof id !== 'string' || !ROUTE_ID_PATTERN.test(id)) {
      throw new TypeError('A Managed Delivery route id must match ^[a-z][a-z0-9_.-]{0,63}$');
    }
    if (byId.has(id)) throw new TypeError(`Managed Delivery route id ${JSON.stringify(id)} is duplicated`);
    const pattern = candidate.match?.pattern;
    const transport = candidate.match?.transport;
    if (!REPORTING_DESTINATION_PATTERNS_V1.includes(pattern)) {
      throw new TypeError(
        `Managed Delivery route ${JSON.stringify(id)} must match file_transfer, dataset_share, or warehouse_materialization`
      );
    }
    if (typeof transport !== 'string' || !REPORTING_DESTINATION_TRANSPORT_PATTERN_V1.test(transport)) {
      throw new TypeError(`Managed Delivery route ${JSON.stringify(id)} has an invalid transport`);
    }
    const adapter = candidate.adapter;
    if (
      !adapter ||
      typeof adapter.deliver !== 'function' ||
      typeof adapter.read !== 'function' ||
      typeof adapter.revoke !== 'function'
    ) {
      throw new TypeError(`Managed Delivery route ${JSON.stringify(id)} requires deliver, read, and revoke`);
    }
    if (adapter.revocationFencesDeliveryGenerations !== true) {
      throw new TypeError(
        `Managed Delivery route ${JSON.stringify(id)} does not fence delivery generations on revocation`
      );
    }
    if (!Array.isArray(adapter.verificationProfiles) || adapter.verificationProfiles.length === 0) {
      throw new TypeError(`Managed Delivery route ${JSON.stringify(id)} declares no verification profile`);
    }
    const key = routeKey(pattern, transport);
    const clash = byMatch.get(key);
    if (clash) {
      throw new TypeError(
        `Managed Delivery routes ${JSON.stringify(clash.id)} and ${JSON.stringify(id)} both match ${pattern}/${transport}`
      );
    }
    const route: InternalRoute = Object.freeze({
      id,
      pattern,
      transport,
      adapter,
      verificationProfiles: Object.freeze([...new Set<VerificationProfile>(adapter.verificationProfiles)]),
    });
    routes.push(route);
    byId.set(id, route);
    byMatch.set(key, route);
  }
  let legacy: InternalRoute | undefined;
  if (options.legacyDefault !== undefined) {
    legacy = byId.get(options.legacyDefault);
    if (!legacy) {
      throw new TypeError(`Managed Delivery legacyDefault ${JSON.stringify(options.legacyDefault)} is not a route id`);
    }
  }

  const exact = (pattern: unknown, transport: unknown): InternalRoute | undefined =>
    typeof pattern === 'string' && typeof transport === 'string'
      ? byMatch.get(routeKey(pattern, transport))
      : undefined;

  const forBinding = (
    binding: ReportingManagedDeliveryBindingV1,
    operation: ReportingManagedDeliveryRoutingOperationV1
  ): InternalRoute => {
    const pattern = binding?.method;
    const transport = binding?.transport;
    if (!hasText(transport)) {
      // Recorded before transports existed. Only the legacy route may take it,
      // and only for the pattern that route serves.
      if (legacy && legacy.pattern === pattern) return legacy;
      throw new ReportingManagedDeliveryRoutingErrorV1(
        'REPORTING_ROUTE_TRANSPORT_REQUIRED',
        operation,
        { pattern },
        'Managed Delivery binding names no transport and no legacy route serves its pattern'
      );
    }
    const route = exact(pattern, transport);
    if (route) return route;
    throw new ReportingManagedDeliveryRoutingErrorV1(
      'REPORTING_ROUTE_NOT_FOUND',
      operation,
      { pattern, transport },
      `No Managed Delivery route serves ${String(pattern)}/${transport}`
    );
  };

  const forAuthorization = (authorization: ReportingDestinationAuthorizationV1): InternalRoute => {
    const { pattern, transport } = authorization ?? {};
    if (hasText(pattern) && hasText(transport)) {
      const route = exact(pattern, transport);
      if (route) return route;
      throw new ReportingManagedDeliveryRoutingErrorV1(
        'REPORTING_ROUTE_NOT_FOUND',
        'revoke',
        { pattern, transport },
        `No Managed Delivery route serves ${pattern}/${transport}`
      );
    }
    // Recorded before the contract was, or recorded without it. Never fan out:
    // either the host named one route to take it, or the revocation fails and
    // the store's retry and overdue accounting makes that visible.
    if (legacy && (!hasText(pattern) || legacy.pattern === pattern)) return legacy;
    throw new ReportingManagedDeliveryRoutingErrorV1(
      'REPORTING_ROUTE_CONTRACT_UNRECORDED',
      'revoke',
      { pattern, transport },
      'Managed Delivery destination authorization recorded no pattern and transport, and no legacy route serves it'
    );
  };

  const assertProfile = (
    route: InternalRoute,
    binding: ReportingManagedDeliveryBindingV1,
    operation: ReportingManagedDeliveryRoutingOperationV1
  ) => {
    if (!route.verificationProfiles.includes(binding.verification_profile)) {
      throw new ReportingManagedDeliveryRoutingErrorV1(
        'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED',
        operation,
        { pattern: route.pattern, transport: route.transport, verificationProfile: binding.verification_profile },
        `Managed Delivery route ${JSON.stringify(route.id)} cannot verify ${String(binding.verification_profile)}`
      );
    }
  };

  const union = Object.freeze([...new Set(routes.flatMap(route => route.verificationProfiles))]);
  const descriptions: readonly ReportingManagedDeliveryRouteDescriptionV1[] = Object.freeze(
    routes.map(route =>
      Object.freeze({
        id: route.id,
        match: Object.freeze({ pattern: route.pattern, transport: route.transport }),
        verificationProfiles: route.verificationProfiles,
      })
    )
  );

  const router: ReportingManagedDeliveryAdapterRouterV1 = {
    routes: descriptions,
    legacyDefault: legacy?.id,
    // Compatibility only: nothing here ever admits a binding. A route's own
    // profiles do, in `admitBinding` and again before delivery.
    verificationProfiles: union,
    revocationFencesDeliveryGenerations: true,

    async deliver(input, context) {
      const route = forBinding(input.binding, 'deliver');
      assertProfile(route, input.binding, 'deliver');
      return route.adapter.deliver(input, context);
    },

    async read(input, context) {
      return forBinding(input.binding, 'read').adapter.read(input, context);
    },

    async revoke(input, context) {
      return forAuthorization(input.authorization).adapter.revoke(input, context);
    },

    admitBinding(binding) {
      assertProfile(forBinding(binding, 'admit_binding'), binding, 'admit_binding');
    },

    admitOffering(offering) {
      const { pattern, transport } = offering.method;
      const route = exact(pattern, transport);
      if (!route) {
        throw new ReportingManagedDeliveryRoutingErrorV1(
          'REPORTING_ROUTE_NOT_FOUND',
          'admit_offering',
          { pattern, transport },
          `No Managed Delivery route serves the advertised offering ${pattern}/${transport}`
        );
      }
      if (
        offering.reconciliation_mode === 'consumer_receipt' &&
        !route.verificationProfiles.includes('canonical_digest')
      ) {
        throw new ReportingManagedDeliveryRoutingErrorV1(
          'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED',
          'admit_offering',
          { pattern, transport, verificationProfile: 'canonical_digest' },
          `Managed Delivery route ${JSON.stringify(route.id)} cannot verify canonical_digest for a consumer-receipt offering`
        );
      }
    },

    routeIdFor(target) {
      try {
        if ('binding' in target) return forBinding(target.binding, 'deliver').id;
        return forAuthorization(target.authorization).id;
      } catch {
        return undefined;
      }
    },

    async probe(context) {
      const probing = routes.filter(route => typeof route.adapter.probe === 'function');
      const settled = await Promise.allSettled(probing.map(route => probeRoute(route, context.signal, probeTimeout)));
      const failedIds: string[] = [];
      const errors: unknown[] = [];
      settled.forEach((result, index) => {
        if (result.status === 'rejected') {
          failedIds.push(probing[index]!.id);
          errors.push(result.reason);
        }
      });
      if (failedIds.length) throw new ReportingManagedDeliveryProbeErrorV1(failedIds, errors);
    },
  };
  return Object.freeze(router);
}

/** One route's probe, bounded by its own deadline and the caller's signal. */
async function probeRoute(route: InternalRoute, outer: AbortSignal, timeoutMilliseconds: number): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([outer, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => route.adapter.probe!({ signal })),
      new Promise<never>((_resolve, reject) => {
        const abandon = (reason: unknown) => reject(reason ?? new Error('Route probe aborted'));
        if (signal.aborted) return abandon(signal.reason);
        signal.addEventListener('abort', () => abandon(signal.reason), { once: true });
        timer = setTimeout(() => {
          const error = new Error('Route probe deadline elapsed');
          controller.abort(error);
          abandon(error);
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
