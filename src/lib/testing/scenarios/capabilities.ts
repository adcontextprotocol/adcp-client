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
} from '../../utils/capabilities';

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
      async () => client.executeTask('get_adcp_capabilities', {}) as Promise<TaskResult>
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
      const { steps: validationSteps } = validateCapabilitiesResponse(result.data, profile.tools);
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
function validateCapabilitiesResponse(response: any, tools: string[]): { steps: TestStepResult[] } {
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
    const majorVersions = response.adcp.major_versions as number[];
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
    const hasMediaBuyFeatures = response.media_buy?.features;

    steps.push({
      step: 'Validate media_buy features',
      passed: true, // Features are optional
      duration_ms: 0,
      details: hasMediaBuyFeatures
        ? `Features: inline_creative=${response.media_buy.features.inline_creative_management}, property_list=${response.media_buy.features.property_list_filtering}, content_standards=${response.media_buy.features.content_standards}`
        : 'No media_buy.features declared (all features assumed false)',
    });
  }

  // Check extensions
  const extensions = response.extensions_supported || [];
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

  // Check each reported protocol has at least one corresponding tool
  for (const protocol of capabilities.protocols) {
    let protocolTools: readonly string[];
    switch (protocol) {
      case 'media_buy':
        protocolTools = MEDIA_BUY_TOOLS;
        break;
      case 'signals':
        protocolTools = SIGNALS_TOOLS;
        break;
      case 'governance':
        protocolTools = GOVERNANCE_TOOLS;
        break;
      case 'creative':
        protocolTools = CREATIVE_TOOLS;
        break;
      case 'sponsored_intelligence':
        protocolTools = SPONSORED_INTELLIGENCE_TOOLS;
        break;
      default:
        protocolTools = [];
    }

    const matchingTools = protocolTools.filter(t => tools.includes(t));
    if (matchingTools.length === 0 && protocolTools.length > 0) {
      issues.push(`Protocol '${protocol}' reported but no matching tools found`);
    }
  }

  // Check for tools that suggest protocols not reported
  const unreportedProtocols: string[] = [];

  if (!capabilities.protocols.includes('media_buy') && MEDIA_BUY_TOOLS.some(t => tools.includes(t))) {
    unreportedProtocols.push('media_buy');
  }
  if (!capabilities.protocols.includes('signals') && SIGNALS_TOOLS.some(t => tools.includes(t))) {
    unreportedProtocols.push('signals');
  }
  if (!capabilities.protocols.includes('governance') && GOVERNANCE_TOOLS.some(t => tools.includes(t))) {
    unreportedProtocols.push('governance');
  }
  if (!capabilities.protocols.includes('creative') && CREATIVE_TOOLS.some(t => tools.includes(t))) {
    unreportedProtocols.push('creative');
  }
  if (
    !capabilities.protocols.includes('sponsored_intelligence') &&
    SPONSORED_INTELLIGENCE_TOOLS.some(t => tools.includes(t))
  ) {
    unreportedProtocols.push('sponsored_intelligence');
  }

  if (unreportedProtocols.length > 0) {
    issues.push(`Tools suggest unreported protocols: ${unreportedProtocols.join(', ')}`);
  }

  steps.push({
    step: 'Cross-validate protocols and tools',
    passed: issues.length === 0,
    duration_ms: 0,
    details: issues.length === 0 ? 'Reported protocols match available tools' : issues.join('; '),
    warnings: issues.length > 0 ? issues : undefined,
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
