/** Translate SDK JSON Pointers to the AdCP error.field JSONPath-lite notation. */
export function jsonPointerToJsonPathLite(pointer: string): string | undefined {
  // SDK validation diagnostics historically use '/' for the root.
  if (pointer === '' || pointer === '/') return '$';
  if (!pointer.startsWith('/')) return undefined;
  let field = '';
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (/^(0|[1-9][0-9]*)$/.test(segment)) {
      field += `${field ? '' : '$'}[${segment}]`;
    } else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) {
      field += field ? `.${segment}` : segment;
    } else {
      field += `${field ? '' : '$'}[${JSON.stringify(segment)}]`;
    }
  }
  return field;
}
