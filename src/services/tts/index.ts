import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index.js';

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

  constructor(config: TTSConfig) {
    super();
    this.config = {
      model: 'tts-1',
      voice: 'alloy',
      speed: 1.0,
      ...config,
    };
  }

  async synthesize(text: string): Promise<SpeechResult> {
    const startTime = Date.now();
    logger.debug({ textLength: text.length }, 'Synthesizing speech');

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
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
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`TTS API error: ${error}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audio = Buffer.from(arrayBuffer);

      const duration = Date.now() - startTime;
      logger.debug({ duration }, 'Speech synthesis complete');

      return { audio, duration };
    } catch (error) {
      logger.error({ error }, 'TTS synthesis failed');
      throw error;
    }
  }

  async synthesizeStream(
    text: string,
    onChunk: (chunk: Buffer) => void
  ): Promise<void> {
    logger.debug({ textLength: text.length }, 'Starting streaming synthesis');

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
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
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`TTS API error: ${error}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(Buffer.from(value));
      }

      logger.debug('Streaming synthesis complete');
    } catch (error) {
      logger.error({ error }, 'Streaming TTS failed');
      throw error;
    }
  }
}
