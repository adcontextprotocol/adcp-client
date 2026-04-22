/**
 * Bridge between the `comply_test_controller` seed store and the
 * `createAdcpServer` spec-tool pipeline.
 *
 * Sellers who run the compliance conformance suite seed fixtures via
 * `comply_test_controller.seed_product`, but those fixtures don't flow into
 * `get_products` responses unless the seller plumbs it themselves — every
 * seller ends up rewriting the same "look up seeded products, merge into
 * handler response, dedupe, sandbox-gate" boilerplate.
 *
 * This module exposes a small declarative shape (`TestControllerBridge`)
 * that the server config accepts; when present, the dispatcher augments
 * `get_products` responses with seeded products on sandbox requests, and
 * leaves production traffic untouched.
 *
 * The bridge intentionally does NOT know how seeded products are stored.
 * Sellers provide a `getSeededProducts` callback that returns the list the
 * SDK should merge — which lets the same wiring work whether the backing
 * store is in-memory, Postgres, Redis, or a mock.
 */

import type { Product, GetProductsResponse } from '../types/tools.generated';

/**
 * Context passed to {@link TestControllerBridge.getSeededProducts}.
 *
 * `input` is the raw `get_products` request as received over the wire (post
 * MCP schema validation). `account` is the resolved seller account when
 * `resolveAccount` is configured on `createAdcpServer`, else `undefined` —
 * sellers who key seeded fixtures per account read it from here.
 */
export interface TestControllerBridgeContext<TAccount = unknown> {
  input: Record<string, unknown>;
  account?: TAccount;
}

/**
 * Wiring that connects the `comply_test_controller` seed store to the
 * spec-tool pipeline.
 *
 * Set on `AdcpServerConfig.testController`; when absent, behavior is
 * unchanged. Opt-in and additive — seeded products append to the
 * handler's own output rather than replacing it.
 */
export interface TestControllerBridge<TAccount = unknown> {
  /**
   * Retrieve seeded products for the current request. Return an empty
   * array (or `undefined`) when nothing is seeded. The returned products
   * are appended to the handler's `get_products` response; on
   * `product_id` collision, the seeded entry wins (sellers who seed to
   * override default inventory expect their fixture to take precedence).
   *
   * Sandbox-gated by the framework — this callback is only invoked when
   * {@link isSandboxRequest} returns true for the incoming request, so
   * production traffic cannot reach seeded fixtures.
   */
  getSeededProducts?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<Product[]> | Product[];

  /**
   * When `true` (default when `testController` is configured), seeded
   * products are merged into `get_products` responses on sandbox requests.
   * Set to `false` to hold seeded state without changing response shape —
   * useful during incremental rollout or when a seller wants to read
   * seeded fixtures from their own handler explicitly.
   */
  augmentGetProducts?: boolean;
}

/**
 * Sandbox-request predicate. Reads the spec's two canonical sandbox markers:
 *
 *   1. `account.sandbox === true` on the request (per AccountReference
 *      discriminator — the brand+operator variant carries the flag).
 *   2. `context.sandbox === true` — storyboards that don't scope through an
 *      account still flag the envelope so the server can tell them apart.
 *
 * Either match is sufficient. Anything else returns `false` and the seeded
 * fixtures stay hidden. Keep this conservative — a `true` result opts the
 * request into test-only code paths, so a permissive predicate leaks
 * fixture data into production.
 */
export function isSandboxRequest(input: Record<string, unknown>): boolean {
  const account = input.account;
  if (account && typeof account === 'object' && (account as { sandbox?: unknown }).sandbox === true) {
    return true;
  }
  const context = input.context;
  if (context && typeof context === 'object' && (context as { sandbox?: unknown }).sandbox === true) {
    return true;
  }
  return false;
}

/**
 * Merge seeded products into a `get_products` response payload.
 *
 * Existing products from the handler come first; seeded entries append
 * after deduping by `product_id`. On collision, the seeded entry wins so
 * storyboards that seed to override default inventory see the fixture.
 *
 * Returns a NEW response object — the original is not mutated. The seeded
 * `sandbox: true` flag is stamped on the merged response to signal
 * synthetic provenance to downstream tooling.
 */
export function mergeSeededProductsIntoResponse(
  response: GetProductsResponse,
  seeded: readonly Product[]
): GetProductsResponse {
  if (!seeded.length) return response;

  const seededIds = new Set<string>();
  for (const p of seeded) seededIds.add(p.product_id);

  const handlerProducts = Array.isArray(response.products) ? response.products : [];
  // Keep handler-returned products except those a seeded entry overrides.
  // A null/undefined product_id on the handler side would be a spec
  // violation; filtering on `!seededIds.has(id)` preserves it rather than
  // silently dropping so downstream response validation still catches it.
  const retained = handlerProducts.filter(p => !seededIds.has(p?.product_id));

  return {
    ...response,
    products: [...retained, ...seeded],
    sandbox: true,
  };
}
