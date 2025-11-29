import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index';
import {
  withRetry,
  RetryableError,
  withTimeout,
  RateLimiter,
  CircuitBreaker,
} from '../../shared/utils/retry';

const logger = createChildLogger('tts-service');

export interface TTSConfig {
  apiKey: string;
  model?: string;
  voice?: string;
  speed?: number;
}

export interface SpeechResult {
  audio: Buffer;
  duration?: number;
}

export class TTSService extends EventEmitter {
  private config: TTSConfig;
  private rateLimiter: RateLimiter;
  private circuitBreaker: CircuitBreaker;

  constructor(config: TTSConfig) {
    super();
    this.config = {
      model: 'tts-1', // Standard model for faster synthesis
      voice: 'nova', // Nova - warm female voice
      speed: 1.0,
      ...config,
    };

    // Rate limit: 50 requests per minute for TTS API
    this.rateLimiter = new RateLimiter(50, 60000, 10);

    // Circuit breaker: open after 5 failures, reset after 30 seconds
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30000,
    });
  }

  async synthesize(text: string): Promise<SpeechResult> {
    const startTime = Date.now();
    logger.debug({ textLength: text.length }, 'Synthesizing speech');

    try {
      // Apply rate limiting
      await this.rateLimiter.acquire();

      // Use circuit breaker and retry logic
      const audio = await this.circuitBreaker.execute(() =>
        withRetry(
          async () => {
            const response = await withTimeout(
              fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${this.config.apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: this.config.model,
                  input: text,
                  voice: this.config.voice,
                  speed: this.config.speed,
                  response_format: 'pcm',
                }),
              }),
              30000 // 30 second timeout
            );

            if (!response.ok) {
              const error = await response.text();
              // Retry on 5xx errors and rate limits
              if (response.status >= 500 || response.status === 429) {
                throw new RetryableError(`TTS API error: ${error}`);
              }
              throw new Error(`TTS API error: ${error}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
          },
          {
            maxAttempts: 3,
            initialDelayMs: 1000,
            maxDelayMs: 5000,
            retryableErrors: [RetryableError],
            onRetry: (error, attempt) => {
              logger.warn(
                { error: error.message, attempt },
                'Retrying TTS synthesis'
              );
            },
          }
        )
      );

      const duration = Date.now() - startTime;
      logger.debug({ duration }, 'Speech synthesis complete');

      return { audio, duration };
    } catch (error) {
      logger.error({ error }, 'TTS synthesis failed after retries');
      throw error;
    }
  }

  async synthesizeStream(
    text: string,
    onChunk: (chunk: Buffer) => void
  ): Promise<void> {
    logger.debug({ textLength: text.length }, 'Starting streaming synthesis');

    try {
      // Apply rate limiting
      await this.rateLimiter.acquire();

      // Use circuit breaker and retry logic
      await this.circuitBreaker.execute(() =>
        withRetry(
          async () => {
            // Use MP3 format - cleaner audio without PCM artifacts
            const response = await withTimeout(
              fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${this.config.apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: this.config.model,
                  input: text,
                  voice: this.config.voice,
                  speed: this.config.speed,
                  response_format: 'mp3',
                }),
              }),
              30000 // 30 second timeout
            );

            if (!response.ok) {
              const error = await response.text();
              // Retry on 5xx errors and rate limits
              if (response.status >= 500 || response.status === 429) {
                throw new RetryableError(`TTS API error: ${error}`);
              }
              throw new Error(`TTS API error: ${error}`);
            }

            // For MP3, we collect all data and send as one chunk
            // This ensures clean audio without frame boundary issues
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = Buffer.from(arrayBuffer);

            logger.debug({ audioSize: audioBuffer.length }, 'MP3 audio received');
            onChunk(audioBuffer);
          },
          {
            maxAttempts: 3,
            initialDelayMs: 1000,
            maxDelayMs: 5000,
            retryableErrors: [RetryableError],
            onRetry: (error, attempt) => {
              logger.warn(
                { error: error.message, attempt },
                'Retrying streaming TTS synthesis'
              );
            },
          }
        )
      );

      logger.debug('Streaming synthesis complete');
    } catch (error) {
      logger.error({ error }, 'Streaming TTS failed after retries');
      throw error;
    }
  }
}
