import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index';

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
      model: 'tts-1-hd', // HD model for higher quality audio
      voice: 'nova', // Nova - warm female voice
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

    // Buffer size: ~200ms of audio at 24kHz 16-bit mono = 24000 * 2 * 0.2 = 9600 bytes
    // Larger chunks = smoother playback with less noise from chunk boundaries
    const MIN_CHUNK_SIZE = 9600;

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

      // Buffer to accumulate small chunks
      let buffer = Buffer.alloc(0);

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Send any remaining buffered data
          if (buffer.length > 0) {
            onChunk(buffer);
          }
          break;
        }

        // Accumulate data in buffer
        buffer = Buffer.concat([buffer, Buffer.from(value)]);

        // Send chunks when buffer is large enough
        while (buffer.length >= MIN_CHUNK_SIZE) {
          onChunk(buffer.subarray(0, MIN_CHUNK_SIZE));
          buffer = buffer.subarray(MIN_CHUNK_SIZE);
        }
      }

      logger.debug('Streaming synthesis complete');
    } catch (error) {
      logger.error({ error }, 'Streaming TTS failed');
      throw error;
    }
  }
}
