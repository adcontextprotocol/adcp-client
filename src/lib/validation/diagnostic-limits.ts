import type { ValidationIssue } from './schema-validator';

// The dispatcher mirrors diagnostics in structured and text envelopes. Bound
// the source list before those copies are serialized, including enrichment.
const MAX_ISSUES = 100;
const MAX_ISSUE_BYTES = 64 * 1024;
const MAX_SINGLE_ISSUE_BYTES = 8 * 1024;
const OMITTED_MESSAGE = 'Validation failed; additional diagnostics omitted because the diagnostic limit was reached.';
// Reserve room for the first omitted failure's bounded pointer and keyword.
const OMITTED_BYTES = 8 * 1024;

export function validationDiagnosticsTruncated(issues: readonly ValidationIssue[]): boolean {
  return issues.some(issue => issue.message === OMITTED_MESSAGE);
}

/** Retain actionable diagnostics with a visible marker when count/bytes overflow. */
export function boundValidationIssues(issues: Iterable<ValidationIssue>): ValidationIssue[] {
  const bounded: ValidationIssue[] = [];
  let bytes = 2; // JSON array brackets
  for (const issue of issues) {
    const issueBytes = Buffer.byteLength(JSON.stringify(issue), 'utf8') + 1;
    if (
      bounded.length >= MAX_ISSUES ||
      issueBytes > MAX_SINGLE_ISSUE_BYTES ||
      bytes + issueBytes + OMITTED_BYTES > MAX_ISSUE_BYTES
    ) {
      const omitted = bounded.length === MAX_ISSUES ? bounded.pop()! : issue;
      // Keep a real schema failure and its canonical keyword, rather than
      // inventing a diagnostic-limit keyword that buyers cannot act on.
      bounded.push({
        pointer: Buffer.byteLength(omitted.pointer, 'utf8') <= 1024 ? omitted.pointer : '/',
        keyword: Buffer.byteLength(omitted.keyword, 'utf8') <= 128 ? omitted.keyword : 'type',
        message: OMITTED_MESSAGE,
        schemaPath: '',
      });
      break;
    }
    bounded.push(issue);
    bytes += issueBytes;
  }
  return bounded;
}
