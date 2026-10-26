import { parseStrictJson, StrictJsonError } from './agent-resolver/strict-json';

/** Validate authenticated body bytes under the same strict JSON policy. */
export function assertSignedBodyWellFormed(body: string | Uint8Array | undefined): void {
  if (body === undefined) return;
  let text: string;
  try {
    // Preserve a leading BOM so it cannot be silently stripped by the decoder.
    text = typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new StrictJsonError('invalid_json', 'Signed body is not UTF-8');
  }
  // JSON.parse rejects a BOM, while secure-json-parse strips it. Refuse that
  // parser disagreement just as the operation-resolution precheck does.
  if (text.charCodeAt(0) === 0xfeff) throw new StrictJsonError('invalid_json', 'Signed body starts with a BOM');
  // Preserve the existing request verifier policy for absent/empty bodies.
  if (text.trim() !== '') parseStrictJson(text);
}
