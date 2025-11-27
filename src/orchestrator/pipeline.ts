import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { PipelineEvent, SessionState } from '../shared/types/index.js';
import { createChildLogger } from '../shared/utils/index.js';
import { SessionManager } from './session-manager.js';

const logger = createChildLogger('pipeline');

export interface PipelineOptions {
  maxLatencyMs: number;
}

export class Pipeline extends EventEmitter {
  private sessionManager: SessionManager;
  private options: PipelineOptions;
  private processingTimers: Map<string, number> = new Map();

  constructor(sessionManager: SessionManager, options: PipelineOptions) {
    super();
    this.sessionManager = sessionManager;
    this.options = options;
  }

  async processAudioChunk(sessionId: string, audioData: Buffer): Promise<void> {
    const startTime = Date.now();
    this.processingTimers.set(sessionId, startTime);

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'No session found for audio processing');
      return;
    }

    if (session.state === 'interrupted') {
      logger.debug({ sessionId }, 'Skipping audio processing - session interrupted');
      return;
    }

    this.sessionManager.updateSessionState(sessionId, 'listening');

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: 'audio.chunk',
      timestamp: new Date(),
      payload: {
        data: audioData,
        sampleRate: 16000,
        channels: 1,
      },
    } as PipelineEvent);
  }

  async processTranscript(
    sessionId: string,
    text: string,
    isFinal: boolean
  ): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.state === 'interrupted') {
      return;
    }

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: isFinal ? 'transcript.final' : 'transcript.partial',
      timestamp: new Date(),
      payload: {
        text,
        isFinal,
      },
    } as PipelineEvent);

    if (isFinal) {
      this.sessionManager.updateSessionState(sessionId, 'processing');
      // Trigger LLM processing
      await this.processWithLLM(sessionId, text);
    }
  }

  private async processWithLLM(sessionId: string, text: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.state === 'interrupted') {
      return;
    }

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: 'llm.start',
      timestamp: new Date(),
      payload: {},
    } as PipelineEvent);

    // TODO: Integrate actual LLM service
    // This is a placeholder for the LLM integration

    logger.debug({ sessionId, text }, 'Processing with LLM');
  }

  interrupt(sessionId: string): void {
    const interrupted = this.sessionManager.interrupt(sessionId);
    if (interrupted) {
      this.emit('event', {
        id: uuidv4(),
        sessionId,
        type: 'session.interrupt',
        timestamp: new Date(),
        payload: {
          reason: 'user',
        },
      } as PipelineEvent);
    }
  }

  checkLatency(sessionId: string): number | null {
    const startTime = this.processingTimers.get(sessionId);
    if (!startTime) return null;

    const latency = Date.now() - startTime;
    if (latency > this.options.maxLatencyMs) {
      logger.warn(
        { sessionId, latency, maxLatency: this.options.maxLatencyMs },
        'Latency exceeded threshold'
      );
    }
    return latency;
  }
}
