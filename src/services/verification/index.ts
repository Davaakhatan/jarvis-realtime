import { createChildLogger } from '../../shared/utils/index';

const logger = createChildLogger('verification-client');

export interface VerificationRequest {
  sessionId: string;
  responseText: string;
  claimedSources?: string[];
  context?: Record<string, unknown>;
}

export interface VerificationResult {
  verified: boolean;
  confidence: number;
  citations: Array<{
    source: string;
    verified: boolean;
    snippet: string | null;
    type: string;
  }>;
  warnings: string[];
  modifiedResponse: string | null;
}

export interface VerificationConfig {
  serviceUrl: string;
  enabled: boolean;
  minConfidence: number;
}

export class VerificationClient {
  private config: VerificationConfig;

  constructor(config: Partial<VerificationConfig> = {}) {
    this.config = {
      serviceUrl: config.serviceUrl || 'http://localhost:8003',
      enabled: config.enabled ?? true,
      minConfidence: config.minConfidence ?? 0.6,
    };
  }

  async verify(request: VerificationRequest): Promise<VerificationResult> {
    if (!this.config.enabled) {
      logger.debug('Verification disabled, returning unverified');
      return {
        verified: true,
        confidence: 1.0,
        citations: [],
        warnings: ['Verification service disabled'],
        modifiedResponse: null,
      };
    }

    try {
      const response = await fetch(`${this.config.serviceUrl}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: request.sessionId,
          response_text: request.responseText,
          claimed_sources: request.claimedSources || [],
          context: request.context,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Verification service error: ${error}`);
      }

      const result = await response.json() as {
        verified: boolean;
        confidence: number;
        citations: Array<{
          source: string;
          verified: boolean;
          snippet: string | null;
          type: string;
        }>;
        warnings: string[];
        modified_response: string | null;
      };

      logger.debug(
        { sessionId: request.sessionId, verified: result.verified, confidence: result.confidence },
        'Verification complete'
      );

      return {
        verified: result.verified,
        confidence: result.confidence,
        citations: result.citations,
        warnings: result.warnings,
        modifiedResponse: result.modified_response,
      };
    } catch (error) {
      logger.error({ error }, 'Verification request failed');

      // Return unverified with warning on error
      return {
        verified: false,
        confidence: 0,
        citations: [],
        warnings: ['Verification service unavailable'],
        modifiedResponse: null,
      };
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.serviceUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info({ enabled }, 'Verification service enabled state changed');
  }

  getMinConfidence(): number {
    return this.config.minConfidence;
  }
}
