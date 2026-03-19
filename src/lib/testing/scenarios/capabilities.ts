/**
 * Capability Discovery Testing Scenarios (v3)
 *
 * Tests agent capability discovery including:
 * - get_adcp_capabilities (v3 agents)
 * - Synthetic capability detection (v2 agents)
 * - Protocol/tool cross-validation
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { createTestClient, runStep, discoverAgentProfile } from '../client';
import {
  buildSyntheticCapabilities,
  parseCapabilitiesResponse,
  MEDIA_BUY_TOOLS,
  SIGNALS_TOOLS,
  GOVERNANCE_TOOLS,
  CREATIVE_TOOLS,
  SPONSORED_INTELLIGENCE_TOOLS,
  type AdcpCapabilities,
  type AdcpProtocol,
} from '../../utils/capabilities';
import type { GetAdCPCapabilitiesResponse } from '../../types/tools.generated';

/**
 * Test: Capability Discovery
 *
 * Flow:
 * 1. Discover agent profile (tools list)
 * 2. If get_adcp_capabilities exists, call it and validate response
 * 3. Cross-check reported protocols against available tools
 * 4. For v2 agents, build synthetic capabilities and note v3 upgrade path
 */
export async function testCapabilityDiscovery(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Discover agent profile
  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  const hasGetCapabilities = profile.tools.includes('get_adcp_capabilities');
  let capabilities: AdcpCapabilities;

  if (hasGetCapabilities) {
    // v3 agent: call get_adcp_capabilities
    const { result, step } = await runStep<TaskResult>(
      'Get AdCP capabilities (v3)',
      'get_adcp_capabilities',
      async () => client.getAdcpCapabilities({}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      capabilities = parseCapabilitiesResponse(result.data);
      profile.adcp_version = capabilities.version;
      profile.supported_protocols = capabilities.protocols;
      profile.supports_governance = capabilities.protocols.includes('governance');
      profile.supports_si = capabilities.protocols.includes('sponsored_intelligence');

      step.details = `v${capabilities.majorVersions.join('/')} agent with ${capabilities.protocols.length} protocol(s)`;
      step.response_preview = JSON.stringify(
        {
          version: capabilities.version,
          major_versions: capabilities.majorVersions,
          protocols: capabilities.protocols,
          features: capabilities.features,
          extensions: capabilities.extensions,
          publisher_domains: capabilities.publisherDomains?.slice(0, 3),
          channels: capabilities.channels,
        },
        null,
        2
      );
      steps.push(step);

      // Validate response structure
      const { steps: validationSteps } = validateCapabilitiesResponse(
        result.data as GetAdCPCapabilitiesResponse,
        profile.tools
      );
      steps.push(...validationSteps);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'get_adcp_capabilities failed';
      steps.push(step);

      // Fall back to synthetic capabilities
      const toolInfos = profile.tools.map(name => ({ name }));
      capabilities = buildSyntheticCapabilities(toolInfos);
      profile.adcp_version = 'v2';
      profile.supported_protocols = capabilities.protocols;

      steps.push({
        step: 'Fallback to synthetic capabilities',
        passed: true,
        duration_ms: 0,
        details: 'get_adcp_capabilities failed, using tool-based detection',
      });
    } else {
      // No result at all
      const toolInfos = profile.tools.map(name => ({ name }));
      capabilities = buildSyntheticCapabilities(toolInfos);
      profile.adcp_version = 'v2';
      profile.supported_protocols = capabilities.protocols;
      step.passed = false;
      step.error = 'get_adcp_capabilities returned no data';
      steps.push(step);
    }
  } else {
    // v2 agent: build synthetic capabilities
    const toolInfos = profile.tools.map(name => ({ name }));
    capabilities = buildSyntheticCapabilities(toolInfos);
    profile.adcp_version = 'v2';
    profile.supported_protocols = capabilities.protocols;
    profile.supports_governance = capabilities.protocols.includes('governance');
    profile.supports_si = capabilities.protocols.includes('sponsored_intelligence');

    steps.push({
      step: 'Build synthetic capabilities (v2)',
      task: undefined,
      passed: true,
      duration_ms: 0,
      details: `Agent does not support get_adcp_capabilities. Detected ${capabilities.protocols.length} protocol(s) from tools.`,
      response_preview: JSON.stringify(
        {
          version: capabilities.version,
          protocols: capabilities.protocols,
          features: capabilities.features,
          _synthetic: true,
        },
        null,
        2
      ),
    });

    // Check for v3 upgrade potential
    const v3ToolsPresent = [...GOVERNANCE_TOOLS, ...SPONSORED_INTELLIGENCE_TOOLS].filter(t =>
      profile.tools.includes(t)
    );

    if (v3ToolsPresent.length > 0) {
      steps.push({
        step: 'v3 upgrade potential detected',
        passed: true,
        duration_ms: 0,
        details: `Agent has ${v3ToolsPresent.length} v3 tool(s) but missing get_adcp_capabilities`,
        warnings: [
          `Consider implementing get_adcp_capabilities for better protocol discovery. v3 tools detected: ${v3ToolsPresent.join(', ')}`,
        ],
      });
    }
  }

  // Cross-validate: check that reported protocols match available tools
  const { steps: crossValidationSteps } = crossValidateProtocolsAndTools(capabilities, profile.tools);
  steps.push(...crossValidationSteps);

  return { steps, profile };
}

/**
 * Validate the structure and content of a get_adcp_capabilities response
 */
function validateCapabilitiesResponse(
  response: GetAdCPCapabilitiesResponse,
  tools: string[]
): { steps: TestStepResult[] } {
  const steps: TestStepResult[] = [];

  // Check for required fields
  const hasAdcp = response.adcp && Array.isArray(response.adcp.major_versions);
  const hasProtocols = Array.isArray(response.supported_protocols);

  steps.push({
    step: 'Validate capabilities structure',
    passed: hasAdcp && hasProtocols,
    duration_ms: 0,
    details:
      hasAdcp && hasProtocols
        ? 'Response has required fields (adcp.major_versions, supported_protocols)'
        : `Missing fields: ${!hasAdcp ? 'adcp.major_versions' : ''} ${!hasProtocols ? 'supported_protocols' : ''}`,
  });

  // Check for v3 version
  if (hasAdcp) {
    const majorVersions = response.adcp.major_versions;
    const hasV3 = majorVersions.includes(3);

    steps.push({
      step: 'Check v3 support',
      passed: true, // Not a failure if v2 only, just informational
      duration_ms: 0,
      details: hasV3
        ? `Agent supports v3 (versions: ${majorVersions.join(', ')})`
        : `Agent is v2 only (versions: ${majorVersions.join(', ')})`,
    });
  }

  // Check media_buy features if media_buy protocol is supported
  if (hasProtocols && response.supported_protocols.includes('media_buy')) {
    const mediaBuy = response.media_buy;
    const hasMediaBuyFeatures = mediaBuy?.features;

    steps.push({
      step: 'Validate media_buy features',
      passed: true, // Features are optional
      duration_ms: 0,
      details: hasMediaBuyFeatures
        ? `Features: inline_creative=${mediaBuy.features?.inline_creative_management}, property_list=${mediaBuy.features?.property_list_filtering}, content_standards=${mediaBuy.features?.content_standards}`
        : 'No media_buy.features declared (all features assumed false)',
    });
  }

  if (hasProtocols && response.supported_protocols.includes('creative')) {
    const creative = response.creative;
    const hasCreativeCapabilities = !!creative;
    const creativeWarnings: string[] = [];
    let creativePassed = hasCreativeCapabilities;

    if (creative?.supports_generation && !tools.includes('build_creative')) {
      creativePassed = false;
      creativeWarnings.push('creative.supports_generation=true but build_creative is not advertised');
    }

    if (creative?.supports_transformation && !tools.includes('build_creative')) {
      creativePassed = false;
      creativeWarnings.push('creative.supports_transformation=true but build_creative is not advertised');
    }

    if (creative?.has_creative_library && !tools.includes('list_creatives')) {
      creativePassed = false;
      creativeWarnings.push('creative.has_creative_library=true but list_creatives is not advertised');
    }

    if (creative?.has_creative_library && !tools.includes('list_accounts') && !tools.includes('sync_accounts')) {
      creativeWarnings.push(
        'creative.has_creative_library=true but no account management tool is advertised (expected sync_accounts or list_accounts)'
      );
    }

    steps.push({
      step: 'Validate creative capabilities',
      passed: creativePassed,
      duration_ms: 0,
      details: hasCreativeCapabilities
        ? `Creative: generation=${creative?.supports_generation ?? false}, transformation=${creative?.supports_transformation ?? false}, compliance=${creative?.supports_compliance ?? false}, library=${creative?.has_creative_library ?? false}`
        : 'creative is listed in supported_protocols but the creative capability block is missing',
      warnings: creativeWarnings.length > 0 ? creativeWarnings : undefined,
    });
  }

  if (response.account) {
    const accountWarnings: string[] = [];
    let accountPassed = true;

    if (response.account.require_operator_auth && !tools.includes('list_accounts')) {
      accountPassed = false;
      accountWarnings.push('account.require_operator_auth=true but list_accounts is not advertised');
    }

    if (
      response.account.required_for_products &&
      !tools.includes('list_accounts') &&
      !tools.includes('sync_accounts')
    ) {
      accountPassed = false;
      accountWarnings.push('account.required_for_products=true but no account management tool is advertised');
    }

    steps.push({
      step: 'Validate account capabilities',
      passed: accountPassed,
      duration_ms: 0,
      details: `Account model: require_operator_auth=${response.account.require_operator_auth ?? false}, required_for_products=${response.account.required_for_products ?? false}, sandbox=${response.account.sandbox ?? false}, supported_billing=${(response.account.supported_billing || []).join(', ') || '(none)'}`,
      warnings: accountWarnings.length > 0 ? accountWarnings : undefined,
    });
  }

  // Check extensions
  const extensions = response.extensions_supported ?? [];
  if (extensions.length > 0) {
    steps.push({
      step: 'Check extensions',
      passed: true,
      duration_ms: 0,
      details: `Supported extensions: ${extensions.join(', ')}`,
    });
  }

  return { steps };
}

/**
 * Cross-validate that reported protocols match available tools
 */
function crossValidateProtocolsAndTools(capabilities: AdcpCapabilities, tools: string[]): { steps: TestStepResult[] } {
  const steps: TestStepResult[] = [];
  const issues: string[] = [];
  const warnings: string[] = [];

  const protocolToolMap: Record<string, readonly string[]> = {
    media_buy: MEDIA_BUY_TOOLS,
    signals: SIGNALS_TOOLS,
    governance: GOVERNANCE_TOOLS,
    creative: CREATIVE_TOOLS,
    sponsored_intelligence: SPONSORED_INTELLIGENCE_TOOLS,
  };

  // Check each reported protocol has at least one corresponding tool
  const perProtocolDiffs: Record<string, { expected: string[]; found: string[]; missing: string[] }> = {};

  for (const protocol of capabilities.protocols) {
    const protocolTools = protocolToolMap[protocol] || [];
    const matchingTools = protocolTools.filter(t => tools.includes(t));
    const missingTools = protocolTools.filter(t => !tools.includes(t));

    if (matchingTools.length === 0 && protocolTools.length > 0) {
      issues.push(
        `Protocol '${protocol}' reported but no matching tools found. Expected one of: [${[...protocolTools].join(', ')}]`
      );
      perProtocolDiffs[protocol] = {
        expected: [...protocolTools],
        found: [],
        missing: [...protocolTools],
      };
    } else if (missingTools.length > 0) {
      // Partial coverage is a warning, not a failure — agents can legitimately
      // implement a subset of tools within a protocol.
      warnings.push(`Protocol '${protocol}' has partial tool coverage: missing [${missingTools.join(', ')}]`);
      perProtocolDiffs[protocol] = {
        expected: [...protocolTools],
        found: [...matchingTools],
        missing: missingTools,
      };
    }
  }

  // Check for tools that suggest protocols not reported.
  // Only consider tools exclusive to a protocol — shared tools (those appearing
  // in multiple protocol tool lists) don't indicate a specific unreported protocol.
  const allProtocolTools = Object.values(protocolToolMap).flat();
  const toolProtocolCount = new Map<string, number>();
  for (const tool of allProtocolTools) {
    toolProtocolCount.set(tool, (toolProtocolCount.get(tool) || 0) + 1);
  }

  const unreportedProtocols: string[] = [];

  for (const [protocol, expectedTools] of Object.entries(protocolToolMap)) {
    if (!capabilities.protocols.includes(protocol as AdcpProtocol)) {
      // Only flag based on exclusive tools (not shared across protocols)
      const exclusivePresent = expectedTools.filter(t => tools.includes(t) && toolProtocolCount.get(t) === 1);
      if (exclusivePresent.length > 0) {
        unreportedProtocols.push(protocol);
        perProtocolDiffs[protocol] = {
          expected: [],
          found: [...exclusivePresent],
          missing: [],
        };
      }
    }
  }

  if (unreportedProtocols.length > 0) {
    issues.push(
      `Tools suggest unreported protocols: ${unreportedProtocols.map(p => `${p} (has: [${perProtocolDiffs[p]!.found.join(', ')}])`).join('; ')}`
    );
  }

  const allMessages = [...issues, ...warnings];
  const hasDiffs = Object.keys(perProtocolDiffs).length > 0;

  steps.push({
    step: 'Cross-validate protocols and tools',
    passed: issues.length === 0,
    duration_ms: 0,
    error: issues.length > 0 ? issues.join('; ') : undefined,
    details: allMessages.length === 0 ? 'Reported protocols match available tools' : allMessages.join('; '),
    warnings: warnings.length > 0 ? warnings : undefined,
    response_preview: hasDiffs
      ? JSON.stringify(
          {
            reported_protocols: capabilities.protocols,
            per_protocol: perProtocolDiffs,
          },
          null,
          2
        )
      : undefined,
  });

  return { steps };
}

/**
 * Check if agent likely supports v3 capabilities
 */
export function likelySupportsV3(tools: string[]): boolean {
  return (
    tools.includes('get_adcp_capabilities') ||
    GOVERNANCE_TOOLS.some(t => tools.includes(t)) ||
    SPONSORED_INTELLIGENCE_TOOLS.some(t => tools.includes(t))
  );
}
