/** Bound JSON work before cloning caller-owned objects or serializing extensions. */
export function assertAccountChangeJsonSize(value: unknown, maxBytes: number): void {
  let remaining = maxBytes;
  const ancestors = new Set<object>();
  function charge(bytes: number) {
    remaining -= bytes;
    if (remaining < 0) throw new Error('JSON size limit exceeded');
  }
  function visit(item: unknown, depth: number): void {
    if (depth > 64) throw new Error('JSON nesting limit exceeded');
    if (typeof item === 'string') {
      if (item.length > remaining) throw new Error('JSON size limit exceeded');
      charge(Buffer.byteLength(JSON.stringify(item)));
    } else if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      charge(JSON.stringify(item).length);
    } else if (typeof item === 'object') {
      if (ancestors.has(item)) throw new Error('Cyclic JSON');
      ancestors.add(item);
      charge(2);
      let count = 0;
      if (Array.isArray(item)) {
        if (item.length > remaining) throw new Error('JSON size limit exceeded');
        if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length > 0) {
          throw new Error('Expected plain JSON array');
        }
        // structuredClone copies indexed properties, independent of iterator
        // overrides. Reject extra enumerable properties it would also copy.
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index >= item.length || String(index) !== key) {
            throw new Error('Unexpected JSON array property');
          }
        }
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !('value' in descriptor)) throw new Error('Expected JSON array data property');
          if (count++ > 0) charge(1);
          visit(descriptor.value, depth + 1);
        }
      } else {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw new Error('Expected JSON object');
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!('value' in descriptor)) throw new Error('Expected JSON data property');
          if (count++ > 0) charge(1);
          visit(key, depth + 1);
          charge(1);
          visit(descriptor.value, depth + 1);
        }
      }
      ancestors.delete(item);
    } else {
      throw new Error('Expected JSON value');
    }
  }
  visit(value, 0);
}
