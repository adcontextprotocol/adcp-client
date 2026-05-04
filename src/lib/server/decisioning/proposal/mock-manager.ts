/**
 * MockProposalManager — v1 default forwarder.
 *
 * Symmetric with the mock-mode dispatch pattern adopters use to point
 * `DecisioningPlatform` upstreams at a running `bin/adcp.js mock-server`.
 * Adopters who don't yet have proposal logic of their own start with this
 * class pointed at the appropriate mock-server specialism; their first
 * working seller agent runs against the mock fixtures with zero adopter
 * code on the proposal side. They implement their own
 * {@link ProposalManager} subtype incrementally as they replace
 * mock-served slices with real assembly logic.
 *
 * The mock-server lifecycle is **not** managed by the SDK. Adopters or CI
 * start it as needed (`bin/adcp.js mock-server sales-non-guaranteed`) and
 * pass the resulting URL to this class's constructor.
 *
 * Ports `adcp-client-python.src/adcp/decisioning/proposal_manager.py`'s
 * `MockProposalManager` (PR #504).
 *
 * @public
 * @packageDocumentation
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type { GetProductsRequest, GetProductsResponse } from '../../../types/tools.generated';
import type { ProposalCapabilities, ProposalManager, ProposalSalesSpecialism, Recipe } from './types';

/**
 * Construction options for {@link MockProposalManager}.
 *
 * @public
 */
export interface MockProposalManagerOptions {
  /**
   * URL of the running mock-server. The forwarder POSTs
   * `GetProductsRequest` payloads to `${mockUpstreamUrl}/get_products`
   * and (when refine is enabled) `${mockUpstreamUrl}/refine_products`.
   *
   * Required and non-empty.
   */
  mockUpstreamUrl: string;

  /**
   * Which sales specialism this mock manager serves. Defaults to
   * `sales-non-guaranteed` (the catalog-style mock-server fixture).
   * Adopters wiring a guaranteed mock pass `sales-guaranteed` so the
   * framework's capability projection matches the fixtures.
   */
  salesSpecialism?: ProposalSalesSpecialism;

  /**
   * When true, the manager declares `refine` capability and forwards
   * `buying_mode: 'refine'` requests to `/refine_products`. Default
   * false — the framework falls through to `getProducts` for refine.
   */
  refine?: boolean;

  /**
   * Headers forwarded on every mock-server request (e.g. `X-Tenant-Id`).
   */
  defaultHeaders?: Readonly<Record<string, string>>;

  /**
   * Per-request timeout in milliseconds. Default 30 seconds.
   */
  timeoutMs?: number;

  /**
   * Optional `fetch` override for testing. Defaults to the global
   * `fetch` (Node 18+).
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * v1 default forwarder. Dispatches `getProducts` / `refineProducts` to
 * a running mock-server.
 *
 * @public
 */
export class MockProposalManager<TRecipe extends Recipe = Recipe, TCtxMeta = unknown> implements ProposalManager<
  TRecipe,
  TCtxMeta
> {
  readonly capabilities: ProposalCapabilities;
  private readonly url: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: MockProposalManagerOptions) {
    if (!options.mockUpstreamUrl || typeof options.mockUpstreamUrl !== 'string') {
      throw new Error(
        'MockProposalManager requires a non-empty `mockUpstreamUrl` pointing at a ' +
          'running `bin/adcp.js mock-server <specialism>` instance.'
      );
    }
    this.capabilities = {
      salesSpecialism: options.salesSpecialism ?? 'sales-non-guaranteed',
      refine: options.refine ?? false,
    };
    // Strip trailing slash to keep `${url}/get_products` clean.
    this.url = options.mockUpstreamUrl.replace(/\/+$/, '');
    this.headers = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** The configured mock-server URL — useful for diagnostics. */
  get mockUpstreamUrl(): string {
    return this.url;
  }

  async getProducts(req: GetProductsRequest, _ctx: RequestContext<Account<TCtxMeta>>): Promise<GetProductsResponse> {
    return this.forward('/get_products', req);
  }

  async refineProducts(req: GetProductsRequest, _ctx: RequestContext<Account<TCtxMeta>>): Promise<GetProductsResponse> {
    if (!this.capabilities.refine) {
      // Adopter wired the manager without refine but the framework
      // dispatched here anyway — surface the inconsistency rather than
      // silently forwarding.
      throw new Error(
        'MockProposalManager.refineProducts called but capabilities.refine is false. ' +
          'Pass `refine: true` to the constructor to enable refine forwarding.'
      );
    }
    return this.forward('/refine_products', req);
  }

  private async forward(path: string, body: unknown): Promise<GetProductsResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `MockProposalManager: mock-server returned ${response.status} for ${path}` +
            (text ? `: ${text.slice(0, 500)}` : '')
        );
      }
      const json = (await response.json()) as GetProductsResponse;
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}
