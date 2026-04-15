/**
 * Storyboard YAML loader.
 *
 * Parses storyboard YAML files into typed Storyboard objects.
 * Bundled storyboards ship with the package in the storyboards/ directory.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { parse } from 'yaml';
import type { Storyboard } from './types';

/**
 * Parse a YAML string into a Storyboard.
 */
export function parseStoryboard(yamlContent: string): Storyboard {
  const parsed = parse(yamlContent) as Storyboard;
  if (!parsed?.id || !parsed?.phases) {
    throw new Error('Invalid storyboard YAML: missing required fields (id, phases)');
  }
  // Normalize context_outputs: YAML uses "name" but TypeScript expects "key"
  for (const phase of parsed.phases) {
    for (const step of phase.steps) {
      if (step.context_outputs) {
        for (const output of step.context_outputs) {
          const raw = output as unknown as Record<string, unknown>;
          if (raw.name && !raw.key) {
            output.key = raw.name as string;
          }
        }
      }
    }
  }
  return parsed;
}

/**
 * Load a storyboard from a file path.
 */
export function loadStoryboardFile(filePath: string): Storyboard {
  const content = readFileSync(filePath, 'utf-8');
  return parseStoryboard(content);
}

/**
 * Resolve the bundled storyboards directory.
 * Works from both source (src/lib/testing/storyboard/) and dist (dist/lib/testing/storyboard/).
 */
function getStoryboardsDir(): string {
  // Walk up from this file to the package root, then into storyboards/
  // From src/lib/testing/storyboard/ or dist/lib/testing/storyboard/ → 4 levels up
  return resolve(__dirname, '..', '..', '..', '..', 'storyboards');
}

let _bundledCache: Storyboard[] | null = null;

/**
 * Load all bundled storyboards from the storyboards/ directory.
 * Results are cached after the first call.
 */
export function loadBundledStoryboards(): Storyboard[] {
  if (_bundledCache) return _bundledCache;

  const dir = getStoryboardsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      f => (f.endsWith('.yaml') || f.endsWith('.yml')) && f !== 'schema.yaml' && f !== 'fictional-entities.yaml'
    );
  } catch {
    return [];
  }

  _bundledCache = files.map(f => loadStoryboardFile(join(dir, f)));
  return _bundledCache;
}

// ────────────────────────────────────────────────────────────
// Scenario loading (storyboards/scenarios/**/*)
// ────────────────────────────────────────────────────────────

let _scenarioCache: Storyboard[] | null = null;

/**
 * Resolve the bundled scenarios directory.
 */
function getScenariosDir(): string {
  return join(getStoryboardsDir(), 'scenarios');
}

/**
 * Recursively collect YAML files from a directory tree.
 */
function collectYamlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        results.push(...collectYamlFiles(fullPath));
      } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        results.push(fullPath);
      }
    } catch {
      // Skip entries we can't stat
    }
  }
  return results;
}

/**
 * Load all bundled scenarios from the storyboards/scenarios/ directory tree.
 * Scenarios are storyboards organized by agent type (e.g., media_buy_seller/).
 * Results are cached after the first call.
 */
export function loadBundledScenarios(): Storyboard[] {
  if (_scenarioCache) return _scenarioCache;

  const dir = getScenariosDir();
  if (!existsSync(dir)) {
    _scenarioCache = [];
    return _scenarioCache;
  }

  const files = collectYamlFiles(dir);
  _scenarioCache = files.map(f => loadStoryboardFile(f));
  return _scenarioCache;
}

/**
 * Get a bundled scenario by ID.
 */
export function getScenarioById(id: string): Storyboard | undefined {
  return loadBundledScenarios().find(s => s.id === id);
}

/**
 * Resolve the required scenarios for a storyboard.
 * Returns scenario storyboards in the order declared by requires_scenarios.
 */
export function resolveRequiredScenarios(storyboard: Storyboard): Storyboard[] {
  if (!storyboard.requires_scenarios?.length) return [];

  const scenarios: Storyboard[] = [];
  for (const id of storyboard.requires_scenarios) {
    const scenario = getScenarioById(id);
    if (!scenario) {
      throw new Error(
        `Storyboard "${storyboard.id}" requires unknown scenario "${id}". ` +
        `Available scenarios: [${loadBundledScenarios().map(s => s.id).join(', ')}]`
      );
    }
    scenarios.push(scenario);
  }
  return scenarios;
}

/**
 * Get a bundled storyboard by ID. Falls back to scenarios if not found
 * in the top-level storyboard set.
 */
export function getStoryboardById(id: string): Storyboard | undefined {
  return loadBundledStoryboards().find(s => s.id === id)
    ?? getScenarioById(id);
}

/**
 * Get bundled storyboards that match a platform type tag.
 */
export function getStoryboardsForPlatformType(platformType: string): Storyboard[] {
  return loadBundledStoryboards().filter(s => s.platform_types?.includes(platformType));
}

/**
 * Get compliance storyboards (those with a `track` field set).
 */
export function getComplianceStoryboards(): Storyboard[] {
  return loadBundledStoryboards().filter(s => s.track);
}

/**
 * Get compliance storyboards for a specific track.
 */
export function getComplianceStoryboardsForTrack(track: string): Storyboard[] {
  return getComplianceStoryboards().filter(s => s.track === track);
}

/**
 * Get compliance storyboards applicable to an agent based on its tools.
 * A storyboard is applicable if the agent has at least one of its required_tools.
 */
export function getApplicableComplianceStoryboards(track: string, agentTools: string[]): Storyboard[] {
  return getComplianceStoryboardsForTrack(track).filter(s => {
    if (!s.required_tools?.length) return true;
    return s.required_tools.some(tool => agentTools.includes(tool));
  });
}

/**
 * Get all bundled storyboard IDs with titles and categories.
 */
export function listStoryboards(): Array<{
  id: string;
  title: string;
  category: string;
  summary: string;
  track?: string;
  platform_types?: string[];
  step_count: number;
}> {
  return loadBundledStoryboards().map(s => ({
    id: s.id,
    title: s.title,
    category: s.category,
    summary: s.summary,
    track: s.track,
    platform_types: s.platform_types,
    step_count: s.phases.reduce((sum, p) => sum + p.steps.length, 0),
  }));
}
