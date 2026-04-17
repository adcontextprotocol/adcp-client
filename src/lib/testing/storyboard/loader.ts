/**
 * Storyboard YAML parser.
 *
 * Storyboards are pulled from the compliance cache populated by
 * `npm run sync-schemas`. See `./compliance.ts` for capability-driven
 * resolution and bundle loading.
 */

import { readFileSync } from 'fs';
import { parse } from 'yaml';
import type { Storyboard } from './types';

/** Parse a YAML string into a Storyboard. Throws if required fields are missing. */
export function parseStoryboard(yamlContent: string): Storyboard {
  const parsed = parse(yamlContent) as Storyboard;
  if (!parsed?.id || !parsed?.phases) {
    throw new Error('Invalid storyboard YAML: missing required fields (id, phases)');
  }
  // YAML uses `name:` for context outputs but our runtime expects `key:`.
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

/** Load and parse a single storyboard file. Useful for ad-hoc testing of in-development YAMLs. */
export function loadStoryboardFile(filePath: string): Storyboard {
  return parseStoryboard(readFileSync(filePath, 'utf-8'));
}
