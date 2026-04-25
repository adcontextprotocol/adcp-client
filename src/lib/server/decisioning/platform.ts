/**
 * DecisioningPlatform — the top-level interface adopters implement.
 *
 * Per-specialism sub-interfaces (sales, creative, audiences, etc.) are
 * optional; framework's compile-time enforcement (RequiredPlatformsFor<S>)
 * forces the right sub-interfaces based on `capabilities.specialisms[]`.
 *
 * Status: Preview / 6.0. Not yet wired into the framework.
 *
 * @public
 */

import type { DecisioningCapabilities } from './capabilities';
import type { Account, AccountStore } from './account';
import type { StatusMappers } from './status-mappers';
import type { SalesPlatform } from './specialisms/sales';
import type { CreativeTemplatePlatform, CreativeGenerativePlatform } from './specialisms/creative';
import type { AudiencePlatform } from './specialisms/audiences';
import type { AdCPSpecialism } from '../../types/tools.generated';

/**
 * Top-level platform interface. Adopters implement this; framework wires
 * the wire protocol around it.
 *
 * The "framework owns X" claims below are the v6.0 wiring contract — the
 * runtime guarantees the framework will provide once this surface is wired.
 * They are NOT yet enforced; this module is preview-only as of the scaffold
 * landing. Treat them as the design contract a v6.0 reviewer should hold
 * the framework refactor to, not as a description of existing behavior.
 *
 * **What the framework owns** (platform implementations DON'T see these):
 * - Wire-shape mapping (MCP tools/list, A2A skill manifest, request/response envelopes)
 * - Authentication + auth-principal extraction; `accounts.resolve()` is the only
 *   place the platform translates auth into its tenant model
 * - Idempotency: dedupe + replay handled before dispatch; platforms see clean traffic
 * - `dry_run`: framework intercepts `dry_run: true`, validates schema + capability,
 *   echoes the validated request shape back without dispatching to the platform.
 *   Platform implementations never see dry-run traffic.
 * - `context` echo: framework round-trips `context` on every response
 * - Task envelopes: `submitted` outcomes are wrapped into A2A Task envelopes /
 *   MCP polling responses; `taskHandle.notify` calls dedupe + retry
 * - Schema validation: requests fail before reaching the platform; responses are
 *   shape-validated against the wire schema after the platform returns
 *
 * **What the platform owns**: the business decisions in each `SalesPlatform` /
 * `CreativeTemplatePlatform` / `AudiencePlatform` method. Nothing else.
 *
 * @template TConfig Platform-specific config typed at the call site.
 *                   Example: `class GAM implements DecisioningPlatform<{ networkId: string }>`.
 * @template TMeta   Platform-specific Account.metadata typed at the call site.
 */
export interface DecisioningPlatform<TConfig = unknown, TMeta = Record<string, unknown>> {
  /** Capability declaration; single source of truth for get_adcp_capabilities. */
  capabilities: DecisioningCapabilities<TConfig>;

  /** Account model + tenant resolution. */
  accounts: AccountStore<TMeta>;

  /** Native-status mappers (account, mediaBuy, creative, plan). All optional. */
  statusMappers: StatusMappers;

  /**
   * Per-tenant capability override. Multi-tenant SaaS adopters (Prebid-style
   * deployments where one server hosts many advertisers, each with different
   * `manualApprovalOperations` / pricing tiers / channel mixes) implement this
   * to scope capabilities per resolved Account. When absent, the framework
   * uses `capabilities` for every request.
   *
   * The framework calls this AFTER `accounts.resolve()` and uses the returned
   * capabilities to gate the rest of the request. The static `agent-card.json`
   * AND `tools/list` shape is derived from `capabilities` (the union) — per-tenant
   * differences are runtime-only.
   */
  getCapabilitiesFor?(
    account: Account<TMeta>
  ): DecisioningCapabilities<TConfig> | Promise<DecisioningCapabilities<TConfig>>;

  // Per-specialism sub-interfaces — optional at the type level; required at the
  // call site by RequiredPlatformsFor<S>. v1.0 ships these four:
  sales?: SalesPlatform;
  creative?: CreativeTemplatePlatform | CreativeGenerativePlatform;
  audiences?: AudiencePlatform;

  // v1.1+ specialisms add: governance, brand, signals
}

// ---------------------------------------------------------------------------
// Compile-time capability enforcement
// ---------------------------------------------------------------------------

/**
 * Maps an AdCP specialism to the platform interface(s) it requires. The
 * framework's `createAdcpServer<P extends DecisioningPlatform>` constrains
 * `P` to satisfy `RequiredPlatformsFor<P['capabilities']['specialisms'][number]>`,
 * forcing every claimed specialism's interface methods to exist.
 *
 * Drop a method, fail compile.
 * Claim a specialism without an implementation, fail compile.
 *
 * The nested-conditional encoding (rather than a union of `S extends X ? {} : never`)
 * is deliberate: when a specialism is claimed without its required platform
 * interface, TypeScript surfaces "Property 'sales' is missing in type 'P'"
 * rather than the unactionable "Type 'P' does not satisfy the constraint 'never'."
 *
 * v1.0 covers the 4 specialisms shipping in v1.0; extended in v1.1+.
 * Unknown specialisms (v1.1+ when this module hasn't been updated yet)
 * resolve to an empty requirement — the framework's runtime check is the
 * fallback gate.
 */
export type RequiredPlatformsFor<S extends AdCPSpecialism> = S extends 'creative-template'
  ? { creative: CreativeTemplatePlatform }
  : S extends 'creative-generative'
    ? { creative: CreativeGenerativePlatform }
    : S extends 'sales-non-guaranteed'
      ? { sales: SalesPlatform }
      : S extends 'audience-sync'
        ? { audiences: AudiencePlatform }
        : Record<string, never>;

/**
 * The framework's createAdcpServer<P> signature uses this intersection to
 * enforce capability claims at compile time. Sketch:
 *
 * ```ts
 * declare function createAdcpServer<P extends DecisioningPlatform>(config: {
 *   platform: P & RequiredPlatformsFor<P['capabilities']['specialisms'][number]>;
 * }): AdcpServer;
 * ```
 *
 * NOTE: The companion file is preview-only; the actual `createAdcpServer`
 * doesn't yet enforce this. Wiring lands in a follow-up PR with the
 * framework refactor.
 */
