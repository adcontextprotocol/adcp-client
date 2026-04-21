import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { TaskResult } from '../core/ConversationTypes';
import type { ConformanceToolName, OracleVerdict } from './types';
import { loadResponseSchema } from './schemaLoader';

export interface OracleInput {
  tool: ConformanceToolName;
  request: unknown;
  /** TaskResult envelope returned by AgentClient.executeTask. */
  result: TaskResult<unknown>;
  /** Auth token that was used to make the request — checked for leaks. */
  authToken?: string;
}

export interface OracleOutput {
  verdict: OracleVerdict;
  invariantFailures: string[];
}

// Substring signatures (fast) — match language-specific stack frame shapes.
// Haystack is JSON-encoded so real \n become literal "\n" (two chars);
// signatures use literal \n characters and match the JSON-escape form.
const STACK_TRACE_SIGNATURES = [
  '    at ', // V8 / Node
  'Traceback (most recent call last)', // Python
  'node_modules/',
  '.py", line',
  '\\n  File "', // Python, JSON-escaped newline
  'goroutine ', // Go runtime panic header
  '\\n\\tat ', // JVM "\tat com.foo.Bar(Bar.java:42)" frames in JSON-encoded body
  'Stack trace:\\n#0 ', // PHP uncaught-exception traceback preamble
];

// Regex signatures (slower, run second) — shapes that need structure to
// avoid over-matching on innocent strings.
const STACK_TRACE_REGEXES: readonly RegExp[] = [
  // Go: `main.fn(0x1234)\n\t/app/main.go:42 +0x1a`
  /\.go:\d+ \+0x[0-9a-f]+/,
  // PHP: `#7 /var/www/foo.php(42): Bar->baz()` — numbered frame with file:line
  /#\d+ [^\s]+\.php\(\d+\):/,
  // JVM: `at com.foo.Bar.method(Bar.java:42)` — fully-qualified method with
  // source:line. Package names can include nested dots and $ for inner
  // classes; file is usually .java/.kt/.scala.
  /at [\w$.]+\.[\w$]+\([\w$]+\.(?:java|kt|kts|scala|groovy):\d+\)/,
  // .NET: `at Foo.Bar.Baz() in /path/to/X.cs:line 42` — method invocation
  // followed by ` in ` and a file:line marker. The method-name charset
  // includes parens/brackets for generic and overloaded signatures.
  /at [\w.<>`,()[\]]+ in [^:\s]+\.(?:cs|vb|fs):line \d+/,
];

const FS_PATH_SIGNATURES = [/\/Users\/[^ "']+/, /\/home\/[^ "']+/, /[A-Z]:\\\\Users\\\\/];

let cachedAjv: Ajv | null = null;
function getAjv(): Ajv {
  if (cachedAjv) return cachedAjv;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  cachedAjv = ajv;
  return ajv;
}

const compiledValidators = new Map<ConformanceToolName, ReturnType<Ajv['compile']>>();
function responseValidator(tool: ConformanceToolName): ReturnType<Ajv['compile']> {
  const cached = compiledValidators.get(tool);
  if (cached) return cached;
  const schema = loadResponseSchema(tool);
  const validator = getAjv().compile(schema);
  compiledValidators.set(tool, validator);
  return validator;
}

/**
 * Does the response schema declare a top-level `context` property —
 * either directly or on one of its `oneOf` branches? When it does, a
 * request-context that's not echoed is an invariant violation; when it
 * doesn't, a missing context field is silent tolerance.
 */
const responseSchemaHasContext = new Map<ConformanceToolName, boolean>();
function responseEchoesContext(tool: ConformanceToolName): boolean {
  const cached = responseSchemaHasContext.get(tool);
  if (cached !== undefined) return cached;
  const schema = loadResponseSchema(tool) as {
    properties?: Record<string, unknown>;
    oneOf?: Array<{ properties?: Record<string, unknown> }>;
  };
  const direct = !!schema.properties && 'context' in schema.properties;
  const branched = Array.isArray(schema.oneOf) && schema.oneOf.some(b => !!b.properties && 'context' in b.properties);
  const answer = direct || branched;
  responseSchemaHasContext.set(tool, answer);
  return answer;
}

/**
 * Warm the response-schema validator for a tool. Throws if Ajv can't
 * compile — the runner uses that as the signal to skip the tool rather
 * than fail every iteration. Separated from `evaluate()` so the failure
 * surfaces once per tool, not once per sample.
 */
export function prepareResponseValidator(tool: ConformanceToolName): void {
  responseValidator(tool);
}

/**
 * Classify a tool response under the two-path oracle.
 *
 * Accepted: `TaskResult.data` validates against the response schema.
 * Rejected: `TaskResult.success === false` with a well-formed error
 *   envelope (non-empty code, human-readable message).
 * Invalid: neither — the agent crashed, truncated the envelope, leaked a
 *   stack trace, or echoed a credential.
 *
 * Invariants hold on both accepted and rejected paths: no credential leak,
 * no stack trace / filesystem path in the response body, and `context` is
 * echoed unchanged when the caller supplied one.
 */
export function evaluate(input: OracleInput): OracleOutput {
  const { tool, request, result, authToken } = input;
  const invariantFailures: string[] = [];

  checkNoAuthLeak(result, authToken, invariantFailures);
  checkNoStackLeak(result, invariantFailures);
  checkNoFilesystemLeak(result, invariantFailures);
  checkContextEchoed(tool, request, result, invariantFailures);

  if (result.success === false) {
    checkErrorEnvelope(result, invariantFailures);
    return {
      verdict: invariantFailures.length === 0 ? 'rejected' : 'invalid',
      invariantFailures,
    };
  }

  if (result.status !== 'completed' || result.data === undefined) {
    // Intermediate states (working/submitted/input-required) don't exercise
    // the response-schema path — treat as rejected (nothing to invariant-check).
    return { verdict: 'rejected', invariantFailures };
  }

  const validate = responseValidator(tool);
  if (!validate(result.data)) {
    const errors = (validate.errors ?? []).slice(0, 3).map(formatAjvError);
    invariantFailures.push(`response schema mismatch: ${errors.join('; ')}`);
    return { verdict: 'invalid', invariantFailures };
  }

  return {
    verdict: invariantFailures.length === 0 ? 'accepted' : 'invalid',
    invariantFailures,
  };
}

/**
 * Stringify every channel an agent can leak through: payload, error
 * message, `adcpError.code`/`.message`/`.details`, correlation id, and
 * task metadata. The earlier version scanned only `result.data` and
 * `result.error`, so leaks through `adcpError.details.stack` slipped
 * past.
 */
function buildLeakHaystack(result: TaskResult<unknown>): string {
  const parts: unknown[] = [
    result.data,
    result.error,
    result.adcpError,
    (result as { correlationId?: unknown }).correlationId,
    (result as { metadata?: unknown }).metadata,
  ];
  return parts.map(p => (p === undefined ? '' : safeStringify(p))).join(' ');
}

function checkNoAuthLeak(result: TaskResult<unknown>, authToken: string | undefined, failures: string[]): void {
  // 8-char floor catches random 4-byte coincidences without triggering on
  // every short hex-looking string. Detects verbatim echo only — agents
  // can evade by re-encoding. Documented in docs/guides/CONFORMANCE.md.
  if (!authToken || authToken.length < 8) return;
  if (buildLeakHaystack(result).includes(authToken)) failures.push('auth token echoed in response body');
}

function checkNoStackLeak(result: TaskResult<unknown>, failures: string[]): void {
  const haystack = buildLeakHaystack(result);
  for (const sig of STACK_TRACE_SIGNATURES) {
    if (haystack.includes(sig)) {
      failures.push(`stack trace leak (matched ${JSON.stringify(sig)})`);
      return;
    }
  }
  for (const rx of STACK_TRACE_REGEXES) {
    if (rx.test(haystack)) {
      failures.push(`stack trace leak (matched ${rx.source})`);
      return;
    }
  }
}

function checkNoFilesystemLeak(result: TaskResult<unknown>, failures: string[]): void {
  const haystack = buildLeakHaystack(result);
  for (const sig of FS_PATH_SIGNATURES) {
    if (sig.test(haystack)) {
      failures.push(`filesystem path leak (matched ${sig.source})`);
      return;
    }
  }
}

function checkContextEchoed(
  tool: ConformanceToolName,
  request: unknown,
  result: TaskResult<unknown>,
  failures: string[]
): void {
  const reqContext = (request as { context?: unknown } | undefined)?.context;
  if (reqContext === undefined) return;
  const respContext = (result.data as { context?: unknown } | undefined)?.context;
  if (respContext === undefined) {
    // When the response schema declares a `context` property, a missing
    // echo IS a violation — the spec requires unchanged pass-through.
    // When the schema omits `context` (some discovery-only responses do),
    // silent tolerance stands.
    if (responseEchoesContext(tool)) {
      failures.push('request.context not echoed on response (schema declares context but response omitted it)');
    }
    return;
  }
  if (!deepEqual(reqContext, respContext)) {
    failures.push('request.context not echoed unchanged on response');
  }
}

function checkErrorEnvelope(result: TaskResult<unknown>, failures: string[]): void {
  if (!result.error || typeof result.error !== 'string' || result.error.length === 0) {
    failures.push('error envelope missing human-readable message');
  }
  const code = result.adcpError?.code;
  if (code === undefined) {
    failures.push('error envelope missing reason code');
    return;
  }
  if (typeof code !== 'string' || code.length === 0) {
    failures.push(`reason code is not a non-empty string: ${JSON.stringify(code)}`);
    return;
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
    failures.push(`reason code "${code}" is not uppercase-snake format per spec`);
  }
}

function formatAjvError(e: { instancePath?: string; message?: string; keyword?: string }): string {
  const path = e.instancePath || '(root)';
  return `${path}: ${e.message ?? e.keyword ?? 'invalid'}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Key-order-insensitive structural equality. JSON.stringify-based compare
 * produces false positives when an agent round-trips `context` through a
 * dict/map that doesn't preserve insertion order (Python, Go).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object).sort();
  const bKeys = Object.keys(b as object).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false;
  for (const key of aKeys) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}
