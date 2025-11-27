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

    try {
      // Use MP3 format - cleaner audio without PCM artifacts
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
          response_format: 'mp3',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`TTS API error: ${error}`);
      }

      // For MP3, we collect all data and send as one chunk
      // This ensures clean audio without frame boundary issues
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      logger.debug({ audioSize: audioBuffer.length }, 'MP3 audio received');
      onChunk(audioBuffer);

      logger.debug('Streaming synthesis complete');
    } catch (error) {
      logger.error({ error }, 'Streaming TTS failed');
      throw error;
    }
  }
}
