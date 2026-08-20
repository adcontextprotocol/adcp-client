'use strict';

const BUILT_IN_VERSION_HINT =
  'The built-in test agent does not support the requested ADCP version; wait for a compatible server update or pass a compatible agent URL instead.';

function appendBuiltInVersionUnsupportedHint(result, agentArg, builtInAgents) {
  const headline = result?.summary?.headline;
  if (!builtInAgents?.[agentArg] || typeof headline !== 'string' || !headline.includes('VERSION_UNSUPPORTED')) {
    return result;
  }
  if (headline.includes(BUILT_IN_VERSION_HINT)) return result;
  return {
    ...result,
    summary: {
      ...result.summary,
      headline: `${headline}. ${BUILT_IN_VERSION_HINT}`,
    },
  };
}

module.exports = { BUILT_IN_VERSION_HINT, appendBuiltInVersionUnsupportedHint };
