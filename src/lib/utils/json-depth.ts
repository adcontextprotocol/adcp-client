export const MAX_JSON_DEPTH = 256;

/**
 * Whether a value nests objects or arrays deeper than `max`. Iterative, so a
 * hostile or corrupted value cannot overflow the stack before a bounded walk
 * (or `structuredClone`) rejects it. A node shared through several paths is
 * revisited whenever a deeper path reaches it, so a long chain cannot hide
 * behind shallow aliases; a cycle therefore counts as exceeding `max`.
 */
export function exceedsJsonDepth(value: unknown, max: number = MAX_JSON_DEPTH): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  const deepest = new Map<object, number>();
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    if (depth > max) return true;
    const previous = deepest.get(node);
    if (previous !== undefined && previous >= depth) continue;
    deepest.set(node, depth);
    for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}
