import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index';
import {
  withRetry,
  RetryableError,
  withTimeout,
  RateLimiter,
  CircuitBreaker,
} from '../../shared/utils/retry';

const logger = createChildLogger('asr-service');

export interface ASRConfig {
  apiKey: string;
  model?: string;
  language?: string;
  sampleRate?: number;
}

export interface TranscriptResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  timestamp: Date;
}

export class ASRService extends EventEmitter {
  private config: ASRConfig;
  private audioBuffer: Buffer[] = [];
  private isProcessing = false;
  private processingInterval: ReturnType<typeof setInterval> | null = null;
  private rateLimiter: RateLimiter;
  private circuitBreaker: CircuitBreaker;

  constructor(config: ASRConfig) {
    super();
    this.config = {
      model: 'whisper-1',
      language: 'en',
      sampleRate: 16000,
      ...config,
    };

    // Rate limit: 50 requests per minute for Whisper API
    this.rateLimiter = new RateLimiter(50, 60000, 10);

    // Circuit breaker: open after 5 failures, reset after 30 seconds
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30000,
    });
  }

  start(): void {
    logger.info('ASR service started');
    // Process accumulated audio every 500ms for near real-time transcription
    this.processingInterval = setInterval(() => {
      this.processAudioBuffer();
    }, 500);
  }

  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    // Process any remaining audio
    this.processAudioBuffer();
    logger.info('ASR service stopped');
  }

  pushAudio(chunk: Buffer): void {
    this.audioBuffer.push(chunk);
  }

  private async processAudioBuffer(): Promise<void> {
    if (this.isProcessing || this.audioBuffer.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      const audioData = Buffer.concat(this.audioBuffer);
      this.audioBuffer = [];

      // Skip if audio is too short (less than 0.5 seconds at 16kHz, 16-bit)
      if (audioData.length < 16000) {
        this.isProcessing = false;
        return;
      }

      const transcript = await this.transcribe(audioData);

      if (transcript && transcript.text.trim()) {
        this.emit('transcript', transcript);
      }
    } catch (error) {
      logger.error({ error }, 'Error processing audio');
      this.emit('error', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async transcribe(audioData: Buffer): Promise<TranscriptResult | null> {
    try {
      // Apply rate limiting
      await this.rateLimiter.acquire();

      // Use circuit breaker and retry logic
      return await this.circuitBreaker.execute(() =>
        withRetry(
          async () => {
            // Convert raw PCM to WAV format for Whisper API
            const wavBuffer = this.pcmToWav(audioData);

            const formData = new FormData();
            formData.append(
              'file',
              new Blob([wavBuffer], { type: 'audio/wav' }),
              'audio.wav'
            );
            formData.append('model', this.config.model!);
            formData.append('language', this.config.language!);
            formData.append('response_format', 'json');

            const response = await withTimeout(
              fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${this.config.apiKey}`,
                },
                body: formData,
              }),
              30000 // 30 second timeout
            );

            if (!response.ok) {
              const error = await response.text();
              // Retry on 5xx errors and rate limits
              if (response.status >= 500 || response.status === 429) {
                throw new RetryableError(`Whisper API error: ${error}`);
              }
              throw new Error(`Whisper API error: ${error}`);
            }

            const result = (await response.json()) as { text: string };

            return {
              text: result.text,
              isFinal: true,
              timestamp: new Date(),
            };
          },
          {
            maxAttempts: 3,
            initialDelayMs: 1000,
            maxDelayMs: 5000,
            retryableErrors: [RetryableError],
            onRetry: (error, attempt) => {
              logger.warn(
                { error: error.message, attempt },
                'Retrying transcription'
              );
            },
          }
        )
      );
    } catch (error) {
      logger.error({ error }, 'Transcription failed after retries');
      this.emit('error', error);
      return null;
    }
  }

  private pcmToWav(pcmData: Buffer): Buffer {
    const sampleRate = this.config.sampleRate!;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmData.length;
    const headerSize = 44;
    const fileSize = headerSize + dataSize - 8;

    const header = Buffer.alloc(headerSize);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // audio format (PCM)
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }
}
