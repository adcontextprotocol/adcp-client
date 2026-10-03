import { normalizeTransportOptions } from '../../protocols';
import type { StoryboardRunOptions } from './types';

/**
 * Grade A2A storyboards against the native A2A 1.0 transport contract.
 *
 * The SDK keeps legacy compatibility enabled by default for adopters. A
 * compliance run is different: accepting the v0.3 compatibility projection
 * would grade an agent against behavior it did not declare. Keep this override
 * at the runner boundary so ordinary SDK clients retain the compatibility
 * default.
 *
 * @internal
 */
export function applyNativeA2AComplianceTransportOptions(options: StoryboardRunOptions): StoryboardRunOptions {
  const transport = normalizeTransportOptions(options.transport);
  if (options.protocol !== 'a2a') {
    return transport === options.transport ? options : { ...options, transport };
  }
  if (transport === options.transport && transport?.legacyCompat?.enabled === false) {
    return options;
  }
  return {
    ...options,
    transport: {
      ...transport,
      legacyCompat: { enabled: false },
    },
  };
}
