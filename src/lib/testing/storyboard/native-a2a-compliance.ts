import { normalizeTransportOptions } from '../../protocols';
import type { StoryboardRunOptions } from './types';

/**
 * Default compliance runs to native A2A 1.0. An explicit compatibility
 * policy is preserved so 13.x can still regression-test its maintained 0.3
 * public server adapter without changing that adapter's wire contract.
 */
export function applyNativeA2AComplianceTransportOptions(options: StoryboardRunOptions): StoryboardRunOptions {
  const transport = normalizeTransportOptions(options.transport);
  if (options.protocol !== 'a2a') {
    return transport === options.transport ? options : { ...options, transport };
  }
  if (transport?.legacyCompat !== undefined) {
    return transport === options.transport ? options : { ...options, transport };
  }
  return {
    ...options,
    transport: {
      ...transport,
      legacyCompat: { enabled: false },
    },
  };
}
