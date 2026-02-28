/**
 * Content Standards Adapter
 *
 * Server-side adapter for implementing content standards evaluation logic.
 * Publishers use this to plug in their brand safety/suitability evaluation systems.
 *
 * This is a stub implementation that returns not-supported responses.
 * Publishers should extend or replace this with their actual evaluation logic.
 */

import type {
  ListContentStandardsRequest,
  ListContentStandardsResponse,
  GetContentStandardsRequest,
  GetContentStandardsResponse,
  CreateContentStandardsRequest,
  CreateContentStandardsResponse,
  UpdateContentStandardsRequest,
  UpdateContentStandardsResponse,
  CalibrateContentRequest,
  CalibrateContentResponse,
  ValidateContentDeliveryRequest,
  ValidateContentDeliveryResponse,
  ContentStandards,
  Artifact,
} from '../types/tools.generated';

/**
 * Content evaluation result from the adapter
 */
export interface ContentEvaluationResult {
  verdict: 'pass' | 'fail';
  confidence?: number;
  explanation?: string;
  features?: {
    feature_id: string;
    status: 'passed' | 'failed' | 'warning' | 'unevaluated';
    explanation?: string;
  }[];
}

/**
 * Abstract interface for content standards adapters.
 * Publishers implement this to provide their evaluation logic.
 */
export interface IContentStandardsAdapter {
  /**
   * Check if content standards are supported by this server
   */
  isSupported(): boolean;

  /**
   * List available content standards configurations
   */
  listStandards(request: ListContentStandardsRequest): Promise<ListContentStandardsResponse>;

  /**
   * Get a specific content standards configuration
   */
  getStandards(request: GetContentStandardsRequest): Promise<GetContentStandardsResponse>;

  /**
   * Create a new content standards configuration
   */
  createStandards(request: CreateContentStandardsRequest): Promise<CreateContentStandardsResponse>;

  /**
   * Update an existing content standards configuration
   */
  updateStandards(request: UpdateContentStandardsRequest): Promise<UpdateContentStandardsResponse>;

  /**
   * Calibrate content against standards (interactive feedback loop)
   */
  calibrateContent(request: CalibrateContentRequest): Promise<CalibrateContentResponse>;

  /**
   * Validate delivery records against content standards (batch validation)
   */
  validateContentDelivery(request: ValidateContentDeliveryRequest): Promise<ValidateContentDeliveryResponse>;

  /**
   * Evaluate a single artifact against standards.
   * Used internally by get_products and create_media_buy to filter content.
   */
  evaluateArtifact(standardsId: string, artifact: Artifact): Promise<ContentEvaluationResult>;
}

/**
 * Error codes for content standards operations
 */
export const ContentStandardsErrorCodes = {
  NOT_SUPPORTED: 'content_standards_not_supported',
  STANDARDS_NOT_FOUND: 'standards_not_found',
  INVALID_STANDARDS: 'invalid_standards',
  EVALUATION_FAILED: 'evaluation_failed',
  QUOTA_EXCEEDED: 'quota_exceeded',
} as const;

/**
 * Stub implementation of ContentStandardsAdapter.
 * Returns not-supported errors for all operations.
 *
 * Publishers should extend this class or provide their own implementation
 * that integrates with their brand safety systems.
 */
export class ContentStandardsAdapter implements IContentStandardsAdapter {
  /**
   * Check if content standards are supported.
   * Override this to return true when implementing real logic.
   */
  isSupported(): boolean {
    return false;
  }

  async listStandards(request: ListContentStandardsRequest): Promise<ListContentStandardsResponse> {
    if (!this.isSupported()) {
      return {
        errors: [
          {
            code: ContentStandardsErrorCodes.NOT_SUPPORTED,
            message: 'Content standards are not supported by this server',
          },
        ],
      };
    }

    // Override in subclass to return actual standards
    return {
      standards: [],
      context: request.context,
    };
  }

  async getStandards(request: GetContentStandardsRequest): Promise<GetContentStandardsResponse> {
    if (!this.isSupported()) {
      return {
        errors: [
          {
            code: ContentStandardsErrorCodes.NOT_SUPPORTED,
            message: 'Content standards are not supported by this server',
          },
        ],
      };
    }

    // Override in subclass to return actual standards
    return {
      errors: [
        {
          code: ContentStandardsErrorCodes.STANDARDS_NOT_FOUND,
          message: `Standards not found: ${request.standards_id}`,
        },
      ],
    };
  }

  async createStandards(request: CreateContentStandardsRequest): Promise<CreateContentStandardsResponse> {
    if (!this.isSupported()) {
      return {
        errors: [
          {
            code: ContentStandardsErrorCodes.NOT_SUPPORTED,
            message: 'Content standards are not supported by this server',
          },
        ],
      };
    }

    // Override in subclass to implement creation logic
    return {
      errors: [
        {
          code: ContentStandardsErrorCodes.NOT_SUPPORTED,
          message: 'Creating content standards is not implemented',
        },
      ],
    };
  }

  async updateStandards(request: UpdateContentStandardsRequest): Promise<UpdateContentStandardsResponse> {
    if (!this.isSupported()) {
      return {
        success: false as const,
        errors: [
          {
            code: ContentStandardsErrorCodes.NOT_SUPPORTED,
            message: 'Content standards are not supported by this server',
          },
        ],
      };
    }

    // Override in subclass to implement update logic
    return {
      success: false as const,
      errors: [
        {
          code: ContentStandardsErrorCodes.NOT_SUPPORTED,
          message: 'Updating content standards is not implemented',
        },
      ],
    };
  }

  async calibrateContent(request: CalibrateContentRequest): Promise<CalibrateContentResponse> {
    if (!this.isSupported()) {
      return {
        errors: [
          {
            code: ContentStandardsErrorCodes.NOT_SUPPORTED,
            message: 'Content standards calibration is not supported by this server',
          },
        ],
      };
    }

    // Override in subclass to implement calibration logic
    return {
      errors: [
        {
          code: ContentStandardsErrorCodes.EVALUATION_FAILED,
          message: 'Content calibration is not implemented',
        },
      ],
    };
  }

  async validateContentDelivery(request: ValidateContentDeliveryRequest): Promise<ValidateContentDeliveryResponse> {
    if (!this.isSupported()) {
      return {
        errors: [
          {
            code: ContentStandardsErrorCodes.NOT_SUPPORTED,
            message: 'Content delivery validation is not supported by this server',
          },
        ],
        context: request.context,
      };
    }

    // Override in subclass to implement validation logic
    // Stub returns all records as passed (no filtering)
    return {
      summary: {
        total_records: request.records.length,
        passed_records: request.records.length,
        failed_records: 0,
      },
      results: request.records.map(record => ({
        record_id: record.record_id,
        verdict: 'pass' as const,
      })),
      context: request.context,
    };
  }

  /**
   * Evaluate a single artifact against content standards.
   * Used by get_products and create_media_buy to filter content.
   */
  async evaluateArtifact(standardsId: string, artifact: Artifact): Promise<ContentEvaluationResult> {
    if (!this.isSupported()) {
      // When not supported, all content passes (no filtering)
      return {
        verdict: 'pass',
        confidence: 1.0,
        explanation: 'Content standards evaluation not enabled',
      };
    }

    // Override in subclass to implement actual evaluation
    return {
      verdict: 'pass',
      confidence: 1.0,
      explanation: 'Default pass-through (no evaluation implemented)',
    };
  }
}

/**
 * Helper to check if a response is an error response
 */
export function isContentStandardsError(
  response: ListContentStandardsResponse | GetContentStandardsResponse | CreateContentStandardsResponse
): boolean {
  return 'errors' in response && Array.isArray(response.errors) && response.errors.length > 0;
}

/**
 * Default singleton instance for servers that don't need content standards
 */
export const defaultContentStandardsAdapter = new ContentStandardsAdapter();
