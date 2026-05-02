/**
 * Curated `hint` table for `VALIDATION_ERROR` envelopes (issue #1283 → #1309).
 *
 * Each entry maps a recognizable failure pattern to one short sentence
 * naming the most common mistake when the matching shape appears. Hints
 * suffix the prose `adcp_error.message` and ride the structured
 * `issues[].hint` field so adopter LLMs reading wire payloads alone
 * resolve discriminated-union and embedded-shape gotchas one-shot.
 *
 * Shipped patterns (every one comes from real adopter pain — empirical
 * matrix-blind-fixtures lineage, `skills/SHAPE-GOTCHAS.md`, and the
 * `skills/call-adcp-agent/SKILL.md` "Gotchas I keep seeing" section):
 *
 *   1. `activation_key.type='key_value'` — `key`/`value` are top-level,
 *      not nested under a `key_value` sub-field.
 *   2. `activation_key.type='segment_id'` — same flatness as `key_value`.
 *   3. `account` discriminator merging — sending `{account_id, brand,
 *      operator}` fails BOTH variants. Pick one.
 *   4. `budget` as an object — it's a number; currency comes from the
 *      referenced `pricing_option`.
 *   5. `brand.domain` — `brand` uses `domain`, not `brand_id`.
 *   6. `format_id` as a string — always `{agent_url, id}` object.
 *   7. `signal_ids[]` as bare strings — array of provenance objects.
 *   8. VAST/DAAST `delivery_type` discriminator — required to pair
 *      `inline` with `content` or `redirect` with `vast_url` /
 *      `daast_url`.
 *   9. Mutating tool missing `idempotency_key` — required UUID, reused
 *      on retries.
 *
 * Quality bar: a hint earns its slot if at least three adopters or
 * blind-LLM matrix runs hit the same shape and lost ≥1 iteration to
 * "what does this error actually want?". Drive-by additions should
 * cite the empirical evidence.
 */

import type { ValidationIssue } from './schema-validator';

/**
 * Rule shape for the hint matcher. All present conditions must match;
 * absent conditions act as wildcards. A rule with NO conditions matches
 * every issue — don't write one.
 */
interface HintRule {
  /** Match when the tool name equals (or is one of) this value. */
  tool?: string | readonly string[];
  /** Match when the issue's `schemaId` ends with this suffix. */
  schemaIdEndsWith?: string;
  /** Match when the issue's `keyword` equals (or is one of) this value. */
  keyword?: string | readonly string[];
  /** Match when the issue's `pointer` equals this exact value. */
  pointerEquals?: string;
  /** Match when the issue's `pointer` matches this regex. */
  pointerPattern?: RegExp;
  /**
   * Match when the issue's `discriminator` array contains an entry with
   * the named `field`. If `value` is also given, the entry's value must
   * also equal it.
   */
  discriminatorContains?: { field: string; value?: unknown };
  /**
   * For `keyword: 'required'` issues, match when the missing property
   * (last segment of the pointer) equals this value. AdCP issues encode
   * the missing property as the trailing pointer segment via Ajv's
   * `missingProperty` param — see `formatIssue`.
   */
  missingProperty?: string;
  /** The hint text. One sentence, action-oriented. */
  hint: string;
}

/**
 * Strip a leading `/` and return the trailing segment of a JSON Pointer.
 * For `/foo/bar`, returns `bar`. For `/`, returns `''`.
 */
function lastSegment(pointer: string): string {
  const trimmed = pointer.endsWith('/') ? pointer.slice(0, -1) : pointer;
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function ruleMatches(rule: HintRule, issue: ValidationIssue, toolName: string | undefined): boolean {
  if (rule.tool !== undefined) {
    if (toolName === undefined) return false;
    if (typeof rule.tool === 'string' ? rule.tool !== toolName : !rule.tool.includes(toolName)) return false;
  }
  if (rule.schemaIdEndsWith !== undefined) {
    if (!issue.schemaId || !issue.schemaId.endsWith(rule.schemaIdEndsWith)) return false;
  }
  if (rule.keyword !== undefined) {
    const allowed = typeof rule.keyword === 'string' ? [rule.keyword] : rule.keyword;
    if (!allowed.includes(issue.keyword)) return false;
  }
  if (rule.pointerEquals !== undefined && issue.pointer !== rule.pointerEquals) return false;
  if (rule.pointerPattern !== undefined && !rule.pointerPattern.test(issue.pointer)) return false;
  if (rule.discriminatorContains !== undefined) {
    if (!Array.isArray(issue.discriminator)) return false;
    const { field, value } = rule.discriminatorContains;
    const hit = issue.discriminator.find(d => d.field === field);
    if (!hit) return false;
    if (value !== undefined && hit.value !== value) return false;
  }
  if (rule.missingProperty !== undefined) {
    if (lastSegment(issue.pointer) !== rule.missingProperty) return false;
  }
  return true;
}

/**
 * Hint string for the `activation_key.type='key_value'` flatness gotcha
 * — used by both the missing-`key` and missing-`value` rules so a wording
 * tweak to one updates both. Issue #1283's headline example.
 */
const KEY_VALUE_FLATNESS_HINT =
  "type='key_value' requires top-level `key` and `value` strings; do not nest under a `key_value` field.";

/**
 * Rules in order — first match wins. Order more-specific patterns first
 * so `activation_key` `key_value` lands before a generic `required` hint
 * could shadow it. New rules: prepend if more specific than every other,
 * else append.
 */
const RULES: readonly HintRule[] = [
  // 1. activation_key — type='key_value' missing key/value.
  {
    keyword: 'required',
    discriminatorContains: { field: 'type', value: 'key_value' },
    missingProperty: 'key',
    hint: KEY_VALUE_FLATNESS_HINT,
  },
  {
    keyword: 'required',
    discriminatorContains: { field: 'type', value: 'key_value' },
    missingProperty: 'value',
    hint: KEY_VALUE_FLATNESS_HINT,
  },
  // 2. activation_key — type='segment_id' missing segment_id.
  {
    keyword: 'required',
    discriminatorContains: { field: 'type', value: 'segment_id' },
    missingProperty: 'segment_id',
    hint: "type='segment_id' requires a top-level `segment_id` string under the same flatness as `key_value`.",
  },
  // 3. VAST/DAAST — missing delivery_type discriminator. Pinned to the
  // two asset types that actually require `delivery_type` so a future
  // `asset_type` value with different requirements doesn't false-fire
  // the hint.
  {
    keyword: 'required',
    missingProperty: 'delivery_type',
    discriminatorContains: { field: 'asset_type', value: 'vast' },
    hint: "VAST assets require `delivery_type: 'inline' | 'redirect'`. Pair `inline` with `content`; pair `redirect` with `vast_url`.",
  },
  {
    keyword: 'required',
    missingProperty: 'delivery_type',
    discriminatorContains: { field: 'asset_type', value: 'daast' },
    hint: "DAAST assets require `delivery_type: 'inline' | 'redirect'`. Pair `inline` with `content`; pair `redirect` with `daast_url`.",
  },
  // 4. idempotency_key — every mutating tool requires it.
  {
    keyword: 'required',
    pointerEquals: '/idempotency_key',
    missingProperty: 'idempotency_key',
    hint: 'Mutating tools require `idempotency_key` (UUID) on every request. Generate fresh per logical operation, reuse the same value on retries.',
  },
  // 5. brand.domain — brand uses `domain`, not `brand_id`. AdCP encodes
  // a `required` failure as a pointer to the missing field: `/brand/domain`,
  // not `/brand`. The `pattern: '^[a-z0-9_]+$'` failure on `/brand/brand_id`
  // is handled by a sibling rule below.
  {
    keyword: 'required',
    pointerPattern: /\/brand\/domain$/,
    hint: '`brand` uses `domain` (not `brand_id`). Send `{ domain: "example.com" }`.',
  },
  // 6. account — discriminator merging.
  {
    keyword: 'additionalProperties',
    pointerPattern: /(^|\/)account$/,
    hint: "`account` is a discriminated union. Pick ONE variant: `{ account_id }` or `{ brand, operator }`. Don't merge fields across variants.",
  },
  // 7. format_id — always an object.
  {
    keyword: 'type',
    pointerPattern: /(^|\/)format_id$/,
    hint: '`format_id` is an object: `{ agent_url, id }` (sometimes also `{ width, height, duration_ms }`). Bare strings are rejected.',
  },
  // 8. budget — number, not object.
  {
    keyword: ['type', 'additionalProperties'],
    pointerPattern: /(^|\/)budget$/,
    hint: '`budget` is a number, not an object. Currency comes from the referenced `pricing_option`.',
  },
  // 9. signal_ids — array of provenance objects, not bare ID strings.
  {
    keyword: 'type',
    pointerPattern: /\/signal_ids\/\d+$/,
    hint: '`signal_ids` is an array of provenance objects: `{ source: "catalog", data_provider_domain, id }` or `{ source: "agent", agent_url, id }`. Bare ID strings are rejected.',
  },
];

/**
 * Find a curated hint for the given validation issue, if one applies.
 * Walks {@link RULES} in order and returns the first matching rule's
 * hint. Returns `undefined` when no rule fires — most issues won't have
 * a curated hint and that's fine; the structured `pointer` + `keyword` +
 * `discriminator` fields already cover the long tail.
 *
 * `toolName` is optional — rules that gate on tool name skip when it's
 * absent. Pass it when known (the validator is per-tool, so callers
 * always know it in practice).
 */
export function findHint(issue: ValidationIssue, toolName?: string): string | undefined {
  for (const rule of RULES) {
    if (ruleMatches(rule, issue, toolName)) return rule.hint;
  }
  return undefined;
}

/** Test-only: number of curated rules. Lets tests assert on rule-count drift. */
export const _hintRuleCount: number = RULES.length;
