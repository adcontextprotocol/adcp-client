/**
 * Governance Protocol Testing Scenarios (v3)
 *
 * Tests governance agent capabilities including:
 * - Property list CRUD operations
 * - Content standards management
 * - Content calibration
 * - Delivery validation
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { createTestClient, runStep, discoverAgentProfile } from '../client';
import { GOVERNANCE_TOOLS } from '../../utils/capabilities';

// Property list tools
const PROPERTY_LIST_TOOLS = [
  'create_property_list',
  'get_property_list',
  'update_property_list',
  'list_property_lists',
  'delete_property_list',
] as const;

// Content standards tools
const CONTENT_STANDARDS_TOOLS = [
  'list_content_standards',
  'get_content_standards',
  'create_content_standards',
  'update_content_standards',
  'calibrate_content',
  'validate_content_delivery',
] as const;

/**
 * Test: Governance Property Lists
 *
 * Flow: create_property_list -> get_property_list -> update_property_list
 *       -> list_property_lists -> delete_property_list -> verify deletion
 */
export async function testGovernancePropertyLists(
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

  // Check if agent supports any property list tools
  const hasPropertyListTools = PROPERTY_LIST_TOOLS.some(t => profile.tools.includes(t));
  if (!hasPropertyListTools) {
    steps.push({
      step: 'Property list support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support property list tools (governance protocol)',
      details: `Required tools: ${PROPERTY_LIST_TOOLS.join(', ')}. Available: ${profile.tools.join(', ')}`,
    });
    return { steps, profile };
  }

  profile.supports_governance = true;
  let createdListId: string | undefined;
  let authToken: string | undefined;

  // Test: create_property_list
  if (profile.tools.includes('create_property_list')) {
    const listName = options.property_list_name || `E2E Test List ${Date.now()}`;
    const { result, step } = await runStep<TaskResult>(
      'Create property list',
      'create_property_list',
      async () =>
        client.executeTask('create_property_list', {
          name: listName,
          description: 'E2E test property list for governance testing',
          base_properties: {
            include: [
              { identifier_type: 'domain', identifier_value: 'example.com' },
              { identifier_type: 'domain', identifier_value: 'test.example.com' },
            ],
          },
          filters: {
            garm_categories: {
              exclude: ['adult', 'arms'],
            },
            mfa_thresholds: {
              min_score: 0.7,
            },
          },
          brand_manifest: options.brand_manifest || {
            name: 'E2E Test Brand',
            url: 'https://test.example.com',
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      createdListId = data.list?.list_id || data.list_id;
      authToken = data.auth_token;
      step.created_id = createdListId;
      step.details = `Created list: ${createdListId}`;
      step.response_preview = JSON.stringify(
        {
          list_id: createdListId,
          name: data.list?.name || listName,
          has_auth_token: !!authToken,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'create_property_list failed';
    }
    steps.push(step);
  }

  // Test: get_property_list
  if (profile.tools.includes('get_property_list') && createdListId) {
    const { result, step } = await runStep<TaskResult>(
      'Get property list',
      'get_property_list',
      async () =>
        client.executeTask('get_property_list', {
          list_id: createdListId,
          resolve: true,
          max_results: 10,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Retrieved list with ${data.total_count || 0} properties`;
      step.response_preview = JSON.stringify(
        {
          list_id: data.list?.list_id,
          name: data.list?.name,
          property_count: data.total_count,
          has_identifiers: !!data.identifiers?.length,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'get_property_list failed';
    }
    steps.push(step);
  }

  // Test: update_property_list
  if (profile.tools.includes('update_property_list') && createdListId) {
    const { result, step } = await runStep<TaskResult>(
      'Update property list',
      'update_property_list',
      async () =>
        client.executeTask('update_property_list', {
          list_id: createdListId,
          auth_token: authToken,
          description: 'Updated E2E test property list',
          base_properties: {
            include: [
              { identifier_type: 'domain', identifier_value: 'example.com' },
              { identifier_type: 'domain', identifier_value: 'test.example.com' },
              { identifier_type: 'domain', identifier_value: 'new.example.com' },
            ],
          },
          filters: {
            garm_categories: {
              exclude: ['adult', 'arms', 'gambling'],
            },
            mfa_thresholds: {
              min_score: 0.8,
            },
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = 'Property list updated successfully';
      step.response_preview = JSON.stringify(
        {
          list_id: data.list?.list_id,
          updated_at: data.list?.updated_at,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'update_property_list failed';
    }
    steps.push(step);
  }

  // Test: list_property_lists
  if (profile.tools.includes('list_property_lists')) {
    const { result, step } = await runStep<TaskResult>(
      'List property lists',
      'list_property_lists',
      async () =>
        client.executeTask('list_property_lists', {
          max_results: 10,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const lists = data.lists || [];
      step.details = `Found ${lists.length} property list(s)`;
      step.response_preview = JSON.stringify(
        {
          total_count: data.total_count,
          returned_count: data.returned_count || lists.length,
          lists: lists.slice(0, 3).map((l: any) => ({
            list_id: l.list_id,
            name: l.name,
          })),
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_property_lists failed';
    }
    steps.push(step);
  }

  // Test: delete_property_list
  if (profile.tools.includes('delete_property_list') && createdListId && options.dry_run === false) {
    const { result, step } = await runStep<TaskResult>(
      'Delete property list',
      'delete_property_list',
      async () =>
        client.executeTask('delete_property_list', {
          list_id: createdListId,
          auth_token: authToken,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = data.deleted ? 'Property list deleted' : 'Deletion returned but not confirmed';
      step.response_preview = JSON.stringify(
        {
          deleted: data.deleted,
          list_id: data.list_id,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'delete_property_list failed';
    }
    steps.push(step);

    // Test: get deleted list (should fail)
    if (profile.tools.includes('get_property_list')) {
      const { result: errorResult, step: errorStep } = await runStep<TaskResult>(
        'Get deleted list (error expected)',
        'get_property_list',
        async () =>
          client.executeTask('get_property_list', {
            list_id: createdListId,
          }) as Promise<TaskResult>
      );

      if (errorResult?.success) {
        errorStep.passed = false;
        errorStep.error = 'Expected error for deleted list but got success';
      } else {
        errorStep.passed = true;
        errorStep.details = 'Correctly rejected deleted list access';
      }
      steps.push(errorStep);
    }
  } else if (profile.tools.includes('delete_property_list') && createdListId) {
    steps.push({
      step: 'Delete property list',
      task: 'delete_property_list',
      passed: true,
      duration_ms: 0,
      details: 'Skipped in dry-run mode',
    });
  }

  return { steps, profile };
}

/**
 * Test: Governance Content Standards
 *
 * Flow: list_content_standards -> get_content_standards -> calibrate_content
 *       -> validate_content_delivery
 */
export async function testGovernanceContentStandards(
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

  // Check if agent supports any content standards tools
  const hasContentStandardsTools = CONTENT_STANDARDS_TOOLS.some(t => profile.tools.includes(t));
  if (!hasContentStandardsTools) {
    steps.push({
      step: 'Content standards support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support content standards tools (governance protocol)',
      details: `Required tools: ${CONTENT_STANDARDS_TOOLS.join(', ')}. Available: ${profile.tools.join(', ')}`,
    });
    return { steps, profile };
  }

  profile.supports_governance = true;
  let discoveredStandardsId: string | undefined;

  // Test: list_content_standards
  if (profile.tools.includes('list_content_standards')) {
    const { result, step } = await runStep<TaskResult>(
      'List content standards',
      'list_content_standards',
      async () =>
        client.executeTask('list_content_standards', {
          context: 'E2E testing - list available brand safety configurations',
          max_results: 10,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const standards = data.standards || [];
      if (standards.length > 0) {
        discoveredStandardsId = standards[0].standards_id;
      }
      step.details = `Found ${standards.length} content standard(s)`;
      step.response_preview = JSON.stringify(
        {
          standards_count: standards.length,
          sample_standards: standards.slice(0, 3).map((s: any) => ({
            standards_id: s.standards_id,
            name: s.name,
            provider: s.provider,
          })),
        },
        null,
        2
      );
    } else if (result && !result.success) {
      // Not all agents support content standards, so treat missing support as passing
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'Content standards not supported by this agent (expected for some agents)';
      } else {
        step.passed = false;
        step.error = result.error || 'list_content_standards failed';
      }
    }
    steps.push(step);
  }

  // Test: get_content_standards (if we found one)
  const standardsIdToTest = options.content_standards_id || discoveredStandardsId;
  if (profile.tools.includes('get_content_standards') && standardsIdToTest) {
    const { result, step } = await runStep<TaskResult>(
      'Get content standards',
      'get_content_standards',
      async () =>
        client.executeTask('get_content_standards', {
          standards_id: standardsIdToTest,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Retrieved standards: ${data.standards?.name || standardsIdToTest}`;
      step.response_preview = JSON.stringify(
        {
          standards_id: data.standards?.standards_id,
          name: data.standards?.name,
          features_count: data.standards?.features?.length || 0,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'get_content_standards failed';
    }
    steps.push(step);
  }

  // Test: calibrate_content
  if (profile.tools.includes('calibrate_content')) {
    const { result, step } = await runStep<TaskResult>(
      'Calibrate content',
      'calibrate_content',
      async () =>
        client.executeTask('calibrate_content', {
          context: 'E2E testing - evaluate sample content for brand safety',
          standards_id: standardsIdToTest,
          artifacts: [
            {
              artifact_id: 'test-artifact-1',
              artifact_type: 'webpage',
              url: 'https://example.com/article/safe-content',
              title: 'Safe Test Article',
            },
            {
              artifact_id: 'test-artifact-2',
              artifact_type: 'webpage',
              url: 'https://example.com/article/test-content',
              title: 'Another Test Article',
            },
          ],
          feedback_type: 'binary',
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Calibration session: ${data.session_status || 'completed'}`;
      step.response_preview = JSON.stringify(
        {
          session_id: data.session_id,
          session_status: data.session_status,
          pending_artifacts: data.pending_artifacts?.length || 0,
          evaluated_artifacts: data.evaluated_artifacts?.length || 0,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'Content calibration not supported by this agent';
      } else {
        step.passed = false;
        step.error = result.error || 'calibrate_content failed';
      }
    }
    steps.push(step);
  }

  // Test: validate_content_delivery
  if (profile.tools.includes('validate_content_delivery')) {
    const { result, step } = await runStep<TaskResult>(
      'Validate content delivery',
      'validate_content_delivery',
      async () =>
        client.executeTask('validate_content_delivery', {
          context: 'E2E testing - validate delivery records against content standards',
          standards_id: standardsIdToTest,
          records: [
            {
              record_id: 'test-record-1',
              artifact: {
                artifact_id: 'test-artifact-1',
                artifact_type: 'webpage',
                url: 'https://example.com/article/delivered-content',
              },
              delivered_at: new Date().toISOString(),
            },
          ],
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Validated ${data.summary?.total_records || 0} record(s)`;
      step.response_preview = JSON.stringify(
        {
          total_records: data.summary?.total_records,
          passed_records: data.summary?.passed_records,
          failed_records: data.summary?.failed_records,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'Content delivery validation not supported by this agent';
      } else {
        step.passed = false;
        step.error = result.error || 'validate_content_delivery failed';
      }
    }
    steps.push(step);
  }

  // Test: get_content_standards with invalid ID (error expected)
  if (profile.tools.includes('get_content_standards')) {
    const { result: errorResult, step: errorStep } = await runStep<TaskResult>(
      'Get invalid content standards (error expected)',
      'get_content_standards',
      async () =>
        client.executeTask('get_content_standards', {
          standards_id: 'INVALID_STANDARDS_ID_DOES_NOT_EXIST_12345',
        }) as Promise<TaskResult>
    );

    if (errorResult?.success) {
      errorStep.passed = false;
      errorStep.error = 'Expected error for invalid standards_id but got success';
    } else {
      errorStep.passed = true;
      errorStep.details = 'Correctly rejected invalid standards_id';
    }
    steps.push(errorStep);
  }

  return { steps, profile };
}

/**
 * Test: Property List Filters
 *
 * Creates a property list with all filter types populated, retrieves it with
 * resolve:true, and validates the filters round-trip correctly.
 *
 * Filter types tested:
 * - garm_categories (exclude)
 * - mfa_thresholds (min_score)
 * - custom_tags (include/exclude)
 * - feature_requirements (conditional on get_adcp_capabilities)
 */
export async function testPropertyListFilters(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  const hasRequired = profile.tools.includes('create_property_list') && profile.tools.includes('get_property_list');
  if (!hasRequired) {
    steps.push({
      step: 'Property list filter support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent requires create_property_list + get_property_list for filter testing',
    });
    return { steps, profile };
  }

  profile.supports_governance = true;

  // Optionally discover feature IDs from get_adcp_capabilities
  let featureRequirements: unknown[] | undefined;
  if (profile.tools.includes('get_adcp_capabilities')) {
    const { result: capResult, step: capStep } = await runStep<TaskResult>(
      'Discover available features (for feature_requirements filter)',
      'get_adcp_capabilities',
      async () => client.executeTask('get_adcp_capabilities', {}) as Promise<TaskResult>
    );
    if (capResult?.success && capResult?.data) {
      const rawFeatures = (capResult.data as any)?.media_buy?.features;
      if (rawFeatures && typeof rawFeatures === 'object') {
        // Use boolean feature keys as feature_ids (agents that support dynamic features will have IDs)
        const featureIds = Object.keys(rawFeatures).filter(k => rawFeatures[k] === true);
        if (featureIds.length > 0) {
          featureRequirements = featureIds.map(id => ({
            feature_id: id,
            allowed_values: [true],
            if_not_covered: 'exclude',
          }));
          capStep.details = `Found ${featureIds.length} feature(s) for filter testing: ${featureIds.join(', ')}`;
        } else {
          capStep.details = 'No active features found; skipping feature_requirements filter';
        }
      } else {
        capStep.details = 'get_adcp_capabilities returned no feature data; skipping feature_requirements filter';
      }
    }
    steps.push(capStep);
  }

  // Build filter object with all supported types
  const filters: Record<string, unknown> = {
    garm_categories: {
      exclude: ['adult', 'arms', 'gambling', 'hate_speech'],
    },
    mfa_thresholds: {
      min_score: 0.75,
    },
    custom_tags: {
      include: [{ key: 'content_type', value: 'premium' }],
      exclude: [{ key: 'content_type', value: 'user_generated' }],
    },
  };

  if (featureRequirements) {
    filters.feature_requirements = featureRequirements;
  }

  let createdListId: string | undefined;
  let authToken: string | undefined;

  // Create property list with all filters
  const listName = `E2E Filter Test ${Date.now()}`;
  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create property list with all filter types',
    'create_property_list',
    async () =>
      client.executeTask('create_property_list', {
        name: listName,
        description: 'E2E filter round-trip test',
        base_properties: {
          include: [{ identifier_type: 'domain', identifier_value: 'example.com' }],
        },
        filters,
        brand_manifest: options.brand_manifest || {
          name: 'E2E Test Brand',
          url: 'https://test.example.com',
        },
      }) as Promise<TaskResult>
  );

  if (createResult?.success && createResult?.data) {
    const data = createResult.data as any;
    createdListId = data.list?.list_id || data.list_id;
    authToken = data.auth_token;
    createStep.created_id = createdListId;
    createStep.details = `Created list: ${createdListId} with ${Object.keys(filters).length} filter type(s)`;
  } else if (createResult && !createResult.success) {
    createStep.passed = false;
    createStep.error = createResult.error || 'create_property_list failed';
  }
  steps.push(createStep);

  if (!createdListId) {
    return { steps, profile };
  }

  // Retrieve with resolve:true and validate filter round-trip
  const { result: getResult, step: getStep } = await runStep<TaskResult>(
    'Get property list (resolve: true, validate filter round-trip)',
    'get_property_list',
    async () =>
      client.executeTask('get_property_list', {
        list_id: createdListId,
        resolve: true,
        max_results: 5,
      }) as Promise<TaskResult>
  );

  if (getResult?.success && getResult?.data) {
    const data = getResult.data as any;
    const returnedFilters = data.list?.filters;
    const issues: string[] = [];

    if (returnedFilters) {
      if (!returnedFilters.garm_categories?.exclude?.length) {
        issues.push('garm_categories.exclude not preserved');
      }
      if (returnedFilters.mfa_thresholds?.min_score !== 0.75) {
        issues.push(
          `mfa_thresholds.min_score mismatch: got ${returnedFilters.mfa_thresholds?.min_score}, expected 0.75`
        );
      }
      if (!returnedFilters.custom_tags) {
        issues.push('custom_tags filter not preserved');
      }
      if (featureRequirements && !returnedFilters.feature_requirements?.length) {
        issues.push('feature_requirements filter not preserved');
      }
    } else {
      issues.push('filters object missing from get_property_list response');
    }

    getStep.passed = issues.length === 0;
    getStep.details =
      issues.length === 0
        ? `All ${Object.keys(filters).length} filter types round-tripped correctly`
        : `Filter round-trip issues: ${issues.join('; ')}`;
    getStep.error = issues.length > 0 ? issues.join('; ') : undefined;
    getStep.response_preview = JSON.stringify(
      {
        list_id: data.list?.list_id,
        filters_returned: returnedFilters ? Object.keys(returnedFilters) : [],
        round_trip_issues: issues,
      },
      null,
      2
    );
  } else if (getResult && !getResult.success) {
    getStep.passed = false;
    getStep.error = getResult.error || 'get_property_list failed';
  }
  steps.push(getStep);

  // Cleanup: delete if not dry-run
  if (options.dry_run === false && profile.tools.includes('delete_property_list')) {
    const { result: delResult, step: delStep } = await runStep<TaskResult>(
      'Delete test property list (cleanup)',
      'delete_property_list',
      async () =>
        client.executeTask('delete_property_list', {
          list_id: createdListId,
          auth_token: authToken,
        }) as Promise<TaskResult>
    );
    if (delResult?.success) {
      delStep.details = 'Test list cleaned up';
    }
    steps.push(delStep);
  } else if (!profile.tools.includes('delete_property_list')) {
    steps.push({
      step: 'Delete test property list (cleanup)',
      passed: true,
      duration_ms: 0,
      details: `Skipped — agent does not advertise delete_property_list. Test list ${createdListId} may remain.`,
      warnings: [
        `Test list ${createdListId} was created but cannot be cleaned up (delete_property_list not available)`,
      ],
    });
  }

  return { steps, profile };
}

/**
 * Check if agent has any governance protocol tools
 */
export function hasGovernanceTools(tools: string[]): boolean {
  return GOVERNANCE_TOOLS.some(t => tools.includes(t));
}
