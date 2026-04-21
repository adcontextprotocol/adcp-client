/**
 * Shared types for the substitution observer/encoder surfaces.
 * The shapes match the test-kit contract at
 * `compliance/cache/latest/test-kits/substitution-observer-runner.yaml`.
 */

export interface TrackerUrlRecord {
  /** Parsed URL. For HTML-relative URLs, resolved against `https://observer.test/`. */
  url: URL;
  /** Attribute the URL was extracted from (`href`, `src`, `srcset`, `data-impression-url`, ...). */
  source_attr: string;
  /** HTML tag the URL was extracted from (`a`, `img`, `iframe`, `meta`, ...). */
  source_tag: string;
  /** Best-effort line number in the preview HTML, 1-indexed. `null` if unknown. */
  line_hint: number | null;
}

export interface CatalogBinding {
  /** AdCP macro token, braces included. Example: `{GTIN}`. */
  macro: string;
  /** Catalog item ID that produced `raw_value` — links back to sync_catalogs. */
  catalog_item_id?: string;
  /** Canonical fixture vector name. Looked up by runners against the shipped fixture. */
  vector_name?: string;
  /** Override when binding a custom (non-canonical) value. Redacted in error reports by default. */
  raw_value?: string;
  /** Override when binding a custom value. Runner compares observed bytes against this. */
  expected_encoded?: string;
}

export interface BindingMatch {
  /** The binding this match satisfies. */
  binding: CatalogBinding;
  /** The raw_value resolved from the fixture vector (or the inline override). */
  raw_value: string;
  /** The expected_encoded resolved from the fixture (or the inline override). */
  expected_encoded: string;
  /** Parsed observed URL whose aligned position produced `observed_value`. */
  observed_url: URL;
  /** The tracker record this observation came from (attribute, tag, line hint). */
  record: TrackerUrlRecord;
  /**
   * Alignment position inside the template. `href_whole_value` indicates the
   * macro occupied the entire attribute value — subject to
   * `assert_scheme_preserved`.
   */
  position:
    | { kind: 'query'; key: string; index: number }
    | { kind: 'path'; index: number }
    | { kind: 'href_whole_value' };
  /** Observed value at the aligned position — the bytes emitted after substitution. */
  observed_value: string;
  /**
   * True when the binding was resolved via inline `raw_value` /
   * `expected_encoded` overrides rather than a canonical fixture
   * vector. The contract's `error_report_payload_policy` requires
   * custom vectors to be SHA-256 redacted in error reports — the
   * assertion helpers honor this flag when populating
   * {@link AssertionResult.observed} and `.expected`.
   */
  is_custom_vector: boolean;
}

export interface AssertionResult {
  ok: boolean;
  /**
   * Error code from the contract's `step_task.error_modes`. Set when `ok` is false.
   */
  error_code?:
    | 'substitution_encoding_violation'
    | 'nested_macro_re_expansion'
    | 'substitution_scheme_injection'
    | 'substitution_binding_missing';
  /** Offset of the first diverging byte inside `observed_value`. `-1` if not applicable. */
  byte_offset?: number;
  /** Human-readable detail suitable for a grader report. */
  message?: string;
  /**
   * Expected bytes at the failing position. For canonical fixture
   * vectors this is echoed verbatim; for custom bindings this is a
   * `sha256:<hex>` digest unless {@link AssertionOptions.include_raw_payloads}
   * is explicitly set.
   */
  expected?: string;
  /**
   * Observed bytes at the failing position. Subject to the same
   * redaction policy as {@link expected}.
   */
  observed?: string;
}

/**
 * Options for assertion helpers. Mirrors the contract's
 * `error_report_payload_policy` block: canonical fixtures can be
 * echoed; custom payloads are SHA-256 redacted unless the grader was
 * started with `--include-raw-payloads` (and even then never under
 * AdCP Verified).
 */
export interface AssertionOptions {
  /**
   * Override the redaction default. `true` echoes `raw_value` and
   * `observed_value` verbatim regardless of `is_custom_vector`. Do
   * NOT enable this in Verified-grading mode — the setting exists
   * only for local debugging.
   *
   * Default: `false`.
   */
  include_raw_payloads?: boolean;
}

/**
 * SSRF policy the runner enforces when fetching a `preview_url`. The default
 * export `DEFAULT_SSRF_POLICY` mirrors the contract's explicit deny lists.
 */
export interface SsrfPolicy {
  schemes_allowed: readonly string[];
  schemes_denied: readonly string[];
  hosts_denied_ipv4_cidrs: readonly string[];
  hosts_denied_ipv6_cidrs: readonly string[];
  hosts_denied_metadata: readonly string[];
  /**
   * - `reject`: bare IP literal (v4 or v6) in the URL is rejected regardless of range.
   *   Forces resolution through a public DNS name (AdCP Verified behavior).
   * - `allow`: IP literal is permitted subject only to the CIDR deny lists. Local-dev default.
   */
  host_literal_policy: 'reject' | 'allow';
}

export interface PolicyResult {
  allowed: boolean;
  /**
   * When `allowed` is false, names the specific rule that denied the URL.
   * Examples: `schemes_denied:javascript`, `hosts_denied_ipv4_cidrs:169.254.0.0/16`,
   * `hosts_denied_metadata:metadata.google.internal`, `host_literal_policy:reject`.
   */
  rule?: string;
  /** Human-readable detail. */
  message?: string;
}

/**
 * Canonical vector shape — matches the JSON fixture at
 * `static/test-vectors/catalog-macro-substitution.json` in the AdCP repo.
 */
export interface CatalogMacroVector {
  name: string;
  description: string;
  macro: string;
  value: string;
  template: string;
  expected: string;
}
