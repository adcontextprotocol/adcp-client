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
import { getOrCreateClient, runStep, getOrDiscoverProfile } from '../client';
import { GOVERNANCE_TOOLS } from '../../utils/capabilities';
import { GovernanceAgentStub } from '../stubs';
import { callMCPTool } from '../../protocols/mcp';
import type {
  CreatePropertyListRequest,
  CreatePropertyListResponse,
  GetPropertyListRequest,
  GetPropertyListResponse,
  UpdatePropertyListRequest,
  UpdatePropertyListResponse,
  ListPropertyListsRequest,
  ListPropertyListsResponse,
  DeletePropertyListRequest,
  DeletePropertyListResponse,
  ListContentStandardsRequest,
  ListContentStandardsResponse,
  GetContentStandardsRequest,
  CalibrateContentRequest,
  ValidateContentDeliveryRequest,
  ContentStandards,
  PropertyList,
} from '../../types/tools.generated';
import { setAtPath } from '../../core/GovernanceMiddleware';

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
  const client = getOrCreateClient(agentUrl, options);

  // Discover agent profile
  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
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
        client.createPropertyList({
          name: listName,
          description: 'E2E test property list for governance testing',
          base_properties: {
            include: [
              { identifier_type: 'domain', identifier_value: 'example.com' },
              { identifier_type: 'domain', identifier_value: 'test.example' },
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
            url: 'https://test.example',
          },
        } as unknown as CreatePropertyListRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as CreatePropertyListResponse;
      createdListId = data.list?.list_id;
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
        client.getPropertyList({
          list_id: createdListId,
          resolve: true,
          max_results: 10,
        } as unknown as GetPropertyListRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as GetPropertyListResponse;
      const dataRecord = result.data as unknown as Record<string, unknown>;
      step.details = `Retrieved list with ${dataRecord.total_count || 0} properties`;
      step.response_preview = JSON.stringify(
        {
          list_id: data.list?.list_id,
          name: data.list?.name,
          property_count: dataRecord.total_count,
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
        client.updatePropertyList({
          list_id: createdListId,
          auth_token: authToken,
          description: 'Updated E2E test property list',
          base_properties: {
            include: [
              { identifier_type: 'domain', identifier_value: 'example.com' },
              { identifier_type: 'domain', identifier_value: 'test.example' },
              { identifier_type: 'domain', identifier_value: 'new.example' },
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
        } as unknown as UpdatePropertyListRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as UpdatePropertyListResponse;
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
        client.listPropertyLists({
          max_results: 10,
        } as unknown as ListPropertyListsRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as ListPropertyListsResponse;
      const dataRecord = result.data as unknown as Record<string, unknown>;
      const lists: PropertyList[] = data.lists || [];
      step.details = `Found ${lists.length} property list(s)`;
      step.response_preview = JSON.stringify(
        {
          total_count: dataRecord.total_count,
          returned_count: dataRecord.returned_count || lists.length,
          lists: lists.slice(0, 3).map((l: PropertyList) => ({
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
  if (profile.tools.includes('delete_property_list') && createdListId) {
    const { result, step } = await runStep<TaskResult>(
      'Delete property list',
      'delete_property_list',
      async () =>
        client.deletePropertyList({
          list_id: createdListId,
          auth_token: authToken,
        } as unknown as DeletePropertyListRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as DeletePropertyListResponse;
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
          client.getPropertyList({
            list_id: createdListId,
          } as unknown as GetPropertyListRequest) as Promise<TaskResult>
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
  const client = getOrCreateClient(agentUrl, options);

  // Discover agent profile
  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
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
        client.listContentStandards({
          context: 'E2E testing - list available brand safety configurations',
          max_results: 10,
        } as unknown as ListContentStandardsRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as ListContentStandardsResponse;
      const standards: ContentStandards[] = 'standards' in data ? data.standards : [];
      if (standards.length > 0) {
        discoveredStandardsId = standards[0]!.standards_id;
      }
      step.details = `Found ${standards.length} content standard(s)`;
      step.response_preview = JSON.stringify(
        {
          standards_count: standards.length,
          sample_standards: standards.slice(0, 3).map((s: ContentStandards) => ({
            standards_id: s.standards_id,
            name: s.name,
            provider: (s as unknown as Record<string, unknown>).provider,
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
        client.getContentStandards({
          standards_id: standardsIdToTest,
        } as unknown as GetContentStandardsRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as unknown as Record<string, unknown>;
      // Response may be a ContentStandards directly or wrapped in { standards: ... }
      const standards = (data.standards as unknown as Record<string, unknown> | undefined) || data;
      step.details = `Retrieved standards: ${String(standards.name || standardsIdToTest)}`;
      step.response_preview = JSON.stringify(
        {
          standards_id: standards.standards_id,
          name: standards.name,
          features_count: Array.isArray(standards.features) ? standards.features.length : 0,
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
        client.calibrateContent({
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
        } as unknown as CalibrateContentRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as unknown as Record<string, unknown>;
      step.details = `Calibration session: ${String(data.session_status || 'completed')}`;
      step.response_preview = JSON.stringify(
        {
          session_id: data.session_id,
          session_status: data.session_status,
          pending_artifacts: Array.isArray(data.pending_artifacts) ? data.pending_artifacts.length : 0,
          evaluated_artifacts: Array.isArray(data.evaluated_artifacts) ? data.evaluated_artifacts.length : 0,
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
        client.validateContentDelivery({
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
        } as unknown as ValidateContentDeliveryRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as unknown as Record<string, unknown>;
      const summary = data.summary as unknown as Record<string, unknown> | undefined;
      step.details = `Validated ${summary?.total_records || 0} record(s)`;
      step.response_preview = JSON.stringify(
        {
          total_records: summary?.total_records,
          passed_records: summary?.passed_records,
          failed_records: summary?.failed_records,
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
        client.getContentStandards({
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
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
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
      async () => client.getAdcpCapabilities({}) as Promise<TaskResult>
    );
    if (capResult?.success && capResult?.data) {
      const capData = capResult.data as unknown as Record<string, unknown>;
      const mediaBuy = capData.media_buy as unknown as Record<string, unknown> | undefined;
      const rawFeatures = mediaBuy?.features;
      if (rawFeatures && typeof rawFeatures === 'object') {
        // Use boolean feature keys as feature_ids (agents that support dynamic features will have IDs)
        const featuresRecord = rawFeatures as Record<string, unknown>;
        const featureIds = Object.keys(featuresRecord).filter(k => featuresRecord[k] === true);
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
      client.createPropertyList({
        name: listName,
        description: 'E2E filter round-trip test',
        base_properties: {
          include: [{ identifier_type: 'domain', identifier_value: 'example.com' }],
        },
        filters,
        brand_manifest: options.brand_manifest || {
          name: 'E2E Test Brand',
          url: 'https://test.example',
        },
      } as unknown as CreatePropertyListRequest) as Promise<TaskResult>
  );

  if (createResult?.success && createResult?.data) {
    const data = createResult.data as CreatePropertyListResponse;
    createdListId = data.list?.list_id;
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
      client.getPropertyList({
        list_id: createdListId,
        resolve: true,
        max_results: 5,
      } as unknown as GetPropertyListRequest) as Promise<TaskResult>
  );

  if (getResult?.success && getResult?.data) {
    const data = getResult.data as GetPropertyListResponse;
    const returnedFilters = data.list?.filters as unknown as Record<string, unknown> | undefined;
    const issues: string[] = [];

    if (returnedFilters) {
      const garmCategories = returnedFilters.garm_categories as unknown as Record<string, unknown> | undefined;
      if (!Array.isArray(garmCategories?.exclude) || !garmCategories.exclude.length) {
        issues.push('garm_categories.exclude not preserved');
      }
      const mfaThresholds = returnedFilters.mfa_thresholds as unknown as Record<string, unknown> | undefined;
      if (mfaThresholds?.min_score !== 0.75) {
        issues.push(`mfa_thresholds.min_score mismatch: got ${mfaThresholds?.min_score}, expected 0.75`);
      }
      if (!returnedFilters.custom_tags) {
        issues.push('custom_tags filter not preserved');
      }
      const featureReqs = returnedFilters.feature_requirements;
      if (featureRequirements && !(Array.isArray(featureReqs) && featureReqs.length)) {
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

  // Cleanup
  if (profile.tools.includes('delete_property_list')) {
    const { result: delResult, step: delStep } = await runStep<TaskResult>(
      'Delete test property list (cleanup)',
      'delete_property_list',
      async () =>
        client.deletePropertyList({
          list_id: createdListId,
          auth_token: authToken,
        } as unknown as DeletePropertyListRequest) as Promise<TaskResult>
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

// Campaign governance tools
const CAMPAIGN_GOVERNANCE_TOOLS = [
  'sync_plans',
  'check_governance',
  'report_plan_outcome',
  'get_plan_audit_logs',
] as const;

/**
 * Test: Campaign Governance - Full Lifecycle
 *
 * Flow: sync_plans -> check_governance(proposed, approved) -> create_media_buy
 *       -> report_plan_outcome(completed)
 *
 * Tests the happy path: buyer syncs a plan, gets approval, executes,
 * and reports the outcome back to the governance agent.
 */
export async function testCampaignGovernance(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  // Discover agent profile
  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Check if agent supports campaign governance tools
  const hasCampaignGovernance = CAMPAIGN_GOVERNANCE_TOOLS.some(t => profile.tools.includes(t));
  if (!hasCampaignGovernance) {
    steps.push({
      step: 'Campaign governance support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support campaign governance tools',
      details: `Required: at least one of ${CAMPAIGN_GOVERNANCE_TOOLS.join(', ')}. Available: ${profile.tools.join(', ')}`,
    });
    return { steps, profile };
  }

  profile.supports_governance = true;

  const testPlanId = `test-plan-${Date.now()}`;
  const testMediaBuyId = `test-mb-${Date.now()}`;
  const callerUrl = 'https://test-orchestrator.example';
  const flightStart = new Date();
  const flightEnd = new Date(flightStart.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  // Step 1: sync_plans
  if (profile.tools.includes('sync_plans')) {
    const { result, step } = await runStep<TaskResult>(
      'Sync campaign governance plan',
      'sync_plans',
      async () =>
        client.executeTask('sync_plans', {
          plans: [
            {
              plan_id: testPlanId,
              brand: options.brand || { domain: 'test.example' },
              objectives: 'E2E test campaign for governance protocol validation',
              budget: {
                total: options.budget || 10000,
                currency: 'USD',
                authority_level: 'agent_full',
              },
              flight: {
                start: flightStart.toISOString(),
                end: flightEnd.toISOString(),
              },
              countries: ['US'],
              channels: {
                allowed: ['display', 'video'],
              },
              delegations: [
                {
                  agent_url: callerUrl,
                  authority: 'full',
                },
              ],
            },
          ],
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data;
      const plans = data.plans || [];
      const synced = plans.find((p: any) => p.plan_id === testPlanId);
      if (synced?.status === 'active') {
        step.details = `Plan synced: ${testPlanId}, version ${synced.version}, ${(synced.categories || []).length} categories active`;
        step.response_preview = JSON.stringify(
          {
            plan_id: synced.plan_id,
            status: synced.status,
            version: synced.version,
            categories: synced.categories?.map((c: any) => c.category_id),
            resolved_policies: synced.resolved_policies?.length || 0,
          },
          null,
          2
        );
      } else {
        step.passed = false;
        step.error = synced
          ? `Plan sync returned status '${synced.status}' instead of 'active'`
          : 'Plan not found in sync response';
      }
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'sync_plans failed';
    }
    steps.push(step);
  }

  // Step 2: check_governance (proposed, expecting approved)
  let checkId: string | undefined;
  let governanceContext: string | undefined;
  if (profile.tools.includes('check_governance')) {
    const { result, step } = await runStep<TaskResult>(
      'Check governance (proposed buy)',
      'check_governance',
      async () =>
        client.executeTask('check_governance', {
          plan_id: testPlanId,
          binding: 'proposed',
          caller: callerUrl,
          tool: 'create_media_buy',
          payload: {
            channel: 'display',
            budget: { total: 1000, currency: 'USD' },
            flight: {
              start: flightStart.toISOString(),
              end: flightEnd.toISOString(),
            },
            countries: ['US'],
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data;
      checkId = data.check_id;
      governanceContext = data.governance_context;
      const status = data.status;

      step.details = `Governance check: status=${status}, binding=${data.binding}, mode=${data.mode || 'unknown'}`;
      step.response_preview = JSON.stringify(
        {
          check_id: data.check_id,
          status: data.status,
          binding: data.binding,
          mode: data.mode,
          explanation: data.explanation,
          findings_count: data.findings?.length || 0,
          expires_at: data.expires_at,
          governance_context: data.governance_context ? '(present)' : '(absent)',
        },
        null,
        2
      );
      step.observation_data = { governance_context: data.governance_context || null };

      // Any status is valid — we're testing the protocol, not the policy
      if (!['approved', 'denied', 'conditions', 'escalated'].includes(status)) {
        step.passed = false;
        step.error = `Unexpected governance status: ${status}`;
      }

      // Validate governance_context format if present
      if (governanceContext !== undefined) {
        if (typeof governanceContext !== 'string') {
          step.warnings = [...(step.warnings || []), 'governance_context is not a string'];
        } else if (governanceContext.length > 4096) {
          step.warnings = [
            ...(step.warnings || []),
            `governance_context exceeds 4096 chars (${governanceContext.length})`,
          ];
        }
      }
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'check_governance failed';
    }
    steps.push(step);
  }

  // Step 3: report_plan_outcome (completed) — thread governance_context
  if (profile.tools.includes('report_plan_outcome') && checkId) {
    const outcomeRequest: Record<string, unknown> = {
      plan_id: testPlanId,
      check_id: checkId,
      outcome: 'completed',
      governance_context: governanceContext || '',
      seller_response: {
        media_buy_id: testMediaBuyId,
        packages: [
          {
            budget: 1000,
          },
        ],
      },
    };

    const { result, step } = await runStep<TaskResult>(
      'Report plan outcome (completed)',
      'report_plan_outcome',
      async () => client.executeTask('report_plan_outcome', outcomeRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      step.details = `Outcome reported with governance_context=${governanceContext ? 'present' : 'absent'}`;
      step.response_preview = JSON.stringify(result.data, null, 2);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'report_plan_outcome failed';
    }
    steps.push(step);
  }

  // Step 4: get_plan_audit_logs — query by media_buy_id
  if (profile.tools.includes('get_plan_audit_logs')) {
    const { result, step } = await runStep<TaskResult>(
      'Get plan audit logs',
      'get_plan_audit_logs',
      async () =>
        client.executeTask('get_plan_audit_logs', {
          plan_ids: [testPlanId],
          media_buy_id: testMediaBuyId,
          include_entries: true,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data;
      step.details = 'Audit logs retrieved';
      step.response_preview = JSON.stringify(
        {
          plans_returned: data.plans?.length || 0,
          has_entries: !!data.plans?.[0]?.entries?.length,
          budget: data.plans?.[0]?.budget,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'get_plan_audit_logs failed';
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Test: Campaign Governance - Denied Flow
 *
 * Sends a check_governance request that should be denied (budget exceeds plan,
 * unauthorized market). Validates that the governance agent returns meaningful
 * findings and explanations.
 */
export async function testCampaignGovernanceDenied(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  if (!profile.tools.includes('sync_plans') || !profile.tools.includes('check_governance')) {
    steps.push({
      step: 'Campaign governance denied flow support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent requires sync_plans + check_governance for denied flow testing',
    });
    return { steps, profile };
  }

  profile.supports_governance = true;

  const testPlanId = `test-denied-plan-${Date.now()}`;
  const callerUrl = 'https://test-orchestrator.example';
  const flightStart = new Date();
  const flightEnd = new Date(flightStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Sync a restrictive plan: small budget, US only
  const { result: syncResult, step: syncStep } = await runStep<TaskResult>(
    'Sync restrictive plan (small budget, US only)',
    'sync_plans',
    async () =>
      client.executeTask('sync_plans', {
        plans: [
          {
            plan_id: testPlanId,
            brand: options.brand || { domain: 'test.example' },
            objectives: 'E2E denial test: budget and geo restrictions',
            budget: {
              total: 500,
              currency: 'USD',
              authority_level: 'agent_limited',
              reallocation_threshold: 100,
            },
            flight: {
              start: flightStart.toISOString(),
              end: flightEnd.toISOString(),
            },
            countries: ['US'],
            channels: {
              allowed: ['display'],
            },
          },
        ],
      }) as Promise<TaskResult>
  );
  steps.push(syncStep);

  if (!syncResult?.success) {
    return { steps, profile };
  }

  // Check governance with over-budget request
  const { result: overBudgetResult, step: overBudgetStep } = await runStep<TaskResult>(
    'Check governance (over-budget, expecting denial or conditions)',
    'check_governance',
    async () =>
      client.executeTask('check_governance', {
        plan_id: testPlanId,
        binding: 'proposed',
        caller: callerUrl,
        tool: 'create_media_buy',
        payload: {
          channel: 'display',
          budget: { total: 50000, currency: 'USD' },
          flight: {
            start: flightStart.toISOString(),
            end: flightEnd.toISOString(),
          },
          countries: ['US'],
        },
      }) as Promise<TaskResult>
  );

  let overBudgetGovernanceContext: string | undefined;
  if (overBudgetResult?.success && overBudgetResult?.data) {
    const data = overBudgetResult.data;
    overBudgetGovernanceContext = data.governance_context;
    overBudgetStep.details = `Over-budget check: status=${data.status}, explanation: ${data.explanation}`;
    overBudgetStep.response_preview = JSON.stringify(
      {
        status: data.status,
        explanation: data.explanation,
        findings: data.findings?.map((f: any) => ({
          category_id: f.category_id,
          severity: f.severity,
          explanation: f.explanation,
        })),
        conditions: data.conditions,
        governance_context: data.governance_context ? '(present)' : '(absent)',
      },
      null,
      2
    );
    overBudgetStep.observation_data = { governance_context: data.governance_context || null };

    if (data.status === 'approved' && data.mode !== 'advisory' && data.mode !== 'audit') {
      overBudgetStep.passed = false;
      overBudgetStep.error =
        'Governance approved a $50,000 buy against a $500 plan in enforce mode — expected denial or conditions';
    } else if (data.status === 'approved') {
      overBudgetStep.warnings = [
        'Governance approved a $50,000 buy against a $500 plan — advisory/audit mode detected',
      ];
    }
  } else if (overBudgetResult && !overBudgetResult.success) {
    overBudgetStep.passed = false;
    overBudgetStep.error = overBudgetResult.error || 'check_governance failed';
  }
  steps.push(overBudgetStep);

  // Check governance with unauthorized market
  const { result: geoResult, step: geoStep } = await runStep<TaskResult>(
    'Check governance (unauthorized market, expecting denial or conditions)',
    'check_governance',
    async () =>
      client.executeTask('check_governance', {
        plan_id: testPlanId,
        binding: 'proposed',
        caller: callerUrl,
        tool: 'create_media_buy',
        payload: {
          channel: 'display',
          budget: { total: 100, currency: 'USD' },
          flight: {
            start: flightStart.toISOString(),
            end: flightEnd.toISOString(),
          },
          countries: ['CN', 'RU'],
        },
      }) as Promise<TaskResult>
  );

  if (geoResult?.success && geoResult?.data) {
    const data = geoResult.data;
    geoStep.details = `Unauthorized market check: status=${data.status}`;
    geoStep.response_preview = JSON.stringify(
      {
        status: data.status,
        explanation: data.explanation,
        findings: data.findings?.map((f: any) => ({
          category_id: f.category_id,
          explanation: f.explanation,
        })),
      },
      null,
      2
    );

    if (data.status === 'approved') {
      geoStep.warnings = [
        'Governance approved targeting CN/RU against US-only plan — may indicate audit/advisory mode',
      ];
    }
  } else if (geoResult && !geoResult.success) {
    geoStep.passed = false;
    geoStep.error = geoResult.error || 'check_governance failed';
  }
  steps.push(geoStep);

  // Report failed outcome — thread governance_context
  if (profile.tools.includes('report_plan_outcome') && overBudgetResult?.data?.check_id) {
    const { step: outcomeStep } = await runStep<TaskResult>(
      'Report failed outcome for denied check',
      'report_plan_outcome',
      async () =>
        client.executeTask('report_plan_outcome', {
          plan_id: testPlanId,
          check_id: overBudgetResult.data.check_id,
          outcome: 'failed',
          governance_context: overBudgetGovernanceContext || '',
          error: {
            code: 'governance_denied',
            message: 'Action blocked by governance check',
          },
        }) as Promise<TaskResult>
    );
    steps.push(outcomeStep);
  }

  return { steps, profile };
}

/**
 * Test: Campaign Governance - Conditions Flow
 *
 * Syncs a plan, sends a check that may trigger conditions (e.g., budget
 * concentration limit), applies machine-actionable conditions, and re-checks.
 */
export async function testCampaignGovernanceConditions(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  if (!profile.tools.includes('sync_plans') || !profile.tools.includes('check_governance')) {
    steps.push({
      step: 'Campaign governance conditions flow support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent requires sync_plans + check_governance for conditions flow testing',
    });
    return { steps, profile };
  }

  profile.supports_governance = true;

  const testPlanId = `test-conditions-plan-${Date.now()}`;
  const callerUrl = 'https://test-orchestrator.example';
  const flightStart = new Date();
  const flightEnd = new Date(flightStart.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Sync a plan with per_seller_max_pct constraint
  const { result: syncResult, step: syncStep } = await runStep<TaskResult>(
    'Sync plan with seller concentration limit',
    'sync_plans',
    async () =>
      client.executeTask('sync_plans', {
        plans: [
          {
            plan_id: testPlanId,
            brand: options.brand || { domain: 'test.example' },
            objectives: 'E2E conditions test: budget cap per seller',
            budget: {
              total: 5000,
              currency: 'USD',
              authority_level: 'agent_limited',
              per_seller_max_pct: 50,
              reallocation_threshold: 500,
            },
            flight: {
              start: flightStart.toISOString(),
              end: flightEnd.toISOString(),
            },
            countries: ['US'],
            channels: {
              allowed: ['display', 'video'],
              mix_targets: {
                display: { min_pct: 30, max_pct: 70 },
                video: { min_pct: 30, max_pct: 70 },
              },
            },
          },
        ],
      }) as Promise<TaskResult>
  );
  steps.push(syncStep);

  if (!syncResult?.success) {
    return { steps, profile };
  }

  // First check: send budget that might trigger conditions
  const { result: checkResult, step: checkStep } = await runStep<TaskResult>(
    'Check governance (may trigger conditions)',
    'check_governance',
    async () =>
      client.executeTask('check_governance', {
        plan_id: testPlanId,
        binding: 'proposed',
        caller: callerUrl,
        tool: 'create_media_buy',
        payload: {
          channel: 'display',
          budget: { total: 4000, currency: 'USD' },
          flight: {
            start: flightStart.toISOString(),
            end: flightEnd.toISOString(),
          },
          countries: ['US'],
        },
      }) as Promise<TaskResult>
  );

  if (checkResult?.success && checkResult?.data) {
    const data = checkResult.data;
    const initialGovernanceContext: string | undefined = data.governance_context;
    checkStep.details = `Initial check: status=${data.status}`;
    checkStep.response_preview = JSON.stringify(
      {
        check_id: data.check_id,
        status: data.status,
        explanation: data.explanation,
        conditions: data.conditions,
        findings: data.findings?.map((f: any) => ({
          category_id: f.category_id,
          explanation: f.explanation,
        })),
        governance_context: initialGovernanceContext ? '(present)' : '(absent)',
      },
      null,
      2
    );
    checkStep.observation_data = { governance_context: initialGovernanceContext || null };

    // If we got conditions, apply them and re-check with governance_context round-trip
    if (data.status === 'conditions' && data.conditions?.length > 0) {
      const conditions = data.conditions;
      const appliedConditions = conditions
        .filter((c: any) => c.required_value !== undefined)
        .map((c: any) => `${c.field}=${JSON.stringify(c.required_value)}`);

      checkStep.details += `. Conditions received: ${conditions.length} (${appliedConditions.length} machine-actionable)`;

      // Build adjusted payload by applying conditions
      const adjustedPayload: any = {
        channel: 'display',
        budget: { total: 4000, currency: 'USD' },
        flight: {
          start: flightStart.toISOString(),
          end: flightEnd.toISOString(),
        },
        countries: ['US'],
      };

      for (const condition of conditions) {
        if (condition.required_value !== undefined) {
          setAtPath(adjustedPayload, condition.field, condition.required_value);
        }
      }

      // Re-check with adjusted parameters — thread governance_context from initial check
      const { result: recheckResult, step: recheckStep } = await runStep<TaskResult>(
        'Re-check governance (after applying conditions)',
        'check_governance',
        async () =>
          client.executeTask('check_governance', {
            plan_id: testPlanId,
            binding: 'proposed',
            caller: callerUrl,
            tool: 'create_media_buy',
            payload: adjustedPayload,
            governance_context: initialGovernanceContext,
          }) as Promise<TaskResult>
      );

      if (recheckResult?.success && recheckResult?.data) {
        const recheckData = recheckResult.data;
        recheckStep.details = `Re-check after conditions: status=${recheckData.status}`;
        recheckStep.response_preview = JSON.stringify(
          {
            check_id: recheckData.check_id,
            status: recheckData.status,
            explanation: recheckData.explanation,
            governance_context: recheckData.governance_context ? '(present)' : '(absent)',
          },
          null,
          2
        );
        recheckStep.observation_data = { governance_context: recheckData.governance_context || null };
      } else if (recheckResult && !recheckResult.success) {
        recheckStep.passed = false;
        recheckStep.error = recheckResult.error || 'Re-check after conditions failed';
      }
      steps.push(recheckStep);
    }
  } else if (checkResult && !checkResult.success) {
    checkStep.passed = false;
    checkStep.error = checkResult.error || 'check_governance failed';
  }
  steps.push(checkStep);

  return { steps, profile };
}

/**
 * Test: Campaign Governance - Delivery Monitoring
 *
 * Tests delivery-phase check_governance with delivery_metrics, including
 * normal pacing and overspend drift detection.
 */
export async function testCampaignGovernanceDelivery(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  if (!profile.tools.includes('check_governance')) {
    steps.push({
      step: 'Campaign governance delivery monitoring support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent requires check_governance for delivery monitoring testing',
    });
    return { steps, profile };
  }

  profile.supports_governance = true;

  const testPlanId = `test-delivery-plan-${Date.now()}`;
  const testMediaBuyId = `test-mb-${Date.now()}`;
  const callerUrl = 'https://test-seller.example';
  const flightStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const flightEnd = new Date(Date.now() + 23 * 24 * 60 * 60 * 1000);

  // Sync plan if supported
  if (profile.tools.includes('sync_plans')) {
    const { result: syncResult, step: syncStep } = await runStep<TaskResult>(
      'Sync plan for delivery monitoring',
      'sync_plans',
      async () =>
        client.executeTask('sync_plans', {
          plans: [
            {
              plan_id: testPlanId,
              brand: options.brand || { domain: 'test.example' },
              objectives: 'E2E delivery monitoring test',
              budget: {
                total: 10000,
                currency: 'USD',
                authority_level: 'agent_full',
              },
              flight: {
                start: flightStart.toISOString(),
                end: flightEnd.toISOString(),
              },
              countries: ['US'],
            },
          ],
        }) as Promise<TaskResult>
    );
    steps.push(syncStep);

    if (!syncResult?.success) {
      return { steps, profile };
    }
  }

  // Delivery-phase committed check with metrics
  const reportingStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const reportingEnd = new Date();

  const { result: deliveryResult, step: deliveryStep } = await runStep<TaskResult>(
    'Check governance (delivery phase with metrics)',
    'check_governance',
    async () =>
      client.executeTask('check_governance', {
        plan_id: testPlanId,
        binding: 'committed',
        caller: callerUrl,
        media_buy_id: testMediaBuyId,
        phase: 'delivery',
        planned_delivery: {
          total_budget: 3000,
          currency: 'USD',
          channels: ['display'],
          geo: { countries: ['US'] },
        },
        delivery_metrics: {
          reporting_period: {
            start: reportingStart.toISOString(),
            end: reportingEnd.toISOString(),
          },
          spend: 450,
          cumulative_spend: 2800,
          impressions: 15000,
          cumulative_impressions: 85000,
          geo_distribution: { US: 100 },
          channel_distribution: { display: 100 },
          pacing: 'on_track',
        },
      }) as Promise<TaskResult>
  );

  let deliveryGovernanceContext: string | undefined;
  if (deliveryResult?.success && deliveryResult?.data) {
    const data = deliveryResult.data;
    deliveryGovernanceContext = data.governance_context;
    deliveryStep.details = `Delivery check: status=${data.status}, next_check=${data.next_check || 'not specified'}`;
    deliveryStep.response_preview = JSON.stringify(
      {
        check_id: data.check_id,
        status: data.status,
        binding: data.binding,
        explanation: data.explanation,
        findings: data.findings?.map((f: any) => ({
          category_id: f.category_id,
          severity: f.severity,
          explanation: f.explanation,
        })),
        next_check: data.next_check,
        governance_context: data.governance_context ? '(present)' : '(absent)',
      },
      null,
      2
    );
    deliveryStep.observation_data = { governance_context: data.governance_context || null };
  } else if (deliveryResult && !deliveryResult.success) {
    deliveryStep.passed = false;
    deliveryStep.error = deliveryResult.error || 'Delivery-phase check_governance failed';
  }
  steps.push(deliveryStep);

  // Delivery-phase check with drift (overspend) — thread governance_context from first check
  const { result: driftResult, step: driftStep } = await runStep<TaskResult>(
    'Check governance (delivery phase with overspend drift)',
    'check_governance',
    async () =>
      client.executeTask('check_governance', {
        plan_id: testPlanId,
        binding: 'committed',
        caller: callerUrl,
        media_buy_id: testMediaBuyId,
        phase: 'delivery',
        governance_context: deliveryGovernanceContext,
        planned_delivery: {
          total_budget: 3000,
          currency: 'USD',
          channels: ['display'],
          geo: { countries: ['US'] },
        },
        delivery_metrics: {
          reporting_period: {
            start: reportingStart.toISOString(),
            end: reportingEnd.toISOString(),
          },
          spend: 2000,
          cumulative_spend: 9500,
          impressions: 5000,
          cumulative_impressions: 90000,
          pacing: 'ahead',
        },
      }) as Promise<TaskResult>
  );

  if (driftResult?.success && driftResult?.data) {
    const data = driftResult.data;
    driftStep.details = `Overspend drift check: status=${data.status}`;
    driftStep.response_preview = JSON.stringify(
      {
        status: data.status,
        explanation: data.explanation,
        findings: data.findings?.map((f: any) => ({
          category_id: f.category_id,
          severity: f.severity,
          explanation: f.explanation,
        })),
      },
      null,
      2
    );

    if (data.status === 'approved' && !data.findings?.length) {
      driftStep.warnings = ['Governance approved delivery at 95% budget with no findings — verify drift detection'];
    }
  } else if (driftResult && !driftResult.success) {
    driftStep.passed = false;
    driftStep.error = driftResult.error || 'Drift detection check_governance failed';
  }
  steps.push(driftStep);

  return { steps, profile };
}

/**
 * Test: Seller Governance Context Round-Trip
 *
 * Two-tier test:
 * 1. (Active) If seller supports register_governance: starts a stub governance
 *    agent, registers it with the seller, creates a media buy, and verifies
 *    the seller called check_governance on the stub with the correct
 *    governance_context.
 * 2. (Passive) Verifies the seller persists governance_context from
 *    create_media_buy and returns it on get_media_buys.
 */
export async function testSellerGovernanceContext(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // This scenario requires create_media_buy + get_media_buys (seller tools)
  if (!profile.tools.includes('create_media_buy') || !profile.tools.includes('get_media_buys')) {
    steps.push({
      step: 'Seller governance_context support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent requires create_media_buy + get_media_buys for governance_context persistence testing',
    });
    return { steps, profile };
  }

  // Need get_products to create a valid media buy
  if (!profile.tools.includes('get_products')) {
    steps.push({
      step: 'Seller governance_context support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent requires get_products for governance_context persistence testing',
    });
    return { steps, profile };
  }

  // Step 1: Get products
  const { result: productsResult, step: productsStep } = await runStep<TaskResult>(
    'Fetch products for governance context test',
    'get_products',
    async () =>
      client.executeTask('get_products', {
        buying_mode: 'brief',
        brief: options.brief || 'display advertising',
        brand: options.brand || { domain: 'test.example' },
      }) as Promise<TaskResult>
  );
  steps.push(productsStep);

  const products = productsResult?.data?.products as Array<Record<string, unknown>> | undefined;
  if (!products?.length) {
    return { steps, profile };
  }

  // Pick first product with pricing
  const product = products[0]!;
  const pricingOptions = product.pricing_options as Array<Record<string, unknown>> | undefined;
  const pricing = pricingOptions?.[0];
  if (!pricing) {
    steps.push({
      step: 'Select product for governance context test',
      passed: false,
      duration_ms: 0,
      error: 'No products with pricing options available',
    });
    return { steps, profile };
  }

  // Step 2: Resolve an account to use for the test
  const account = await resolveTestAccount(client, profile, options);

  // Step 3: If seller supports register_governance, start stub and register it
  let stub: GovernanceAgentStub | null = null;
  let stubUrl: string | null = null;
  let governanceContext: string | null = null;
  const planId = `plan-comply-gc-${Date.now()}`;
  // register_governance is from AdCP PR #1644 — merged but schemas not yet deployed.
  // Once deployed and synced, sellers that implement it will get the active stub test.
  const hasRegisterGovernance = profile.tools.includes('register_governance');

  if (hasRegisterGovernance) {
    stub = new GovernanceAgentStub();
    try {
      const info = await stub.startHttps();
      stubUrl = info.url;
    } catch {
      // HTTPS generation failed (no openssl?) — fall back to HTTP
      try {
        const info = await stub.start();
        stubUrl = info.url;
      } catch (err) {
        steps.push({
          step: 'Start governance agent stub',
          passed: false,
          duration_ms: 0,
          error: `Failed to start governance agent stub: ${(err as Error).message}`,
        });
        return { steps, profile };
      }
    }

    steps.push({
      step: 'Start governance agent stub',
      passed: true,
      duration_ms: 0,
      details: `Stub running at ${stubUrl}`,
    });

    // Register the stub with the seller
    const { result: registerResult, step: registerStep } = await runStep<TaskResult>(
      'Register governance agent with seller',
      'register_governance',
      async () =>
        client.executeTask('register_governance', {
          accounts: [
            {
              account,
              governance_agents: [
                {
                  url: stubUrl,
                  authentication: {
                    schemes: ['Bearer'],
                    credentials: stub!.authToken,
                  },
                },
              ],
            },
          ],
        }) as Promise<TaskResult>
    );
    steps.push(registerStep);

    if (!registerResult?.success) {
      // Registration failed — fall through to passive test
      steps.push({
        step: 'Governance agent registration',
        passed: true,
        duration_ms: 0,
        details: 'register_governance failed — falling back to passive governance_context persistence test',
        warnings: ['Cannot verify seller calls governance agent — register_governance returned an error'],
      });
    } else {
      // Get governance_context from the stub (simulate buyer's proposed check)
      try {
        const checkResult = await callMCPTool(stubUrl!, 'check_governance', {
          plan_id: planId,
          binding: 'proposed',
          caller: 'buyer',
          tool: 'create_media_buy',
          payload: {},
        });
        const parsed = JSON.parse((checkResult as { content: Array<{ text: string }> }).content[0]!.text);
        governanceContext = parsed.governance_context as string;

        steps.push({
          step: 'Obtain governance_context from stub (proposed check)',
          passed: true,
          duration_ms: 0,
          details: `governance_context received (${governanceContext?.length ?? 0} chars)`,
        });
      } catch (err) {
        steps.push({
          step: 'Obtain governance_context from stub (proposed check)',
          passed: false,
          duration_ms: 0,
          error: `Failed to call check_governance on stub: ${(err as Error).message}`,
        });
      }
    }
  } else {
    steps.push({
      step: 'Check register_governance support',
      passed: true,
      duration_ms: 0,
      details: 'Seller does not support register_governance — running passive governance_context persistence test only',
      warnings: ['Cannot verify seller calls governance agent — register_governance not supported'],
    });
  }

  // Step 4: Create media buy WITH governance_context
  const testGovernanceContext = governanceContext || `test-gc-comply-${Date.now()}`;
  const flightStart = new Date();
  const flightEnd = new Date(flightStart.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create media buy with governance_context',
    'create_media_buy',
    async () =>
      client.executeTask('create_media_buy', {
        account,
        brand: options.brand || { domain: 'test.example' },
        start_time: flightStart.toISOString(),
        end_time: flightEnd.toISOString(),
        plan_id: governanceContext ? planId : undefined,
        packages: [
          {
            product_id: product.product_id,
            pricing_option_id: pricing.pricing_option_id,
            budget: (pricing.min_spend_per_package as number) || 500,
            bid_price: ((pricing.floor_price as number) || (pricing.fixed_price as number) || 10) + 1,
            name: 'Governance context test package',
          },
        ],
        governance_context: testGovernanceContext,
      }) as Promise<TaskResult>
  );

  if (!createResult?.success || !createResult?.data) {
    createStep.passed = false;
    createStep.error = createResult?.error || 'create_media_buy failed';
    steps.push(createStep);
    await stopStub(stub);
    return { steps, profile };
  }

  const mediaBuyId = createResult.data.media_buy_id as string;
  createStep.details = `Created media buy ${mediaBuyId} with governance_context`;
  steps.push(createStep);

  // Step 5: If stub is active, verify seller called check_governance(committed)
  if (stub && governanceContext && stubUrl) {
    // Poll the stub's call log for the committed check (100ms interval, 5s timeout)
    const pollStart = Date.now();
    const pollTimeout = 5000;
    const pollInterval = 100;
    while (Date.now() - pollStart < pollTimeout) {
      const calls = stub.getCallsForTool('check_governance');
      if (calls.some(c => c.params.binding === 'committed')) break;
      await new Promise(r => setTimeout(r, pollInterval));
    }

    const committedCalls = stub.getCallsForTool('check_governance').filter(c => c.params.binding === 'committed');

    const { step: callbackStep } = await runStep<void>(
      'Verify seller called check_governance(committed) on governance agent',
      'check_governance (callback)',
      async () => {
        if (committedCalls.length === 0) {
          throw new Error(
            'Seller did not call check_governance(committed) on the registered governance agent. ' +
              'Sellers MUST call check_governance with binding="committed" before executing a media buy.'
          );
        }

        const callWithContext = committedCalls.find(c => c.params.governance_context === governanceContext);

        if (!callWithContext) {
          throw new Error(
            `Seller called check_governance(committed) but with wrong governance_context. ` +
              `Expected "${governanceContext}", got: ${committedCalls.map(c => JSON.stringify(c.params.governance_context)).join(', ')}`
          );
        }
      }
    );

    if (committedCalls.length > 0) {
      callbackStep.response_preview = JSON.stringify(committedCalls[0]!.params, null, 2);
    }
    steps.push(callbackStep);
  }

  // Step 6: Retrieve the media buy and check for governance_context persistence
  const { result: getResult, step: getStep } = await runStep<TaskResult>(
    'Verify governance_context persisted on get_media_buys',
    'get_media_buys',
    async () =>
      client.executeTask('get_media_buys', {
        media_buy_ids: [mediaBuyId],
      }) as Promise<TaskResult>
  );

  if (getResult?.success && getResult?.data) {
    const buys = (getResult.data.media_buys as Array<Record<string, unknown>>) || [];
    const buy =
      buys.find((b: Record<string, unknown>) => b.media_buy_id === mediaBuyId) ||
      (buys.length === 1 ? buys[0] : undefined);

    if (buy) {
      const returnedGC = buy.governance_context as string | undefined;
      if (returnedGC === testGovernanceContext) {
        getStep.details = 'governance_context persisted and returned correctly';
      } else if (returnedGC) {
        getStep.passed = false;
        getStep.error = `governance_context returned but value changed: expected "${testGovernanceContext}", got "${returnedGC}"`;
      } else {
        getStep.passed = false;
        getStep.error =
          'Seller did not return governance_context on get_media_buys. ' +
          'Sellers MUST persist governance_context from create_media_buy and include it on all subsequent responses.';
      }
      getStep.response_preview = JSON.stringify(
        {
          media_buy_id: buy.media_buy_id,
          governance_context: returnedGC ? `(present, ${returnedGC.length} chars)` : '(absent)',
          status: buy.status,
        },
        null,
        2
      );
    } else if (buys.length === 0) {
      getStep.details =
        'get_media_buys returned 0 buys — agent may be stateless (test agent). Cannot verify governance_context persistence.';
      getStep.warnings = [
        'governance_context persistence could not be verified — agent does not persist media buys across requests',
      ];
    } else {
      getStep.passed = false;
      getStep.error = `Media buy ${mediaBuyId} not found among ${buys.length} returned buys`;
    }
  } else if (getResult && !getResult.success) {
    getStep.passed = false;
    getStep.error = getResult.error || 'get_media_buys failed';
  }
  steps.push(getStep);

  await stopStub(stub);
  return { steps, profile };
}

/**
 * Resolve a test account from the seller. Tries list_accounts first,
 * then sync_accounts, then falls back to a static account reference.
 */
async function resolveTestAccount(
  client: ReturnType<typeof getOrCreateClient>,
  profile: AgentProfile,
  options: TestOptions
): Promise<Record<string, unknown>> {
  if (profile.tools.includes('list_accounts')) {
    try {
      const result = (await client.executeTask('list_accounts', {})) as TaskResult;
      const accounts = result?.data?.accounts as Array<Record<string, unknown>> | undefined;
      if (accounts?.length && accounts[0]) {
        return { account_id: accounts[0].account_id };
      }
    } catch {
      // Fall through
    }
  }

  if (profile.tools.includes('sync_accounts')) {
    try {
      const result = (await client.executeTask('sync_accounts', {
        accounts: [
          {
            brand: options.brand || { domain: 'test.example' },
            operator: 'comply-test',
            billing: 'operator',
            sandbox: true,
          },
        ],
      })) as TaskResult;
      const accounts = result?.data?.accounts as Array<Record<string, unknown>> | undefined;
      if (accounts?.length && accounts[0] && accounts[0].account_id) {
        return { account_id: accounts[0].account_id };
      }
    } catch {
      // Fall through
    }
  }

  return { account_id: 'test-gc-acct' };
}

async function stopStub(stub: GovernanceAgentStub | null): Promise<void> {
  if (stub) {
    try {
      await stub.stop();
    } catch {}
  }
}

/**
 * Check if agent has any governance protocol tools
 */
export function hasGovernanceTools(tools: string[]): boolean {
  return GOVERNANCE_TOOLS.some(t => tools.includes(t));
}

/**
 * Check if agent has campaign governance tools
 */
export function hasCampaignGovernanceTools(tools: string[]): boolean {
  return CAMPAIGN_GOVERNANCE_TOOLS.some(t => tools.includes(t));
}
