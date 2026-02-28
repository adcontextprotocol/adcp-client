/**
 * Deprecation warning utility for backward-compat shims.
 *
 * Each key is warned once per process lifetime to avoid log spam.
 */

const warned = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[@adcp/client] DEPRECATED: ${message}`);
  }
}

/**
 * Reset all deprecation warnings. Only useful in tests.
 */
export function resetWarnings(): void {
  warned.clear();
}
