/**
 * Cross-storyboard spec conformance gates.
 *
 * Some AdCP rules are universal (apply to any seller agent regardless of
 * which specialism they're testing) rather than per-storyboard. Encoding
 * them as per-storyboard `required_tools` predicates would mean tagging
 * every relevant scenario, and the rule would still drift for adopters
 * authoring third-party storyboards.
 *
 * This module emits synthetic `StoryboardResult`s for those rules — the
 * comply orchestrator pushes them into the storyboard-results array
 * before track grouping. Pipeline downstream (failure extraction, track
 * mapping, summary, skip-cause aggregator) treats them as any other
 * storyboard result.
 *
 * Currently wires one gate:
 *
 * - **Account discovery (adcp-client#1624 / adcp#4302).** Every seller
 *   agent (any specialism in `sales-*` / `audience-sync` / `governance-*`)
 *   MUST advertise at least one of `list_accounts` or `sync_accounts`.
 *   Spec normative as of AdCP 3.0.9; the requirement existed before the
 *   explicit MUST landed.
 *
 *   Deliberately NOT tightened for account-id namespaces (adcp-client#1647).
 *   adcp#5062 makes `list_accounts` a MUST only when a credential can reach
 *   more than one account, and a SHOULD (with an explicit out-of-band
 *   escape) for credential-bound singletons — neither condition is
 *   observable from a static `get_adcp_capabilities` read, and
 *   `require_operator_auth: true` covers seller-defined namespaces that
 *   legitimately hand out ids out-of-band. Keying a run-blocking gate on
 *   that bit would fail conformant sellers. The SDK enforces the stricter
 *   rule where it *is* knowable — at `createAdcpServerFromPlatform`, where
 *   a declared `resolution: 'derived'` requires `list_accounts`. The runner honors AdCP 3.1
 *   `required_any_of_tools` tags when present, but this fallback remains
 *   until upstream storyboards carry the tag consistently.
 */

import type { AgentProfile } from '../types';
import type { StoryboardResult } from '../storyboard/types';
import { LIBRARY_VERSION } from '../../version';

/**
 * Synthetic storyboard ID emitted when the account-discovery gate fails.
 * Stable across releases — dashboards / badges can grep for it. Distinct
 * from any real storyboard ID; the gate runs cross-storyboard.
 */
export const ACCOUNT_DISCOVERY_GATE_STORYBOARD_ID = '__spec_conformance__/account_discovery';

/**
 * Specialisms that operate on accounts and therefore require the agent
 * to expose `list_accounts` OR `sync_accounts`. Per AdCP 3.0.9
 * `accounts/overview.mdx`. Adopters claiming any of these specialisms
 * without an account-discovery tool are non-conformant.
 *
 * Match rules:
 *   - `sales-*` prefix — every selling specialism operates on accounts.
 *   - exact `audience-sync` — audiences belong to accounts.
 *   - `governance-*` prefix — governance applies per-account.
 *   - exact `creative-generative` — dual-role specialism. A generative
 *     seller (selling inventory + generating creatives) is an account-
 *     bearing adopter even if they only claim `creative-generative`,
 *     not a `sales-*` specialism. The upstream storyboard at
 *     `compliance/cache/<v>/specialisms/creative-generative/generative-seller.yaml`
 *     exercises `sync_accounts` directly, confirming this scope.
 *
 * Other creative specialisms (`creative-ad-server`, `creative-template`)
 * are stand-alone — those agents don't sell inventory and don't need
 * account discovery. Same for `signal-*`, `brand-rights`,
 * `signed-requests`.
 */
/** @internal Used by bundle verdict aggregation to assign this synthetic gate. */
export function isAccountBearingSpecialism(specialism: string): boolean {
  if (specialism.startsWith('sales-')) return true;
  if (specialism === 'audience-sync') return true;
  if (specialism.startsWith('governance-')) return true;
  if (specialism === 'creative-generative') return true;
  return false;
}

/**
 * Run the account-discovery conformance gate. Returns `null` when the
 * gate doesn't apply (agent declared no account-bearing specialism,
 * couldn't enumerate specialisms, or already advertises a discovery
 * tool). Returns a synthetic failing `StoryboardResult` when the agent
 * is non-conformant.
 *
 * The returned result has:
 * - `overall_passed: false` so it counts toward `failed` in summaries
 * - one synthetic phase + step that surfaces the specific specialism(s)
 *   triggering the gate so operators can act
 * - `track` is left unset on the synthetic id; `extractFailures` falls
 *   back to `'core'` for any storyboard not in the applicable-storyboards
 *   lookup, which is correct — account discovery is a core protocol
 *   invariant, not a specialism-specific concern
 *
 * Note: when the agent doesn't expose `get_adcp_capabilities` (so
 * `profile.specialisms` is undefined), the gate is a no-op. The runner
 * separately surfaces an observation about the missing capability call;
 * we don't double-report.
 *
 * TODO(adcp-client#1642): delete this synthesis path when upstream
 * storyboards in `compliance/cache/` carry `required_any_of_tools`
 * consistently for every account-bearing scenario.
 */
/**
 * True when the agent's capabilities declare an account-id namespace —
 * `account.require_operator_auth: true`. Read from `raw_capabilities`
 * because the normalized `AgentProfile` doesn't carry the account block.
 *
 * Used only to steer the failure *message* toward the right remedy. It
 * deliberately does not change whether the gate fires — see the
 * module-level note on why the account-id-namespace rule isn't enforced
 * from a static capability read.
 */
function declaresAccountIdNamespace(profile: AgentProfile): boolean {
  const raw = profile.raw_capabilities;
  if (raw === null || typeof raw !== 'object') return false;
  const account = (raw as { account?: unknown }).account;
  if (account === null || typeof account !== 'object') return false;
  return (account as { require_operator_auth?: unknown }).require_operator_auth === true;
}

export function checkAccountDiscoveryGate(profile: AgentProfile, agentUrl: string): StoryboardResult | null {
  const accountBearing = (profile.specialisms ?? []).filter(isAccountBearingSpecialism);
  if (accountBearing.length === 0) return null;

  if (profile.tools.includes('list_accounts') || profile.tools.includes('sync_accounts')) {
    return null;
  }

  const now = new Date().toISOString();
  const detail =
    `Agent declared account-bearing specialism(s) [${accountBearing.join(', ')}] but advertises ` +
    `neither list_accounts nor sync_accounts. AdCP 3.0.9 §accounts/overview requires every seller ` +
    `agent to expose at least one of these tools. Agent tools: [${profile.tools.join(', ')}].` +
    (declaresAccountIdNamespace(profile)
      ? ` This agent declares account.require_operator_auth: true, so list_accounts is the discovery ` +
        `tool that fits its account model — buyers reference these accounts by account_id.`
      : '');

  return {
    storyboard_id: ACCOUNT_DISCOVERY_GATE_STORYBOARD_ID,
    storyboard_title: 'Spec conformance: account discovery',
    agent_url: agentUrl,
    overall_passed: false,
    phases: [
      {
        phase_id: 'account_discovery_gate',
        phase_title: 'Account discovery',
        passed: false,
        duration_ms: 0,
        steps: [
          {
            storyboard_id: ACCOUNT_DISCOVERY_GATE_STORYBOARD_ID,
            step_id: 'list_or_sync_accounts',
            phase_id: 'account_discovery_gate',
            title: 'Seller agent must advertise list_accounts or sync_accounts',
            task: '',
            passed: false,
            duration_ms: 0,
            validations: [],
            context: {},
            error: detail,
            extraction: { path: 'none' },
          },
        ],
      },
    ],
    context: {},
    total_duration_ms: 0,
    passed_count: 0,
    failed_count: 1,
    skipped_count: 0,
    runner_capability_version: LIBRARY_VERSION,
    tested_at: now,
    notices: [],
  };
}
