/** Reject unpaired UTF-16 surrogates before values cross UTF-8 or hash boundaries. */
export function assertWellFormedUnicode(value: unknown, label: string): void {
  const active = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      if (Buffer.from(current, 'utf8').toString('utf8') !== current) {
        throw new TypeError(`${label} must contain well-formed Unicode`);
      }
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (active.has(current)) throw new TypeError(`${label} must be acyclic JSON`);
    active.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
    } else {
      for (const key of Object.keys(current)) {
        visit(key);
        visit((current as Record<string, unknown>)[key]);
      }
    }
    active.delete(current);
  };
  visit(value);
}
