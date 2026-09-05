/** Shared internal credential-shape redaction for diagnostic strings. */

const CREDENTIAL_LABEL =
  '(x[_-]?adcp[_-]?auth|authorization|credentials?|private[_-]?key|api[_-]?key|key[_-]?id|signing[_-]?key|signature|client[_-]?secret|client[_-]?id|refresh[_-]?token|access[_-]?token|session[_-]?token|offering[_-]?token|password|passwd|pwd|secret|token|key|jwt|bearer|set[_-]?cookie|cookie)';

function findQuotedValueEnd(message: string, start: number, escapedWrapper: boolean): number {
  for (let index = start; index < message.length; index++) {
    if (message[index] !== '"') continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= start && message[cursor] === '\\'; cursor--) slashCount++;
    if (escapedWrapper ? slashCount === 1 : slashCount % 2 === 0) {
      return escapedWrapper ? index - 1 : index;
    }
  }
  return -1;
}

function redactJsonCredentialFields(message: string, escapedWrapper: boolean): string {
  const opening = escapedWrapper ? '\\\\"' : '"';
  const fieldStart = new RegExp(`${opening}${CREDENTIAL_LABEL}${opening}\\s*:\\s*${opening}`, 'gi');
  let cursor = 0;
  let redacted = '';
  for (let match = fieldStart.exec(message); match; match = fieldStart.exec(message)) {
    const valueStart = fieldStart.lastIndex;
    const valueEnd = findQuotedValueEnd(message, valueStart, escapedWrapper);
    if (valueEnd === -1) return `${redacted}${message.slice(cursor, valueStart)}<redacted>`;
    redacted += `${message.slice(cursor, valueStart)}<redacted>`;
    cursor = valueEnd;
    fieldStart.lastIndex = valueEnd + (escapedWrapper ? 2 : 1);
  }
  return cursor === 0 ? message : redacted + message.slice(cursor);
}

/**
 * Scrub labelled credentials, Authorization headers, and URL basic-auth.
 * Wire-facing callers retain the conservative unlabeled-token rule by
 * default; callers can disable it when labelled credential matching is the
 * intended contract.
 *
 * @internal
 */
export function redactCredentialPatterns(message: unknown, redactUnlabeledTokens = true): unknown {
  if (typeof message !== 'string' || message.length === 0) return message;
  const redacted = redactJsonCredentialFields(redactJsonCredentialFields(message, true), false)
    .replace(/\bAuthorization\s*[=:]\s*[^\r\n]+/gi, 'Authorization=<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9_\-.~+/=]{8,}/gi, 'Bearer <redacted>')
    .replace(/(https?:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1<redacted>@')
    .replace(
      new RegExp(`(?<!["\\\\])\\b${CREDENTIAL_LABEL}['"]?\\s*[=:]\\s*(?:'[^']*'|"[^"]*"|[^\\s,;]+)`, 'gi'),
      '$1=<redacted>'
    );

  if (!redactUnlabeledTokens) return redacted;
  return redacted.replace(
    /(?<![A-Za-z0-9_\-.~+/=])[A-Za-z0-9_\-.~+/=]{32,}(?![A-Za-z0-9_\-.~+/=])/g,
    '<redacted-token>'
  );
}
