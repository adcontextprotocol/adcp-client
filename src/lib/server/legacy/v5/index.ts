/**
 * `@adcp/sdk/server/legacy/v5` — stable home for the v5 handler-bag
 * server constructor.
 *
 * **New code should not import from this subpath.** The canonical v6
 * entry point is `createAdcpServerFromPlatform` from `@adcp/sdk/server`,
 * which wraps this constructor with the typed specialism interfaces,
 * compile-time capability enforcement, ctx_metadata auto-hydration,
 * idempotency-principal synthesis, status mappers, multi-tenant routing,
 * and webhook auto-emit. See `docs/migration-5.x-to-6.x.md`.
 *
 * Reasons to import from `legacy/v5` rather than `@adcp/sdk/server`:
 *
 *   1. **Mid-migration codebases.** v5 adopters who haven't finished
 *      migrating to v6 keep working by switching the import path —
 *      same constructor, same config shape, no behavior change.
 *
 *   2. **Escape-hatch handlers** that v6 doesn't model directly: custom
 *      `tools[]` outside the AdCP wire surface, the `mergeSeam` hook,
 *      `preTransport` / `signedRequests` middleware. These stay on v5
 *      until the v6 platform interface picks them up explicitly.
 *
 *   3. **Pinning against future v6 evolution.** The top-level export
 *      is `@deprecated` and may be removed in a major; `legacy/v5`
 *      is the stable subpath for adopters who genuinely need the v5
 *      shape long-term.
 *
 * The top-level `@adcp/sdk/server` keeps a tag-deprecated re-export of
 * `createAdcpServer` for one cycle so existing imports don't break on
 * upgrade. New imports SHOULD reach for the subpath.
 *
 * @public
 */

// `createAdcpServer` is the v5 entry point that was previously at the
// top-level `@adcp/sdk/server` export. It now lives only here.
export { createAdcpServer } from '../../create-adcp-server';

// Re-export everything else from `@adcp/sdk/server` so a v5 adopter's
// migration path is a single-line import swap:
//   from '@adcp/sdk/server'  →  from '@adcp/sdk/server/legacy/v5'
// without splitting destructured imports across two paths.
export * from '../..';

export type {
  AdcpServerConfig,
  WebhooksConfig,
  AdcpToolMap,
  AdcpServerToolName,
  AdcpCapabilitiesConfig,
  AdcpCapabilitiesOverrides,
  AdcpCustomToolConfig,
  AdcpLogger,
  SignedRequestsConfig,
  AdcpPreTransport,
  AdcpSignedRequestsState,
  HandlerContext,
  SessionKeyContext,
  MediaBuyHandlers,
  SignalsHandlers,
  CreativeHandlers,
  GovernanceHandlers,
  AccountHandlers,
  EventTrackingHandlers,
  SponsoredIntelligenceHandlers,
  ResolveAccountContext,
} from '../../create-adcp-server';

export type {
  AdcpServer,
  AdcpServerComplianceApi,
  AdcpServerTransport,
  AdcpTestRequest,
  AdcpTestToolsCallRequest,
  AdcpTestResponse,
} from '../../adcp-server';
