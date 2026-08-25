/**
 * Framework-only metadata for an adopter-authored MCP text summary.
 *
 * The payload and summary live in a module-private WeakMap rather than on the
 * marker object. This guarantees the wrapper cannot accidentally become part
 * of `structuredContent`; the platform adapter must explicitly extract it,
 * project the payload, and hand the text to the SDK-owned response builder.
 */

const RESPONSE_SUMMARY_BRAND: unique symbol = Symbol.for('@adcp/decisioning/response-summary');
declare const RESPONSE_SUMMARY_PAYLOAD: unique symbol;

const MAX_RESPONSE_SUMMARY_BYTES = 4096;
const UNSAFE_RESPONSE_SUMMARY_CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

type ResponseSummaryEntry<TPayload extends object> = Readonly<{
  payload: TPayload;
  summary: string;
}>;

const responseSummaryEntries = new WeakMap<object, ResponseSummaryEntry<object>>();

/**
 * Opaque non-wire result returned by {@link withResponseSummary}.
 *
 * @public
 */
export interface ResponseWithSummary<TPayload extends object> {
  readonly [RESPONSE_SUMMARY_BRAND]: true;
  /** Type-only phantom retaining payload invariance in published declarations. */
  readonly [RESPONSE_SUMMARY_PAYLOAD]?: TPayload;
}

/**
 * Attach adopter-authored human-readable text to a native platform result.
 *
 * The SDK retains ownership of protocol projection, validation, and the MCP
 * envelope. Only `content[].text` is customized; `payload` remains the sole
 * source of structured protocol data. Supply only trusted, static disclosure
 * text: summaries may be cached and must never contain credentials, buyer
 * input, upstream responses, or other secrets.
 *
 * @public
 */
export function withResponseSummary<TPayload extends object>(
  payload: TPayload,
  summary: string
): ResponseWithSummary<TPayload> {
  if (payload === null || typeof payload !== 'object') {
    throw new TypeError('withResponseSummary payload must be an object');
  }
  if (typeof summary !== 'string') {
    throw new TypeError('withResponseSummary summary must be a string');
  }
  if (new TextEncoder().encode(summary).byteLength > MAX_RESPONSE_SUMMARY_BYTES) {
    throw new RangeError(`withResponseSummary summary exceeds ${MAX_RESPONSE_SUMMARY_BYTES} UTF-8 bytes`);
  }
  if (UNSAFE_RESPONSE_SUMMARY_CONTROL_CHAR_RE.test(summary)) {
    throw new TypeError('withResponseSummary summary contains unsafe control characters');
  }

  const marker = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperty(marker, RESPONSE_SUMMARY_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.freeze(marker);
  responseSummaryEntries.set(marker, { payload, summary });
  return marker as unknown as ResponseWithSummary<TPayload>;
}

/** @internal Platform-adapter extraction seam. */
export function _extractResponseSummaryEntry<TPayload extends object>(
  value: unknown
): ResponseSummaryEntry<TPayload> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return responseSummaryEntries.get(value) as ResponseSummaryEntry<TPayload> | undefined;
}
