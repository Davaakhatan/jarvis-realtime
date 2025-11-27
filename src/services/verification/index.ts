import { createChildLogger } from '../../shared/utils/index';
import { VerificationEngine, VerificationContext } from './engine';

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
  useBuiltInEngine: boolean;
  apiKey?: string;
  useLLMVerification: boolean;
}

export class VerificationClient {
  private config: VerificationConfig;
  private engine: VerificationEngine | null = null;

  constructor(config: Partial<VerificationConfig> = {}) {
    this.config = {
      serviceUrl: config.serviceUrl || 'http://localhost:8003',
      enabled: config.enabled ?? true,
      minConfidence: config.minConfidence ?? 0.6,
      useBuiltInEngine: config.useBuiltInEngine ?? true,
      apiKey: config.apiKey,
      useLLMVerification: config.useLLMVerification ?? false,
    };

    // Initialize built-in engine if API key is provided
    if (this.config.apiKey) {
      this.engine = new VerificationEngine(
        this.config.apiKey,
        this.config.minConfidence
      );
    }
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

    // Try built-in engine first if enabled
    if (this.config.useBuiltInEngine && this.engine) {
      return this.verifyWithBuiltInEngine(request);
    }

    // Fall back to external service
    return this.verifyWithExternalService(request);
  }

  private async verifyWithBuiltInEngine(
    request: VerificationRequest
  ): Promise<VerificationResult> {
    if (!this.engine) {
      logger.warn('Built-in engine not initialized, falling back to external service');
      return this.verifyWithExternalService(request);
    }

    try {
      // Convert context to verification context format
      const context: VerificationContext = {
        apiData: request.context?.apiData as Record<string, unknown> | undefined,
        githubData: request.context?.githubData as unknown[] | undefined,
        conversationHistory: request.context?.conversationHistory as
          | Array<{ role: string; content: string }>
          | undefined,
      };

      let result;
      if (this.config.useLLMVerification) {
        // Use LLM-based verification for higher accuracy
        result = await this.engine.verifyWithLLM(request.responseText, context);
      } else {
        // Use rule-based verification for lower latency
        result = await this.engine.verify(request.responseText, context);
      }

      logger.debug(
        {
          sessionId: request.sessionId,
          verified: result.verified,
          confidence: result.confidence,
          method: this.config.useLLMVerification ? 'llm' : 'rule-based',
        },
        'Built-in verification complete'
      );

      return {
        verified: result.verified,
        confidence: result.confidence,
        citations: result.citations,
        warnings: result.warnings,
        modifiedResponse: result.modifiedResponse,
      };
    } catch (error) {
      logger.error({ error }, 'Built-in verification failed, falling back to external');
      return this.verifyWithExternalService(request);
    }
  }

  private async verifyWithExternalService(
    request: VerificationRequest
  ): Promise<VerificationResult> {
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

      const result = (await response.json()) as {
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
        {
          sessionId: request.sessionId,
          verified: result.verified,
          confidence: result.confidence,
        },
        'External verification complete'
      );

      return {
        verified: result.verified,
        confidence: result.confidence,
        citations: result.citations,
        warnings: result.warnings,
        modifiedResponse: result.modified_response,
      };
    } catch (error) {
      logger.error({ error }, 'External verification request failed');

      // If built-in engine available, try that as last resort
      if (this.engine) {
        logger.info('Attempting built-in verification as fallback');
        return this.verifyWithBuiltInEngine(request);
      }

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
