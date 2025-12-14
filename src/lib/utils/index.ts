import type { CreativeFormat } from '../types';

// Re-export logger utilities
export { logger, createLogger, type LogLevel, type LoggerConfig } from './logger';
import { logger } from './logger';

// Re-export preview utilities
export {
  batchPreviewProducts,
  batchPreviewFormats,
  clearPreviewCache,
  type PreviewResult,
  type BatchPreviewOptions,
} from './preview-utils';

// Configuration constants
export const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000'); // 30 seconds
export const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5');

// Standard creative formats (hardcoded for now)
export const STANDARD_FORMATS: CreativeFormat[] = [
  {
    format_id: {
      agent_url: 'https://creatives.adcontextprotocol.org',
      id: 'banner_728x90',
    },
    name: 'Leaderboard',
    dimensions: { width: 728, height: 90 },
    aspect_ratio: '8:1',
    file_types: ['jpg', 'jpeg', 'png', 'gif'],
    max_file_size: 150000,
  },
  {
    format_id: {
      agent_url: 'https://creatives.adcontextprotocol.org',
      id: 'banner_300x250',
    },
    name: 'Medium Rectangle',
    dimensions: { width: 300, height: 250 },
    aspect_ratio: '6:5',
    file_types: ['jpg', 'jpeg', 'png', 'gif'],
    max_file_size: 150000,
  },
  {
    format_id: {
      agent_url: 'https://creatives.adcontextprotocol.org',
      id: 'banner_320x50',
    },
    name: 'Mobile Banner',
    dimensions: { width: 320, height: 50 },
    aspect_ratio: '32:5',
    file_types: ['jpg', 'jpeg', 'png', 'gif'],
    max_file_size: 40000,
  },
  {
    format_id: {
      agent_url: 'https://creatives.adcontextprotocol.org',
      id: 'video_1920x1080',
    },
    name: 'Full HD Video',
    dimensions: { width: 1920, height: 1080 },
    aspect_ratio: '16:9',
    file_types: ['mp4', 'webm'],
    max_file_size: 10000000,
    duration_range: { min: 6, max: 30 },
  },
];

/**
 * Circuit Breaker for handling agent failures
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly failureThreshold = 5;
  private readonly resetTimeout = 60000; // 1 minute

  constructor(private agentId: string) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailTime > this.resetTimeout) {
        this.state = 'half-open';
        logger.info(`🔄 Circuit breaker for ${this.agentId} attempting to close...`);
      } else {
        throw new Error(`Circuit breaker is open for agent ${this.agentId}`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.state = 'closed';
      logger.info(`✅ Circuit breaker for ${this.agentId} closed successfully`);
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      logger.warn(`🚨 Circuit breaker opened for agent ${this.agentId} after ${this.failures} failures`);
    }
  }
}

// Circuit breaker instances for each agent
const circuitBreakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(agentId: string): CircuitBreaker {
  if (!circuitBreakers.has(agentId)) {
    circuitBreakers.set(agentId, new CircuitBreaker(agentId));
  }
  return circuitBreakers.get(agentId)!;
}

/**
 * Get standard creative formats
 */
export function getStandardFormats(): CreativeFormat[] {
  return STANDARD_FORMATS;
}

// Re-export response unwrapping utilities
export { unwrapProtocolResponse, isAdcpError, isAdcpSuccess } from './response-unwrapper';
export type { AdCPResponse } from './response-unwrapper';

// Re-export protocol detection utilities
export { detectProtocol, detectProtocolWithTimeout } from './protocol-detection';

// Re-export tool support utilities
export { checkToolSupportsPushNotification } from './tool-support';
