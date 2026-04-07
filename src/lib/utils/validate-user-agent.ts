/**
 * Validate a user-agent string for safe use in HTTP headers.
 * Rejects newlines (CRLF injection) and null bytes (header truncation).
 *
 * @throws {Error} if the value contains forbidden characters
 */
export function validateUserAgent(value: string): void {
  if (/[\r\n\x00]/.test(value)) {
    throw new Error('userAgent must not contain newline or null characters');
  }
}
