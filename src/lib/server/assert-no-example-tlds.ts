/**
 * Fail-fast startup guard for adopters who fork a `hello_*_adapter_*.ts`
 * worked example and ship without flipping the seed constants.
 *
 * The worked examples wire load-bearing tenant directories like
 * `KNOWN_PUBLISHERS = ['acmeoutdoor.example', ...]`. The FORK CHECKLIST
 * header tells adopters to replace those values before deploying, but a
 * checklist is only as strong as the reader. This helper turns the
 * reminder into a runtime assertion: if `.example`-TLD strings are still
 * present at module load and `NODE_ENV` isn't in the dev/test allowlist,
 * the process exits with a descriptive error before serving traffic.
 *
 * Gating uses an explicit `allowIn` allowlist ({ 'test', 'development' }
 * by default) rather than `NODE_ENV !== 'production'` — unset / typo'd
 * env values must fail closed, not be treated as "probably dev."
 */

export interface AssertNoExampleTldsOptions {
  /**
   * Skip the assertion when `NODE_ENV` matches one of these values.
   * Default: `['test', 'development']`.
   *
   * The allowlist is exact-match (no startsWith / regex). Unset or
   * unknown `NODE_ENV` always triggers the assertion.
   */
  allowIn?: string[];
}

/**
 * Throws if any string in `constants` ends with `.example` (case-insensitive)
 * when `NODE_ENV` is not in the allowlist. Designed to catch adopters who
 * fork a `hello_*_adapter` example and ship without flipping the seed
 * constants in the FORK CHECKLIST.
 *
 * Pass the record shape `{ KNOWN_PUBLISHERS, KNOWN_ADVERTISERS, ... }`;
 * the helper scans string values and string-array elements. Other value
 * types are ignored (numbers, booleans, nested objects), so it's safe to
 * pass adjacent module constants without false positives.
 *
 * @example
 *   const KNOWN_PUBLISHERS = ['acmeoutdoor.example', 'premium-sports.example'];
 *   assertNoExampleTlds({ KNOWN_PUBLISHERS });
 *   // Throws unless NODE_ENV is 'test' or 'development'.
 */
export function assertNoExampleTlds(constants: Record<string, unknown>, opts: AssertNoExampleTldsOptions = {}): void {
  const allowIn = opts.allowIn ?? ['test', 'development'];
  const nodeEnv = process.env['NODE_ENV'] ?? '';
  if (allowIn.includes(nodeEnv)) return;

  const offenders: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(constants)) {
    if (typeof value === 'string') {
      if (endsWithExampleTld(value)) {
        offenders.push({ key, value });
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && endsWithExampleTld(item)) {
          offenders.push({ key, value: item });
        }
      }
    }
  }

  if (offenders.length === 0) return;

  const detail = offenders.map(o => `  ${o.key}: ${o.value}`).join('\n');
  throw new Error(
    `Adapter forked without flipping example constants:\n${detail}\n\n` +
      `Set NODE_ENV=development or NODE_ENV=test if these are intentional, ` +
      `or update the constants in your fork. See the FORK CHECKLIST in the ` +
      `worked example for the full list.`
  );
}

function endsWithExampleTld(s: string): boolean {
  return /\.example$/i.test(s);
}
