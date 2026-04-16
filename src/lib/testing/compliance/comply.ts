/**
 * Compliance Engine
 *
 * Storyboard-driven compliance assessment. Storyboards are the routing
 * mechanism; tracks are a reporting layer derived from storyboard results.
 *
 * Resolution priority: storyboards > platform_type > all applicable.
 */

import { createTestClient, discoverAgentProfile } from '../client';
import type { TestOptions, TestResult, AgentProfile } from '../types';
import { mapStoryboardResultsToTrackResult, TRACK_LABELS } from './storyboard-tracks';
import { runStoryboard } from '../storyboard/runner';
import { loadBundledStoryboards, getStoryboardById, getScenarioById } from '../storyboard/loader';
import type { Storyboard, StoryboardResult, StoryboardRunOptions } from '../storyboard/types';
import { PLATFORM_STORYBOARDS } from './platform-storyboards';
import type {
  ComplianceTrack,
  ComplianceFailure,
  TrackResult,
  ComplianceResult,
  ComplianceSummary,
  AdvisoryObservation,
  OverallStatus,
  PlatformType,
  PlatformCoherenceResult,
} from './types';
import { getPlatformProfile, getAllPlatformTypes } from './profiles';
import type { PlatformProfile } from './profiles';
import { closeConnections } from '../../protocols';
import { detectController, hasTestController } from '../test-controller';
import type { ControllerDetection } from '../test-controller';

/**
 * All compliance tracks in display order.
 */
const TRACK_ORDER: ComplianceTrack[] = [
  'core',
  'products',
  'media_buy',
  'creative',
  'reporting',
  'governance',
  'campaign_governance',
  'signals',
  'si',
  'audiences',
  'error_handling',
  'brand',
];

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
        if (step.task === 'get_products' && step.observation_data) {
          const obs = step.observation_data as { products_count?: number; channels?: string[] };
          if (obs.products_count !== undefined) {
            if (obs.products_count === 0) {
              observations.push({
                category: 'completeness',
                severity: 'warning',
                track,
                message: 'Agent returned 0 products. Buyers cannot transact without product inventory.',
                evidence: { products_count: 0 },
              });
            } else if (obs.products_count > 50) {
              observations.push({
                category: 'best_practice',
                severity: 'suggestion',
                track,
                message: `Agent returned ${obs.products_count} products for a single brief. Consider curating to 5-15 most relevant products.`,
                evidence: { products_count: obs.products_count },
              });
            }
          }
          if (obs.channels && obs.channels.length === 1) {
            observations.push({
              category: 'completeness',
              severity: 'info',
              track,
              message: `Agent only serves ${obs.channels[0]} channel. Multi-channel inventory broadens demand.`,
              evidence: { channels: obs.channels },
            });
          }
        }
      }
    }
  }

  // Media buy track observations
  if (track === 'media_buy') {
    // Check for valid_actions support (first match only)
    let checkedValidActions = false;
    for (const result of results) {
      if (checkedValidActions) break;
      for (const step of result.steps ?? []) {
        if (step.task === 'get_media_buys' && step.observation_data) {
          const obs = step.observation_data as {
            valid_actions?: unknown;
            history_entries?: number;
            history_valid?: boolean;
            has_creative_deadline?: boolean;
            sandbox?: unknown;
          };
          if (obs.valid_actions === undefined || obs.valid_actions === null) {
            observations.push({
              category: 'best_practice',
              severity: 'warning',
              track,
              message:
                'Agent does not return valid_actions in get_media_buys response. ' +
                'Without valid_actions, buyer agents must hardcode the state machine to know what operations are permitted.',
            });
          }

          if (obs.has_creative_deadline === false) {
            observations.push({
              category: 'best_practice',
              severity: 'suggestion',
              track,
              message:
                'Agent does not return creative_deadline on media buys or packages. ' +
                'Buyers need to know when creative uploads must be finalized to avoid rejected submissions.',
            });
          }

          if (obs.history_entries && obs.history_entries > 0 && obs.history_valid === false) {
            observations.push({
              category: 'best_practice',
              severity: 'warning',
              track,
              message:
                'Agent returns history entries but some lack required fields (timestamp, action). ' +
                'History entries must include at least timestamp and action to be useful for audit.',
            });
          }

          if (obs.sandbox === undefined || obs.sandbox === null) {
            observations.push({
              category: 'best_practice',
              severity: 'suggestion',
              track,
              message:
                'Agent does not confirm sandbox mode in get_media_buys response. ' +
                'Include sandbox: true so buyers can verify the agent honored sandbox mode.',
            });
          }

          checkedValidActions = true;
          break;
        }
      }
    }

    // Check for confirmed_at and revision in create_media_buy responses (first match only)
    let checkedCreateLifecycle = false;
    for (const result of results) {
      if (checkedCreateLifecycle) break;
      for (const step of result.steps ?? []) {
        if (step.task === 'create_media_buy' && step.observation_data) {
          const obs = step.observation_data as { confirmed_at?: unknown; revision?: unknown };
          if (obs.confirmed_at === undefined || obs.confirmed_at === null) {
            observations.push({
              category: 'best_practice',
              severity: 'warning',
              track,
              message:
                'Agent does not return confirmed_at in create_media_buy response. ' +
                'A successful response constitutes order confirmation — confirmed_at provides an auditable timestamp for dispute resolution.',
            });
          }
          if (obs.revision === undefined || obs.revision === null) {
            observations.push({
              category: 'best_practice',
              severity: 'suggestion',
              track,
              message:
                'Agent does not return revision in create_media_buy response. ' +
                'Revision numbers enable optimistic concurrency for safe concurrent updates.',
            });
          }
          checkedCreateLifecycle = true;
          break;
        }
      }
    }

    // Check for history support in get_media_buys responses (first match only)
    let checkedHistory = false;
    for (const result of results) {
      if (checkedHistory) break;
      for (const step of result.steps ?? []) {
        if (step.task === 'get_media_buys' && step.observation_data) {
          const obs = step.observation_data as { history_entries?: number };
          if (obs.history_entries !== undefined && obs.history_entries === 0) {
            observations.push({
              category: 'best_practice',
              severity: 'suggestion',
              track,
              message:
                'Agent does not return revision history when include_history is requested. ' +
                'History enables audit trails and helps buyers understand what changed.',
            });
          }
          checkedHistory = true;
          break;
        }
      }
    }

    // Check canceled_by validation on canceled media buys (first match only)
    let checkedCancellation = false;
    for (const result of results) {
      if (checkedCancellation) break;
      for (const step of result.steps ?? []) {
        if (step.task === 'update_media_buy' && step.observation_data) {
          const obs = step.observation_data as {
            status?: string;
            canceled_by?: string;
            canceled_at?: string;
          };
          if (obs.status === 'canceled') {
            if (!obs.canceled_by) {
              observations.push({
                category: 'completeness',
                severity: 'warning',
                track,
                message:
                  'Agent transitions to canceled status but does not include canceled_by field. ' +
                  'Buyers need to distinguish buyer-initiated from seller-initiated cancellations.',
              });
            }
            if (!obs.canceled_at) {
              observations.push({
                category: 'completeness',
                severity: 'warning',
                track,
                message:
                  'Agent transitions to canceled status but does not include canceled_at timestamp. ' +
                  'A cancellation timestamp is required for audit and reconciliation.',
              });
            }
            checkedCancellation = true;
          }
        }
      }
    }

    // Check if lifecycle scenarios revealed missing pause/resume support
    const lifecycleResult = results.find(r => r.scenario === 'media_buy_lifecycle');
    if (lifecycleResult && !lifecycleResult.overall_passed) {
      const pauseFailed = (lifecycleResult.steps ?? []).find(s => s.step === 'Pause media buy' && !s.passed);
      if (pauseFailed) {
        observations.push({
          category: 'completeness',
          severity: 'warning',
          track,
          message: 'Agent does not support pause/resume operations on media buys.',
          evidence: { error: pauseFailed.error },
        });
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

  // Campaign governance track observations
  if (track === 'campaign_governance') {
    let anyCheckMissingContext = false;
    for (const result of results) {
      for (const step of result.steps ?? []) {
        if (step.task === 'check_governance' && step.passed && step.observation_data) {
          if (!step.observation_data.governance_context) {
            anyCheckMissingContext = true;
          }
        }
      }
    }
    if (anyCheckMissingContext) {
      observations.push({
        category: 'best_practice',
        severity: 'warning',
        track,
        message:
          'Governance agent did not return governance_context on check_governance response. ' +
          'Without it, sellers cannot maintain governance continuity across the media buy lifecycle.',
      });
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
  /**
   * Run specific storyboards by ID.
   * Takes priority over tracks and platform_type.
   * Example: comply(url, { storyboards: ['media_buy_seller', 'social_platform'] })
   */
  storyboards?: string[];
  /** Only run specific tracks (default: all applicable). Ignored when storyboards is set. Also bypassed when platform_type is set without tracks. */
  tracks?: ComplianceTrack[];
  /** Declare the platform type for coherence checking. Accepts any string — validated internally. */
  platform_type?: PlatformType | string;
  /** Timeout in milliseconds — stops new storyboards from starting when exceeded */
  timeout_ms?: number;
  /** AbortSignal for external cancellation (e.g., graceful shutdown) */
  signal?: AbortSignal;
  /** Original agent alias or identifier (used in fix_command instead of resolved URL) */
  agent_alias?: string;
}

/**
 * Run compliance assessment against an agent.
 * Assesses all applicable storyboards and reports results grouped by track.
 *
 * Resolution priority:
 * 1. options.storyboards — run exactly these storyboard IDs
 * 2. options.platform_type (when tracks is not set) — resolve via PLATFORM_STORYBOARDS
 * 3. options.tracks — run all storyboards for these tracks
 * 4. Default — run all applicable storyboards
 *
 * When platform_type is set, it always drives coherence checking regardless
 * of how the storyboard pool was resolved.
 */
export async function comply(agentUrl: string, options: ComplyOptions = {}): Promise<ComplianceResult> {
  try {
    return await complyImpl(agentUrl, options);
  } finally {
    await closeConnections(options.protocol);
  }
}

// ────────────────────────────────────────────────────────────
// Storyboard resolution
// ────────────────────────────────────────────────────────────

/**
 * Resolve the storyboard pool based on options.
 * Priority: storyboards > platform_type (when tracks is not set) > tracks > all bundled.
 */
function resolveStoryboards(options: ComplyOptions): Storyboard[] {
  // Explicit storyboard IDs — highest priority
  if (options.storyboards?.length) {
    const resolved: Storyboard[] = [];
    for (const id of options.storyboards) {
      const sb = getStoryboardById(id);
      if (!sb) {
        throw new Error(`Unknown storyboard ID: "${id}". Use listStoryboards() to see available IDs.`);
      }
      resolved.push(sb);
    }
    return resolved;
  }

  // Platform type — resolve via PLATFORM_STORYBOARDS
  if (options.platform_type && !options.tracks) {
    const pt = options.platform_type as PlatformType;
    const ids = PLATFORM_STORYBOARDS[pt];
    if (ids) {
      const resolved: Storyboard[] = [];
      for (const id of ids) {
        const sb = getStoryboardById(id);
        if (sb) {
          resolved.push(sb);
        } else {
          // Data integrity issue — storyboard declared in PLATFORM_STORYBOARDS
          // but not found in bundled set. This is a packaging bug.
          console.warn(`PLATFORM_STORYBOARDS[${pt}] references unknown storyboard "${id}"`);
        }
      }
      // Also include universal storyboards (no platform_types) not already in the set
      const resolvedIds = new Set(resolved.map(s => s.id));
      for (const sb of loadBundledStoryboards()) {
        if (!sb.track) continue;
        if (resolvedIds.has(sb.id)) continue;
        if (!sb.platform_types?.length) {
          resolved.push(sb);
        }
      }
      return resolved;
    }
  }

  // Track filter — run storyboards whose track field matches
  if (options.tracks?.length) {
    const trackSet = new Set(options.tracks);
    return loadBundledStoryboards().filter(sb => sb.track && trackSet.has(sb.track as ComplianceTrack));
  }

  // Default — all compliance storyboards (those with a track field)
  return loadBundledStoryboards().filter(sb => sb.track);
}

/**
 * Filter storyboards to those applicable for the agent's tools.
 * A storyboard is applicable if the agent has at least one of its required_tools,
 * or if it has no required_tools at all.
 */
function filterApplicable(storyboards: Storyboard[], agentTools: string[]): Storyboard[] {
  return storyboards.filter(sb => {
    if (!sb.required_tools?.length) return true;
    return sb.required_tools.some(tool => agentTools.includes(tool));
  });
}

/**
 * Expand storyboards by resolving their requires_scenarios.
 * Each required scenario is loaded and inserted before its parent storyboard.
 * Scenarios are deduplicated — if multiple storyboards require the same scenario, it runs once.
 */
function expandScenarios(storyboards: Storyboard[]): Storyboard[] {
  const seen = new Set<string>(storyboards.map(s => s.id));
  const expanded: Storyboard[] = [];

  for (const sb of storyboards) {
    if (sb.requires_scenarios?.length) {
      for (const scenarioId of sb.requires_scenarios) {
        if (seen.has(scenarioId)) continue;
        const scenario = getScenarioById(scenarioId);
        if (!scenario) {
          throw new Error(
            `Storyboard "${sb.id}" requires unknown scenario "${scenarioId}". ` +
              `Check requires_scenarios in ${sb.id} for typos.`
          );
        }
        if (scenario.requires_scenarios?.length) {
          throw new Error(
            `Scenario "${scenarioId}" has requires_scenarios, but nested scenario ` +
              `dependencies are not supported. Only top-level storyboards may declare requires_scenarios.`
          );
        }
        seen.add(scenarioId);
        expanded.push(scenario);
      }
    }
    expanded.push(sb);
  }

  return expanded;
}

/**
 * Group storyboard results by track.
 */
function groupByTrack(
  results: StoryboardResult[],
  storyboards: Storyboard[]
): Map<ComplianceTrack, StoryboardResult[]> {
  // Build a storyboard ID → track lookup
  const trackLookup = new Map<string, ComplianceTrack>();
  for (const sb of storyboards) {
    if (sb.track) {
      trackLookup.set(sb.id, sb.track as ComplianceTrack);
    }
  }

  const grouped = new Map<ComplianceTrack, StoryboardResult[]>();
  for (const result of results) {
    const track = trackLookup.get(result.storyboard_id);
    if (!track) continue;
    if (!grouped.has(track)) grouped.set(track, []);
    grouped.get(track)!.push(result);
  }
  return grouped;
}

// ────────────────────────────────────────────────────────────
// Failure extraction
// ────────────────────────────────────────────────────────────

/**
 * Extract a flat list of failures from raw storyboard results.
 * Preserves step_id and expected text from the storyboard YAML,
 * and includes a fix_command for targeted re-running.
 */
function extractFailures(
  results: StoryboardResult[],
  storyboards: Storyboard[],
  agentRef: string
): ComplianceFailure[] {
  const failures: ComplianceFailure[] = [];

  // Build storyboard lookup for track and expected text
  const sbLookup = new Map<string, Storyboard>();
  for (const sb of storyboards) {
    sbLookup.set(sb.id, sb);
  }

  for (const result of results) {
    const sb = sbLookup.get(result.storyboard_id);
    const track = (sb?.track as ComplianceTrack) ?? 'core';

    for (const phase of result.phases) {
      for (const step of phase.steps) {
        if (step.passed || step.skipped) continue;

        // Find the step definition in the storyboard for expected text
        let expected: string | undefined;
        if (sb) {
          for (const p of sb.phases) {
            const stepDef = p.steps.find(s => s.id === step.step_id);
            if (stepDef?.expected) {
              expected = stepDef.expected.trim();
              break;
            }
          }
        }

        failures.push({
          track,
          storyboard_id: result.storyboard_id,
          step_id: step.step_id,
          step_title: step.title,
          task: step.task,
          error: step.error,
          expected,
          fix_command: `adcp storyboard step ${agentRef} ${result.storyboard_id} ${step.step_id} --json`,
        });
      }
    }
  }

  return failures;
}

// ────────────────────────────────────────────────────────────
// Core implementation
// ────────────────────────────────────────────────────────────

async function complyImpl(agentUrl: string, options: ComplyOptions): Promise<ComplianceResult> {
  const start = Date.now();
  const {
    storyboards: _storyboardIds,
    tracks: _trackFilter,
    platform_type,
    timeout_ms,
    signal: externalSignal,
    ...testOptions
  } = options;

  // Validate platform_type if provided
  let platformProfile: PlatformProfile | undefined;
  if (platform_type) {
    const validTypes: string[] = getAllPlatformTypes();
    if (!validTypes.includes(platform_type)) {
      throw new Error(`Unknown platform_type: "${platform_type}". Valid types: ${validTypes.join(', ')}`);
    }
    platformProfile = getPlatformProfile(platform_type as PlatformType);
  }

  // Validate timeout_ms
  if (timeout_ms !== undefined) {
    if (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms <= 0) {
      throw new TypeError(`timeout_ms must be a positive finite number, got: ${timeout_ms}`);
    }
  }

  // Build a combined AbortSignal from timeout_ms and/or external signal
  const needsAbort = timeout_ms !== undefined || externalSignal !== undefined;
  const abortController = needsAbort ? new AbortController() : undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = externalSignal ? () => abortController!.abort(externalSignal.reason) : undefined;

  if (timeout_ms !== undefined && abortController) {
    timeoutId = setTimeout(
      () => abortController.abort(new Error(`comply() timed out after ${timeout_ms}ms`)),
      timeout_ms
    );
  }

  if (externalSignal && abortController) {
    if (externalSignal.aborted) {
      abortController.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort!, { once: true });
    }
  }

  const signal = abortController?.signal;

  try {
    const effectiveOptions: TestOptions = {
      ...testOptions,
      sandbox: testOptions.sandbox !== false,
      test_session_id: testOptions.test_session_id || `comply-${Date.now()}`,
    };

    // Check for abort before starting
    signal?.throwIfAborted();

    // Collect observations across all tracks
    const allObservations: AdvisoryObservation[] = [];

    // Discover agent capabilities once and share across all storyboards
    const client = createTestClient(agentUrl, effectiveOptions.protocol ?? 'mcp', effectiveOptions);
    const { profile, step: profileStep } = await discoverAgentProfile(client);
    effectiveOptions._client = client;
    effectiveOptions._profile = profile;

    // Log discovered tools
    if (profileStep.passed) {
      allObservations.push({
        category: 'tool_discovery',
        severity: 'info',
        message: `Discovered ${profile.tools.length} tools: [${profile.tools.join(', ')}]`,
        evidence: { tools: profile.tools },
      });
    }

    // Detect test controller for deterministic mode
    let controllerDetection: ControllerDetection = { detected: false };
    if (profileStep.passed && hasTestController(profile)) {
      controllerDetection = await detectController(client as any, profile, effectiveOptions);
      if (controllerDetection.detected) {
        effectiveOptions._controllerCapabilities = controllerDetection;
      }
    }

    if (!profileStep.passed) {
      return buildUnreachableResult(agentUrl, profile, profileStep.error, start, effectiveOptions, signal);
    }

    // Resolve and filter storyboard pool
    const allStoryboards = resolveStoryboards(options);
    const withScenarios = expandScenarios(allStoryboards);
    const applicableStoryboards = filterApplicable(withScenarios, profile.tools);

    // Run storyboards
    const storyboardResults: StoryboardResult[] = [];
    const runOptions: StoryboardRunOptions = {
      ...effectiveOptions,
      agentTools: profile.tools,
    };

    for (const sb of applicableStoryboards) {
      signal?.throwIfAborted();
      const result = await runStoryboard(agentUrl, sb, runOptions);
      storyboardResults.push(result);
    }

    // Group results by track and build TrackResults
    const grouped = groupByTrack(storyboardResults, applicableStoryboards);
    const trackResults: TrackResult[] = [];

    // Determine which tracks had storyboards in the pool (even if filtered out by tools)
    const poolTrackSet = new Set<ComplianceTrack>();
    for (const sb of withScenarios) {
      if (sb.track) poolTrackSet.add(sb.track as ComplianceTrack);
    }

    for (const track of TRACK_ORDER) {
      if (!poolTrackSet.has(track)) continue;

      const results = grouped.get(track) ?? [];

      if (results.length > 0) {
        const trackResult = mapStoryboardResultsToTrackResult(track, results, profile);
        const observations = collectObservations(track, trackResult.scenarios, profile);
        trackResult.observations = observations;
        allObservations.push(...observations);
        trackResults.push(trackResult);
      } else {
        // Track was in the pool but no storyboards ran (agent lacks tools)
        const isExpected = track !== 'core' && (platformProfile?.expected_tracks.includes(track) ?? false);
        trackResults.push({
          track,
          status: isExpected ? 'expected' : 'skip',
          label: TRACK_LABELS[track] || track,
          scenarios: [],
          skipped_scenarios: [],
          observations: [],
          duration_ms: 0,
        });
      }
    }

    // Build platform coherence result if platform type was declared
    let platformCoherence: PlatformCoherenceResult | undefined;
    if (platformProfile) {
      const findings = platformProfile.checkCoherence(profile);
      const applicableTrackSet = new Set(
        trackResults.filter(t => t.status !== 'skip' && t.status !== 'expected').map(t => t.track)
      );
      const missingTracks = platformProfile.expected_tracks.filter(t => !applicableTrackSet.has(t) && t !== 'core');

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
    const testedTracks = trackResults.filter(t => t.status === 'pass' || t.status === 'fail' || t.status === 'partial');
    const skippedTracks = trackResults
      .filter(t => t.status === 'skip')
      .map(t => ({
        track: t.track,
        label: t.label,
        reason: 'Agent lacks required tools for applicable storyboards',
      }));
    const expectedTracks = trackResults
      .filter(t => t.status === 'expected')
      .map(t => ({
        track: t.track,
        label: t.label,
        reason: `Expected for ${platformCoherence?.label ?? 'declared platform type'}`,
      }));

    const overallStatus = computeOverallStatus(summary);

    // Build flat failures array from raw storyboard results (preserves step_id and expected)
    const agentRef = options.agent_alias || agentUrl;
    const failures = extractFailures(storyboardResults, applicableStoryboards, agentRef);

    return {
      agent_url: agentUrl,
      agent_profile: profile,
      overall_status: overallStatus,
      tracks: trackResults,
      tested_tracks: testedTracks,
      skipped_tracks: skippedTracks,
      expected_tracks: expectedTracks,
      summary,
      observations: allObservations,
      failures: failures.length > 0 ? failures : undefined,
      platform_coherence: platformCoherence,
      storyboards_executed: applicableStoryboards.map(sb => sb.id),
      controller_detected: controllerDetection.detected,
      controller_scenarios: controllerDetection.detected ? controllerDetection.scenarios : undefined,
      tested_at: new Date().toISOString(),
      total_duration_ms: Date.now() - start,
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (onExternalAbort && externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Build result for an unreachable or auth-required agent.
 */
async function buildUnreachableResult(
  agentUrl: string,
  profile: AgentProfile,
  errorMsg: string | undefined,
  start: number,
  effectiveOptions: TestOptions,
  signal?: AbortSignal
): Promise<ComplianceResult> {
  const err = errorMsg || 'Unknown error';
  const observations: AdvisoryObservation[] = [];

  const isExplicitAuthError =
    err.includes('401') ||
    err.includes('Unauthorized') ||
    err.includes('unauthorized') ||
    err.includes('authentication') ||
    err.includes('JWS') ||
    err.includes('JWT') ||
    err.includes('signature verification');

  let isAuthError = isExplicitAuthError;
  if (!isAuthError && err.includes('Failed to discover')) {
    try {
      const probe = await fetch(agentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
      });
      if (probe.status === 401 || probe.status === 403) {
        isAuthError = true;
      }
    } catch {
      // Network error — not an auth issue
    }
  }

  const headline = isAuthError ? `Authentication required` : `Agent unreachable — ${err}`;

  if (isAuthError) {
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
    overall_status: (isAuthError ? 'auth_required' : 'unreachable') as OverallStatus,
    tracks: [],
    tested_tracks: [],
    skipped_tracks: [],
    expected_tracks: [],
    summary: {
      tracks_passed: 0,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_expected: 0,
      headline,
    },
    observations,
    storyboards_executed: [],
    tested_at: new Date().toISOString(),
    total_duration_ms: Date.now() - start,
  };
}

/**
 * Compute overall status for a reachable agent.
 * auth_required and unreachable are set directly in the early-exit path.
 */
export function computeOverallStatus(summary: ComplianceSummary): OverallStatus {
  const attempted = summary.tracks_passed + summary.tracks_failed + summary.tracks_partial;
  if (attempted === 0) return 'partial';
  if (summary.tracks_failed === 0 && summary.tracks_partial === 0) return 'passing';
  if (summary.tracks_passed === 0 && summary.tracks_partial === 0) return 'failing';
  return 'partial';
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
  output += `Mode:     Sandbox\n`;
  if (result.platform_coherence) {
    output += `Platform: ${result.platform_coherence.label}\n`;
  }
  output += `Duration: ${(result.total_duration_ms / 1000).toFixed(1)}s\n`;
  if (result.storyboards_executed?.length) {
    output += `Storyboards: ${result.storyboards_executed.join(', ')}\n`;
  }
  output += '\n';

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

  // Failures with fix guidance (show up to 5 with expected text)
  const failuresWithExpected = (result.failures ?? []).filter(f => f.expected);
  if (failuresWithExpected.length > 0) {
    output += `\nHow to Fix\n`;
    output += `${'─'.repeat(50)}\n`;
    for (const f of failuresWithExpected.slice(0, 5)) {
      output += `❌ ${f.storyboard_id}/${f.step_id} (${f.task})\n`;
      if (f.error) output += `   Error: ${f.error}\n`;
      output += `   Expected: ${f.expected!.split('\n')[0]}\n`;
      output += `   Debug: ${f.fix_command}\n`;
    }
    if (failuresWithExpected.length > 5) {
      output += `   ... and ${failuresWithExpected.length - 5} more (use --json for all)\n`;
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
