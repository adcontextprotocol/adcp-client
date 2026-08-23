import type { Storyboard } from './types';

/**
 * Loader-owned compliance provenance.
 *
 * Storyboard YAML is data, not authority to select arbitrary local filesystem
 * roots. Keep the trusted cache root out-of-band so an ad-hoc `--file`
 * storyboard cannot forge the public `compliance_dir` diagnostic field and
 * cause bundle-relative fixtures or credentials to be read from elsewhere.
 */
const complianceRoots = new WeakMap<object, string>();

export function markStoryboardComplianceRoot<T extends Storyboard>(storyboard: T, complianceDir: string): T {
  complianceRoots.set(storyboard, complianceDir);
  return storyboard;
}

export function trustedStoryboardComplianceRoot(storyboard: object): string | undefined {
  return complianceRoots.get(storyboard);
}
