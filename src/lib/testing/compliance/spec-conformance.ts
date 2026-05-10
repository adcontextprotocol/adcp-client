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
 *   explicit MUST landed. Will migrate to a per-storyboard
 *   `required_any_of_tools` tag once adcp#4325 lands (see #1642).
 */

import type { AgentProfile } from '../types';
import type { StoryboardResult } from '../storyboard/types';

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
function isAccountBearingSpecialism(specialism: string): boolean {
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
 * TODO(adcp-client#1642): once adcp#4325's `required_any_of_tools` schema
 * lands in AdCP 3.1, migrate this gate to consume the per-storyboard tag
 * for richer attribution. Delete this synthesis path when migration is
 * complete and upstream storyboards in `compliance/cache/` carry the tag.
 */
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
    `agent to expose at least one of these tools. Agent tools: [${profile.tools.join(', ')}].`;

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
    tested_at: now,
  };
}
