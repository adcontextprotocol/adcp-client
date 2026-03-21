/**
 * Compliance Engine
 *
 * Runs all applicable capability tracks against an agent
 * and reports results for every track — never stops at the first failure.
 */

import { testAgent as runAgentTest } from '../agent-tester';
import { createTestClient, discoverAgentProfile } from '../client';
import { getApplicableScenarios } from '../orchestrator';
import type { TestScenario, TestOptions, TestResult, AgentProfile } from '../types';
import type {
  ComplianceTrack,
  TrackResult,
  TrackStatus,
  ComplianceResult,
  ComplianceSummary,
  AdvisoryObservation,
  PlatformType,
  PlatformCoherenceResult,
} from './types';
import { getPlatformProfile } from './profiles';
import type { PlatformProfile } from './profiles';
import { closeMCPConnections } from '../../protocols/mcp';

/**
 * Maps each track to its constituent scenarios and a human-readable label.
 */
const TRACK_DEFINITIONS: Record<ComplianceTrack, { label: string; scenarios: TestScenario[] }> = {
  core: {
    label: 'Core Protocol',
    scenarios: ['health_check', 'discovery', 'capability_discovery', 'schema_compliance'],
  },
  products: {
    label: 'Product Discovery',
    scenarios: ['pricing_edge_cases', 'behavior_analysis', 'response_consistency'],
  },
  media_buy: {
    label: 'Media Buy Lifecycle',
    scenarios: ['create_media_buy', 'full_sales_flow', 'creative_inline', 'temporal_validation'],
  },
  creative: {
    label: 'Creative Management',
    scenarios: ['creative_sync', 'creative_flow'],
  },
  reporting: {
    label: 'Reporting',
    // full_sales_flow covers get_media_buy_delivery — but we assess it as a
    // separate track concern by checking if the agent has the tool
    scenarios: ['full_sales_flow'],
  },
  governance: {
    label: 'Governance',
    scenarios: ['governance_property_lists', 'governance_content_standards', 'property_list_filters'],
  },
  signals: {
    label: 'Signals',
    scenarios: ['signals_flow'],
  },
  si: {
    label: 'Sponsored Intelligence',
    scenarios: ['si_session_lifecycle', 'si_availability', 'si_handoff'],
  },
  audiences: {
    label: 'Audience Management',
    scenarios: ['sync_audiences'],
  },
  error_handling: {
    label: 'Error Compliance',
    scenarios: ['error_codes', 'error_structure', 'error_transport'],
  },
};

/**
 * Which tools make a track "applicable" — if the agent has at least one
 * of these tools, the track should be attempted.
 */
const TRACK_RELEVANCE: Record<ComplianceTrack, string[]> = {
  core: [], // always applicable
  products: ['get_products'],
  media_buy: ['create_media_buy'],
  creative: ['sync_creatives', 'build_creative', 'list_creative_formats'],
  reporting: ['get_media_buy_delivery'],
  governance: ['create_property_list', 'list_content_standards'],
  signals: ['get_signals'],
  si: ['si_initiate_session'],
  audiences: ['sync_audiences'],
  error_handling: ['create_media_buy'],
};

const TRACK_ORDER: ComplianceTrack[] = [
  'core',
  'products',
  'media_buy',
  'creative',
  'reporting',
  'governance',
  'signals',
  'si',
  'audiences',
  'error_handling',
];

function isTrackApplicable(track: ComplianceTrack, tools: string[]): boolean {
  const relevantTools = TRACK_RELEVANCE[track];
  if (relevantTools.length === 0) return true;
  return relevantTools.some(t => tools.includes(t));
}

function isAuthError(step: { error?: string; passed?: boolean }): boolean {
  if (!step.error || step.passed) return false;
  const e = step.error.toLowerCase();
  return (
    e.includes('authentication') ||
    e.includes('x-adcp-auth') ||
    e.includes('unauthorized') ||
    e.includes('missing auth') ||
    e.includes('401')
  );
}

/**
 * Check if a scenario failed entirely due to auth errors.
 * Returns true if every failed step is an auth error.
 */
function isAuthOnlyFailure(result: TestResult): boolean {
  if (result.overall_passed) return false;
  const failedSteps = (result.steps ?? []).filter(s => !s.passed);
  return failedSteps.length > 0 && failedSteps.every(isAuthError);
}

function computeTrackStatus(results: TestResult[], skippedCount: number, hasAuth: boolean): TrackStatus {
  if (results.length === 0) return 'skip';

  // When running without auth, scenarios that failed only due to auth
  // don't count as failures
  const effectiveResults = results.map(r => {
    if (!hasAuth && isAuthOnlyFailure(r)) {
      return { ...r, _authSkipped: true, overall_passed: true };
    }
    return r;
  });

  const passed = effectiveResults.filter(r => r.overall_passed).length;
  const total = effectiveResults.length;
  if (passed === total) return 'pass';
  if (passed === 0) return 'fail';
  return 'partial';
}

/**
 * Collect advisory observations from test results.
 * Analyzes the actual data for quality signals that aren't pass/fail.
 */
function collectObservations(
  track: ComplianceTrack,
  results: TestResult[],
  profile: AgentProfile
): AdvisoryObservation[] {
  const observations: AdvisoryObservation[] = [];

  // Core track observations
  if (track === 'core') {
    if (!profile.adcp_version || profile.adcp_version === 'v2') {
      observations.push({
        category: 'best_practice',
        severity: 'suggestion',
        track,
        message: 'Agent does not declare v3 protocol support. V3 provides richer capabilities and is recommended.',
        evidence: { detected_version: profile.adcp_version || 'unknown' },
      });
    }
    if (profile.tools.length < 3) {
      observations.push({
        category: 'completeness',
        severity: 'info',
        track,
        message: `Agent exposes ${profile.tools.length} tool(s). Most production agents expose 5+.`,
        evidence: { tool_count: profile.tools.length, tools: profile.tools },
      });
    }
  }

  // Products track observations
  if (track === 'products') {
    for (const result of results) {
      for (const step of result.steps ?? []) {
        if (step.response_preview && step.task === 'get_products') {
          try {
            const preview = JSON.parse(step.response_preview) as {
              products_count?: number;
              channels?: string[];
            };
            if (preview.products_count !== undefined) {
              if (preview.products_count === 0) {
                observations.push({
                  category: 'completeness',
                  severity: 'warning',
                  track,
                  message: 'Agent returned 0 products. Buyers cannot transact without product inventory.',
                  evidence: { products_count: 0 },
                });
              } else if (preview.products_count > 50) {
                observations.push({
                  category: 'best_practice',
                  severity: 'suggestion',
                  track,
                  message: `Agent returned ${preview.products_count} products for a single brief. Consider curating to 5-15 most relevant products.`,
                  evidence: { products_count: preview.products_count },
                });
              }
            }
            if (preview.channels && preview.channels.length === 1) {
              observations.push({
                category: 'completeness',
                severity: 'info',
                track,
                message: `Agent only serves ${preview.channels[0]} channel. Multi-channel inventory broadens demand.`,
                evidence: { channels: preview.channels },
              });
            }
          } catch {
            // response_preview isn't always JSON
          }
        }
      }
    }
  }

  // Creative track observations
  if (track === 'creative') {
    const hasSync = profile.tools.includes('sync_creatives');
    const hasFormats = profile.tools.includes('list_creative_formats');
    if (hasSync && !hasFormats) {
      observations.push({
        category: 'best_practice',
        severity: 'suggestion',
        track,
        message:
          'Agent supports sync_creatives but not list_creative_formats. ' +
          'Buyers need to know what formats you accept before sending creatives.',
      });
    }
  }

  // Error handling track observations
  if (track === 'error_handling') {
    for (const result of results) {
      for (const step of result.steps ?? []) {
        if (step.details) {
          const levelMatch = step.details.match(/L(\d)/);
          if (levelMatch) {
            const level = parseInt(levelMatch[1]!, 10);
            if (level < 3) {
              observations.push({
                category: 'error_compliance',
                severity: level < 2 ? 'warning' : 'suggestion',
                track,
                message:
                  `Error compliance at L${level}. L3 (structuredContent.adcp_error) is recommended. ` +
                  `Use adcpError() from @adcp/client for automatic L3 compliance.`,
                evidence: { compliance_level: level, step: step.step },
              });
            }
          }
        }
      }
    }
  }

  // Check for slow responses
  for (const result of results) {
    for (const step of result.steps ?? []) {
      if (step.passed && step.duration_ms > 10000) {
        observations.push({
          category: 'performance',
          severity: 'warning',
          track,
          message: `Step "${step.step}" took ${(step.duration_ms / 1000).toFixed(1)}s. Buyers expect sub-5s responses.`,
          evidence: { step: step.step, duration_ms: step.duration_ms },
        });
      }
    }
  }

  return observations;
}

export interface ComplyOptions extends TestOptions {
  /** Only run specific tracks (default: all applicable) */
  tracks?: ComplianceTrack[];
  /** Declare the platform type for coherence checking */
  platform_type?: PlatformType;
}

/**
 * Run compliance assessment against an agent.
 * Assesses all applicable tracks independently — never stops at first failure.
 */
export async function comply(agentUrl: string, options: ComplyOptions = {}): Promise<ComplianceResult> {
  try {
    return await complyImpl(agentUrl, options);
  } finally {
    await closeMCPConnections();
  }
}

async function complyImpl(agentUrl: string, options: ComplyOptions): Promise<ComplianceResult> {
  const start = Date.now();
  const { tracks: trackFilter, platform_type, ...testOptions } = options;
  const platformProfile = platform_type ? getPlatformProfile(platform_type) : undefined;

  const effectiveOptions: TestOptions = {
    ...testOptions,
    dry_run: testOptions.dry_run !== false,
    test_session_id: testOptions.test_session_id || `comply-${Date.now()}`,
  };

  // Discover agent capabilities first
  const client = createTestClient(agentUrl, effectiveOptions.protocol ?? 'mcp', effectiveOptions);
  const { profile, step: profileStep } = await discoverAgentProfile(client);

  if (!profileStep.passed) {
    const errorMsg = profileStep.error || 'Unknown error';
    const observations: AdvisoryObservation[] = [];

    // Check for auth errors — either explicit 401/Unauthorized or MCP SDK's generic
    // "Failed to discover" which often wraps a 401
    const isExplicitAuthError =
      errorMsg.includes('401') ||
      errorMsg.includes('Unauthorized') ||
      errorMsg.includes('unauthorized') ||
      errorMsg.includes('authentication') ||
      errorMsg.includes('JWS') ||
      errorMsg.includes('JWT') ||
      errorMsg.includes('signature verification');

    // When MCP SDK wraps the error, probe the endpoint directly
    let isAuthError = isExplicitAuthError;
    if (!isAuthError && errorMsg.includes('Failed to discover')) {
      try {
        const probe = await fetch(agentUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        if (probe.status === 401 || probe.status === 403) {
          isAuthError = true;
        }
      } catch {
        // Network error — not an auth issue
      }
    }

    const headline = isAuthError ? `Authentication required` : `Agent unreachable — ${errorMsg}`;

    if (isAuthError) {
      // Check if agent supports OAuth
      const { discoverOAuthMetadata } = await import('../../auth/oauth/discovery');
      const oauthMeta = await discoverOAuthMetadata(agentUrl);
      if (oauthMeta) {
        observations.push({
          category: 'auth',
          severity: 'error',
          message: `Agent requires OAuth (issuer: ${oauthMeta.issuer || 'unknown'}). Save credentials: adcp --save-auth <alias> ${agentUrl} --oauth`,
        });
      } else {
        observations.push({
          category: 'auth',
          severity: 'error',
          message: 'Agent returned 401. Check your --auth token.',
        });
      }
    }

    return {
      agent_url: agentUrl,
      agent_profile: profile,
      tracks: [],
      summary: {
        tracks_passed: 0,
        tracks_failed: 0,
        tracks_skipped: 0,
        tracks_partial: 0,
        tracks_expected: 0,
        headline,
      },
      observations,
      tested_at: new Date().toISOString(),
      total_duration_ms: Date.now() - start,
      dry_run: effectiveOptions.dry_run !== false,
    };
  }

  const tracksToRun = trackFilter ?? TRACK_ORDER;
  const trackResults: TrackResult[] = [];
  const allObservations: AdvisoryObservation[] = [];

  for (const track of tracksToRun) {
    const def = TRACK_DEFINITIONS[track];
    if (!def) continue;

    if (!isTrackApplicable(track, profile.tools)) {
      const isExpected = track !== 'core' && (platformProfile?.expected_tracks.includes(track) ?? false);
      trackResults.push({
        track,
        status: isExpected ? 'expected' : 'skip',
        label: def.label,
        scenarios: [],
        skipped_scenarios: def.scenarios,
        observations: [],
        duration_ms: 0,
      });
      continue;
    }

    const trackStart = Date.now();
    const applicable = getApplicableScenarios(profile.tools, def.scenarios);
    const skipped = def.scenarios.filter(s => !applicable.includes(s));

    // Track is relevant (agent has some related tools) but no scenarios match
    // the specific tool combinations. Report as pass with an observation.
    if (applicable.length === 0) {
      const relevantTools = TRACK_RELEVANCE[track].filter(t => profile.tools.includes(t));
      const observations: AdvisoryObservation[] = [
        {
          category: 'completeness',
          severity: 'info',
          track,
          message:
            `Agent has ${relevantTools.join(', ')} but no test scenarios cover this tool combination. ` +
            `Compliance tests exist for: ${def.scenarios.join(', ')}.`,
          evidence: { tools_present: relevantTools, scenarios_available: def.scenarios },
        },
      ];
      allObservations.push(...observations);
      trackResults.push({
        track,
        status: 'pass',
        label: def.label,
        scenarios: [],
        skipped_scenarios: skipped,
        observations,
        duration_ms: Date.now() - trackStart,
      });
      continue;
    }

    // Run each applicable scenario for this track
    const results: TestResult[] = [];
    for (const scenario of applicable) {
      const result = await runAgentTest(agentUrl, scenario, effectiveOptions);
      results.push(result);
    }

    const observations = collectObservations(track, results, profile);

    // Detect auth-only failures when running without auth
    const hasAuth = !!effectiveOptions.auth;
    const authSkippedScenarios = !hasAuth ? results.filter(r => isAuthOnlyFailure(r)).map(r => r.scenario) : [];

    if (authSkippedScenarios.length > 0) {
      observations.push({
        category: 'auth',
        severity: 'info',
        track,
        message:
          `${authSkippedScenarios.length} scenario(s) require authentication: ${authSkippedScenarios.join(', ')}. ` +
          `Re-run with --auth to test.`,
        evidence: { scenarios: authSkippedScenarios },
      });
    }

    allObservations.push(...observations);

    const status = computeTrackStatus(results, skipped.length, hasAuth);
    trackResults.push({
      track,
      status,
      label: def.label,
      scenarios: results,
      skipped_scenarios: skipped,
      observations,
      duration_ms: Date.now() - trackStart,
    });
  }

  // Build platform coherence result if platform type was declared
  let platformCoherence: PlatformCoherenceResult | undefined;
  if (platformProfile) {
    const findings = platformProfile.checkCoherence(profile);
    const missingTracks = platformProfile.expected_tracks.filter(
      t => !isTrackApplicable(t, profile.tools) && t !== 'core'
    );

    // Add coherence findings as observations
    for (const finding of findings) {
      allObservations.push({
        category: 'coherence',
        severity: finding.severity,
        message: `${finding.expected} — ${finding.actual}. ${finding.guidance}`,
        evidence: { platform_type: platformProfile.type },
      });
    }

    platformCoherence = {
      platform_type: platformProfile.type,
      label: platformProfile.label,
      expected_tracks: platformProfile.expected_tracks,
      missing_tracks: missingTracks,
      findings,
      coherent:
        findings.filter(f => f.severity === 'error' || f.severity === 'warning').length === 0 &&
        missingTracks.length === 0,
    };
  }

  const summary = buildSummary(trackResults);

  return {
    agent_url: agentUrl,
    agent_profile: profile,
    tracks: trackResults,
    summary,
    observations: allObservations,
    platform_coherence: platformCoherence,
    tested_at: new Date().toISOString(),
    total_duration_ms: Date.now() - start,
    dry_run: effectiveOptions.dry_run !== false,
  };
}

function buildSummary(tracks: TrackResult[]): ComplianceSummary {
  const passed = tracks.filter(t => t.status === 'pass').length;
  const failed = tracks.filter(t => t.status === 'fail').length;
  const skipped = tracks.filter(t => t.status === 'skip').length;
  const partial = tracks.filter(t => t.status === 'partial').length;
  const expected = tracks.filter(t => t.status === 'expected').length;

  const attempted = passed + failed + partial;
  let headline: string;

  if (attempted === 0) {
    headline = 'No applicable tracks found for this agent';
  } else if (failed === 0 && partial === 0) {
    headline = `All ${passed} track(s) pass`;
  } else if (passed === 0 && partial === 0) {
    headline = `All ${failed} attempted track(s) failing`;
  } else {
    const parts: string[] = [];
    if (passed > 0) parts.push(`${passed} passing`);
    if (partial > 0) parts.push(`${partial} partial`);
    if (failed > 0) parts.push(`${failed} failing`);
    headline = parts.join(', ');
  }

  if (expected > 0) {
    headline += `, ${expected} expected`;
  }

  return {
    tracks_passed: passed,
    tracks_failed: failed,
    tracks_skipped: skipped,
    tracks_partial: partial,
    tracks_expected: expected,
    headline,
  };
}

/**
 * Format compliance results for terminal display.
 */
export function formatComplianceResults(result: ComplianceResult): string {
  let output = '';

  // Header
  const overallIcon = result.summary.tracks_failed === 0 && result.summary.tracks_partial === 0 ? '✅' : '❌';
  output += `\n${overallIcon}  AdCP Compliance Report\n`;
  output += `${'─'.repeat(50)}\n`;
  output += `Agent:    ${result.agent_url}\n`;
  output += `Name:     ${result.agent_profile.name}\n`;
  output += `Tools:    ${result.agent_profile.tools.length}\n`;
  output += `Mode:     ${result.dry_run ? 'Dry Run' : 'Live'}\n`;
  if (result.platform_coherence) {
    output += `Platform: ${result.platform_coherence.label}\n`;
  }
  output += `Duration: ${(result.total_duration_ms / 1000).toFixed(1)}s\n\n`;

  // Summary line
  output += `${result.summary.headline}\n\n`;

  // Track results
  output += `Capability Tracks\n`;
  output += `${'─'.repeat(50)}\n`;

  for (const track of result.tracks) {
    const icon =
      track.status === 'pass'
        ? '✅'
        : track.status === 'fail'
          ? '❌'
          : track.status === 'partial'
            ? '⚠️'
            : track.status === 'expected'
              ? '🔲'
              : '⏭️';
    const scenarioCount = track.scenarios.length;
    const passedCount = track.scenarios.filter(s => s.overall_passed).length;

    if (track.status === 'skip') {
      output += `${icon}  ${track.label}  (not applicable)\n`;
    } else if (track.status === 'expected') {
      const label = result.platform_coherence?.label ?? 'declared platform type';
      output += `${icon}  ${track.label}  (expected for ${label})\n`;
    } else {
      output += `${icon}  ${track.label}  ${passedCount}/${scenarioCount} scenarios pass`;
      output += `  (${(track.duration_ms / 1000).toFixed(1)}s)\n`;

      // Show failed scenarios with details
      for (const scenario of track.scenarios) {
        if (!scenario.overall_passed) {
          output += `   ❌ ${scenario.scenario}\n`;
          const failedSteps = (scenario.steps ?? []).filter(s => !s.passed);
          for (const step of failedSteps.slice(0, 3)) {
            output += `      ${step.step}`;
            if (step.error) output += `: ${step.error}`;
            output += '\n';
          }
          if (failedSteps.length > 3) {
            output += `      ... and ${failedSteps.length - 3} more\n`;
          }
        }
      }
    }
  }

  // Platform coherence
  if (result.platform_coherence) {
    const pc = result.platform_coherence;
    output += `\nPlatform Coherence (${pc.label})\n`;
    output += `${'─'.repeat(50)}\n`;

    if (pc.coherent) {
      output += `✅  Agent is coherent with ${pc.label} expectations\n`;
    } else {
      if (pc.missing_tracks.length > 0) {
        output += `Expected tracks: ${pc.expected_tracks.join(', ')}\n`;
        output += `Missing tracks:  ${pc.missing_tracks.join(', ')}\n\n`;
      }
      for (const finding of pc.findings) {
        const icon = finding.severity === 'error' ? '❌' : finding.severity === 'warning' ? '⚠️' : '💡';
        output += `${icon}  ${finding.expected}\n`;
        output += `    ${finding.actual}\n`;
        output += `    → ${finding.guidance}\n`;
      }
    }
  }

  // Advisory observations (excluding coherence — shown above)
  const nonCoherenceObs = result.observations.filter(o => o.category !== 'coherence');
  if (nonCoherenceObs.length > 0) {
    output += `\nAdvisory Observations\n`;
    output += `${'─'.repeat(50)}\n`;

    const byCategory = new Map<string, AdvisoryObservation[]>();
    for (const obs of nonCoherenceObs) {
      const cat = obs.category;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(obs);
    }

    for (const [_category, observations] of byCategory) {
      for (const obs of observations) {
        const icon =
          obs.severity === 'error'
            ? '❌'
            : obs.severity === 'warning'
              ? '⚠️'
              : obs.severity === 'suggestion'
                ? '💡'
                : 'ℹ️';
        output += `${icon}  ${obs.message}\n`;
      }
    }
  }

  output += '\n';
  return output;
}

/**
 * Format compliance results as JSON.
 */
export function formatComplianceResultsJSON(result: ComplianceResult): string {
  return JSON.stringify(result, null, 2);
}
