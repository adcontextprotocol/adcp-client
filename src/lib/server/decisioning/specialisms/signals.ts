/**
 * SignalsPlatform — signal-marketplace + signal-owned specialism interface
 * (v6.0).
 *
 * Two specialisms share the same platform interface:
 *
 *   - **`signal-marketplace`** — third-party data brokers serving curated
 *     audience signals (LiveRamp, Oracle Data Cloud, third-party DMPs)
 *   - **`signal-owned`** — first-party data providers serving their own
 *     signals (publisher first-party data, retailer customer-graph)
 *
 * Both expose the same surface: `getSignals` for catalog discovery and
 * `activateSignal` for provisioning a signal onto a destination platform.
 *
 * Async story: `activate_signal` is sync at the wire level — its response
 * union has no `Submitted` arm. Long-running activation pipelines (identity-
 * graph match: 5-30 min, destination provisioning: hours) return the wire
 * `ActivateSignalSuccess` immediately with deployments in `pending` state,
 * then emit `publishStatusChange({ resource_type: 'signal', ... })` events
 * as each deployment reaches `activating` / `deployed` / `failed`.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type {
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalSuccess,
} from '../../../types/tools.generated';

type Ctx = RequestContext<Account>;

export interface SignalsPlatform {
  /**
   * Catalog discovery. Sync — query your signal index, return signals
   * matching the buyer's filters (industry, intent type, audience size,
   * etc.). The wire `GetSignalsResponse` has no async envelope, so
   * platforms with slow catalog stores need internal caches.
   *
   * Throw `AdcpError` for buyer-fixable rejection (e.g.,
   * `'POLICY_VIOLATION'` if the buyer doesn't have rights to the data
   * category they're requesting).
   */
  getSignals(req: GetSignalsRequest, ctx: Ctx): Promise<GetSignalsResponse>;

  /**
   * Provision a signal onto one or more destination platforms (Snap,
   * Meta, TikTok, etc.). Returns the success-arm shape immediately with
   * `deployments` rows in their current state — `'pending'` is a valid
   * sync return for slow activation pipelines.
   *
   * Subsequent state changes (per-deployment `activating` / `deployed` /
   * `failed`) flow via `publishStatusChange({ resource_type: 'signal',
   * resource_id: signal_agent_segment_id, payload: ... })` as each
   * destination's identity-graph match completes.
   *
   * Use `req.action: 'deactivate'` for GDPR/CCPA-compliant teardown when
   * campaigns end.
   *
   * Throw `AdcpError` for buyer-fixable rejection:
   *   - `'SIGNAL_NOT_FOUND'` — unknown `signal_agent_segment_id`
   *   - `'POLICY_VIOLATION'` — buyer lacks rights to activate this data
   *   - `'INVALID_REQUEST'` — missing or unrecognized destination
   */
  activateSignal(req: ActivateSignalRequest, ctx: Ctx): Promise<ActivateSignalSuccess>;
}
