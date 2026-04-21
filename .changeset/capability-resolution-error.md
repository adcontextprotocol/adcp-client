---
'@adcp/client': minor
---

Add typed `CapabilityResolutionError` for `resolveStoryboardsForCapabilities` (and by extension `comply()`). Addresses [#734](https://github.com/adcontextprotocol/adcp-client/issues/734).

**The problem.** The resolver threw plain `Error` instances for two distinct, actionable agent-config faults — "specialism has no bundle" and "specialism's parent protocol isn't declared in `supported_protocols`". Callers (AAO's compliance heartbeat, `evaluate_agent_quality`, the public `applicable-storyboards` REST endpoint) could only distinguish them by regexing the message, which broke if wording drifted and caused agent-config faults to page observability as system errors.

**The fix.** Export `CapabilityResolutionError extends ADCPError` with a `code` discriminator and structured fields so callers can branch without parsing messages:

```ts
import { CapabilityResolutionError } from '@adcp/client/testing';

try {
  resolveStoryboardsForCapabilities(caps);
} catch (err) {
  if (err instanceof CapabilityResolutionError) {
    switch (err.code) {
      case 'unknown_specialism':
        // err.specialism
        break;
      case 'specialism_parent_protocol_missing':
        // err.specialism, err.parentProtocol
        break;
    }
  }
}
```

Existing message text is preserved so regex-based callers keep working during the migration. The `unknown_protocol` code is reserved for future use — today an unknown `supported_protocols` entry still logs a `console.warn` and is skipped (fail-open), not thrown.
