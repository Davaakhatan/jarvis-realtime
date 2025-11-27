import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { PipelineEvent, Message } from '../shared/types/index';
import { createChildLogger } from '../shared/utils/index';
import { SessionManager } from './session-manager';
import { ASRService, TranscriptResult } from '../services/asr/index';
import { TTSService } from '../services/tts/index';
import { LLMService, ToolCall } from '../services/llm/index';
import { GitHubService, githubTools } from '../services/github-integration/index';
import { APIPoller, apiPollerTools } from '../services/api-poller/index';

const logger = createChildLogger('pipeline');

export interface PipelineOptions {
  maxLatencyMs: number;
  openaiApiKey: string;
  githubToken?: string;
}

export interface PipelineServices {
  asr: ASRService;
  tts: TTSService;
  llm: LLMService;
  github?: GitHubService;
  apiPoller: APIPoller;
}

export class Pipeline extends EventEmitter {
  private sessionManager: SessionManager;
  private options: PipelineOptions;
  private services: PipelineServices;
  private processingTimers: Map<string, number> = new Map();
  private conversationHistory: Map<string, Message[]> = new Map();

  constructor(
    sessionManager: SessionManager,
    options: PipelineOptions
  ) {
    super();
    this.sessionManager = sessionManager;
    this.options = options;

    // Initialize services
    this.services = this.initializeServices();
    this.setupServiceListeners();
  }

  private initializeServices(): PipelineServices {
    const asr = new ASRService({
      apiKey: this.options.openaiApiKey,
    });

    const tts = new TTSService({
      apiKey: this.options.openaiApiKey,
      voice: 'nova',
    });

    const llm = new LLMService({
      apiKey: this.options.openaiApiKey,
      model: 'gpt-4-turbo-preview',
    });

    // Register tools with LLM
    for (const tool of [...githubTools, ...apiPollerTools]) {
      llm.registerTool(tool);
    }

    const apiPoller = new APIPoller({
      defaultIntervalMs: 180000, // 3 minutes
    });

    let github: GitHubService | undefined;
    if (this.options.githubToken) {
      github = new GitHubService({
        token: this.options.githubToken,
      });
    }

    return { asr, tts, llm, github, apiPoller };
  }

  private setupServiceListeners(): void {
    this.services.asr.on('transcript', (result: TranscriptResult) => {
      // Handle transcription results
      logger.debug({ text: result.text }, 'Received transcript');
    });

    this.services.asr.on('error', (error: Error) => {
      logger.error({ error }, 'ASR error');
    });

    this.services.apiPoller.on('data', ({ endpointId }: { endpointId: string }) => {
      logger.debug({ endpointId }, 'API data refreshed');
    });
  }

  private isSessionInterrupted(sessionId: string): boolean {
    const session = this.sessionManager.getSession(sessionId);
    return !session || session.state === 'interrupted';
  }

  start(): void {
    this.services.apiPoller.startAllPolling();
    logger.info('Pipeline started');
  }

  stop(): void {
    this.services.apiPoller.stopAllPolling();
    logger.info('Pipeline stopped');
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

    // Push audio to ASR service
    this.services.asr.pushAudio(audioData);

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

    if (isFinal && text.trim()) {
      this.sessionManager.updateSessionState(sessionId, 'processing');
      await this.processWithLLM(sessionId, text);
    }
  }

  private async processWithLLM(sessionId: string, text: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.state === 'interrupted') {
      return;
    }

    // Get or create conversation history
    let history = this.conversationHistory.get(session.conversationId) || [];

    // Add user message
    const userMessage: Message = {
      id: uuidv4(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    history.push(userMessage);

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: 'llm.start',
      timestamp: new Date(),
      payload: {},
    } as PipelineEvent);

    try {
      // Build context from API data
      const apiContext = this.services.apiPoller.getAllData();

      // Get LLM response with streaming
      let fullResponse = '';

      for await (const chunk of this.services.llm.chatStream(history, { apiData: apiContext })) {
        if (this.isSessionInterrupted(sessionId)) {
          logger.debug({ sessionId }, 'LLM processing interrupted');
          break;
        }

        fullResponse += chunk;

        this.emit('event', {
          id: uuidv4(),
          sessionId,
          type: 'llm.chunk',
          timestamp: new Date(),
          payload: { text: chunk },
        } as PipelineEvent);
      }

      if (!this.isSessionInterrupted(sessionId) && fullResponse) {
        // Add assistant message to history
        const assistantMessage: Message = {
          id: uuidv4(),
          role: 'assistant',
          content: fullResponse,
          timestamp: new Date(),
        };
        history.push(assistantMessage);
        this.conversationHistory.set(session.conversationId, history);

        this.emit('event', {
          id: uuidv4(),
          sessionId,
          type: 'llm.end',
          timestamp: new Date(),
          payload: { text: fullResponse },
        } as PipelineEvent);

        // Synthesize speech
        await this.synthesizeResponse(sessionId, fullResponse);
      }
    } catch (error) {
      logger.error({ sessionId, error }, 'LLM processing failed');
      this.emit('event', {
        id: uuidv4(),
        sessionId,
        type: 'error',
        timestamp: new Date(),
        payload: {
          code: 'LLM_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          recoverable: true,
        },
      } as PipelineEvent);
    }
  }

  private async synthesizeResponse(sessionId: string, text: string): Promise<void> {
    if (this.isSessionInterrupted(sessionId)) {
      return;
    }

    this.sessionManager.updateSessionState(sessionId, 'speaking');

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: 'tts.start',
      timestamp: new Date(),
      payload: {},
    } as PipelineEvent);

    try {
      await this.services.tts.synthesizeStream(text, (chunk) => {
        if (this.isSessionInterrupted(sessionId)) {
          return;
        }

        this.emit('event', {
          id: uuidv4(),
          sessionId,
          type: 'tts.chunk',
          timestamp: new Date(),
          payload: { audio: chunk },
        } as PipelineEvent);
      });

      this.emit('event', {
        id: uuidv4(),
        sessionId,
        type: 'tts.end',
        timestamp: new Date(),
        payload: {},
      } as PipelineEvent);

      this.sessionManager.updateSessionState(sessionId, 'idle');
    } catch (error) {
      logger.error({ sessionId, error }, 'TTS synthesis failed');
      this.sessionManager.updateSessionState(sessionId, 'idle');
    }
  }

  async executeToolCall(sessionId: string, toolCall: ToolCall): Promise<unknown> {
    const { name, arguments: args } = toolCall;

    logger.debug({ sessionId, tool: name }, 'Executing tool call');

    switch (name) {
      case 'search_github_code':
        if (!this.services.github) {
          return { error: 'GitHub integration not configured' };
        }
        return this.services.github.searchCode(
          args.query as string,
          { repo: args.repo as string, language: args.language as string }
        );

      case 'get_github_file':
        if (!this.services.github) {
          return { error: 'GitHub integration not configured' };
        }
        return this.services.github.getFileContent(
          args.owner as string,
          args.repo as string,
          args.path as string
        );

      case 'search_github_issues':
        if (!this.services.github) {
          return { error: 'GitHub integration not configured' };
        }
        return this.services.github.searchIssues(
          args.query as string,
          { repo: args.repo as string, state: args.state as 'open' | 'closed' | 'all' }
        );

      case 'get_api_data':
        return this.services.apiPoller.getData(args.endpoint_id as string);

      case 'refresh_api_data':
        return this.services.apiPoller.forceRefresh(args.endpoint_id as string);

      case 'list_available_apis':
        return this.services.apiPoller.getAllData();

      default:
        return { error: `Unknown tool: ${name}` };
    }
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

  clearHistory(conversationId: string): void {
    this.conversationHistory.delete(conversationId);
    logger.debug({ conversationId }, 'Conversation history cleared');
  }
}
