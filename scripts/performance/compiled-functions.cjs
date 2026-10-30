/** Inspect the actual AJV function graph, including separately compiled refs. */
function maxCompiledFunctionBytes(validate) {
  const seen = new Set();
  let largest = 0;
  function visit(env) {
    if (!env || typeof env !== 'object' || seen.has(env)) return;
    seen.add(env);
    if (typeof env.validate === 'function') largest = Math.max(largest, Buffer.byteLength(env.validate.toString()));
    for (const ref of Object.values(env.refs ?? {})) visit(ref);
    visit(env.root);
  }
  visit(validate.schemaEnv);
  if (largest === 0) throw new Error('No compiled validator functions were measured');
  return largest;
}
module.exports = { maxCompiledFunctionBytes };
